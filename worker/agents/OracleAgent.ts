/**
 * OracleAgent — Flow B dispatcher for multi-model Oracle Q&A.
 *
 * A Cloudflare Durable Object that handles the "Flow B" pathway:
 * Farcaster casts mentioning @qlaude/@chatqpt/@qemini get routed here.
 *
 * Pipeline (Flow B, per docs/specs/multi-model-oracle.md §2.2):
 * 1. Detect @mentions → extract question text
 * 2. Dedup via oracle_ledger
 * 3. Create Qbase question (queries row) + question_meta
 * 4. Post question snap reply (invites human answers)
 * 5. Deduct $QQ from oracle balance
 * 6. Call model API
 * 7. Post threaded model answer (1/N … N/N, 320-char limit)
 * 8. Create answer row with answer_source = 'oracle_*'
 *
 * For the MVP, all casts use @qbase's Neymar signer (QGENT_SIGNER_UUID).
 * Model-specific bot accounts (@qlaude etc.) require separate signer keys
 * and are a v1.1 enhancement.
 */

import { DurableObject } from "cloudflare:workers";

// ============================================================================
// Types
// ============================================================================

export interface OracleEnv {
  DB: D1Database;
  QGENT_SIGNER_UUID: string;
  QGENT_NEYNAR_API_KEY: string;
  ANTHROPIC_API_KEY?: string;   // qlaude (direct Anthropic)
  OPENROUTER_API_KEY?: string;  // chatqpt + qemini (via OpenRouter, OpenAI-compatible)
  QBASE_EMBED_HOST?: string;
  // Per-model signers — each oracle bot posts as itself.
  QLAUDE_SIGNER_UUID?: string;
  QEMINI_SIGNER_UUID?: string;
  CHATQPT_SIGNER_UUID?: string;
}

export interface OracleDispatchRequest {
  question: string;          // Extracted question text (everything before @mentions)
  models: string[];          // ['qlaude'], ['qlaude', 'chatqpt'], etc.
  askerFid: number;
  askerUsername: string;
  parentHash: string;        // Original cast hash
  castText: string;          // Full original cast text
}

// ============================================================================
// Constants
// ============================================================================

const MAX_CAST_LENGTH = 320;

const ORACLE_HANDLES = ['qlaude', 'chatqpt', 'qemini'];

// ============================================================================
// Model Configurations
// ============================================================================

interface ModelConfig {
  handle: string;              // 'qlaude'
  envKey: string;              // Env var name for the API key
  signerEnvKey: string;        // Env var name for this bot's Neynar signer UUID
  apiUrl: string;              // API endpoint
  modelName: string;           // Model identifier string for attribution
  modelId: string;             // API model ID
  systemPrompt: string;
  /** Extract text from the provider's response JSON */
  parseResponse: (data: any) => string;
  /** Extract token usage from the provider's response JSON */
  parseTokens: (data: any) => { input: number; output: number };
}

const ORACLE_SYSTEM_PROMPT = (handle: string) =>
  `You are ${handle}, an AI oracle on Qbase — a Q&A platform built on Farcaster. `
  + 'A user has asked you a question. Answer concisely and substantively in a few sentences. '
  + 'If the question is unanswerable or unsafe, say so clearly rather than fabricating. '
  + 'Your answer will be attributed to you as a model and compared with human consensus and other AI models.';

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  qlaude: {
    handle: 'qlaude',
    envKey: 'ANTHROPIC_API_KEY',
    signerEnvKey: 'QLAUDE_SIGNER_UUID',
    apiUrl: 'https://api.anthropic.com/v1/messages',
    modelName: 'Claude Sonnet 4',
    modelId: 'claude-sonnet-4-20250514',
    systemPrompt: ORACLE_SYSTEM_PROMPT('qlaude'),
    parseResponse: (data) => data.content?.[0]?.text?.trim() || '',
    parseTokens: (data) => ({
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    }),
  },
  // chatqpt + qemini run through OpenRouter (OpenAI-compatible API, one key for both).
  chatqpt: {
    handle: 'chatqpt',
    envKey: 'OPENROUTER_API_KEY',
    signerEnvKey: 'CHATQPT_SIGNER_UUID',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelName: 'GPT-4o',
    modelId: 'openai/gpt-4o',
    systemPrompt: ORACLE_SYSTEM_PROMPT('chatqpt'),
    parseResponse: (data) => data.choices?.[0]?.message?.content?.trim() || '',
    parseTokens: (data) => ({
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    }),
  },
  qemini: {
    handle: 'qemini',
    envKey: 'OPENROUTER_API_KEY',
    signerEnvKey: 'QEMINI_SIGNER_UUID',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelName: 'Gemini 2.5 Flash',
    modelId: 'google/gemini-2.5-flash',
    systemPrompt: ORACLE_SYSTEM_PROMPT('qemini'),
    parseResponse: (data) => data.choices?.[0]?.message?.content?.trim() || '',
    parseTokens: (data) => ({
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    }),
  },
};

// ============================================================================
// Durable Object
// ============================================================================

export class OracleAgent extends DurableObject<OracleEnv> {
  // ==========================================================================
  // HTTP Handler
  // ==========================================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /dispatch — Main entry point from webhook
    if (request.method === 'POST' && path === '/dispatch') {
      try {
        const body = (await request.json()) as OracleDispatchRequest;
        const result = await this.dispatch(body);
        return Response.json(result);
      } catch (error: any) {
        console.error('[OracleAgent] dispatch error:', error);
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    // GET /status — Health check
    if (request.method === 'GET' && path === '/status') {
      return Response.json({
        ok: true,
        models: Object.keys(MODEL_CONFIGS),
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  // ==========================================================================
  // Main Dispatch
  // ==========================================================================

  async dispatch(req: OracleDispatchRequest): Promise<{
    processed: boolean;
    questionId?: string;
    answerHashes?: Array<{ model: string; hash: string; error?: string }>;
    error?: string;
  }> {
    const { question, models, askerFid, askerUsername, parentHash, castText } = req;

    // ── 1. Dedup — check oracle_ledger ────────────────────────────────
    const existing = (await this.env.DB.prepare(
      'SELECT id, question_id FROM oracle_ledger WHERE cast_hash = ? LIMIT 1',
    ).bind(parentHash).first()) as { id: string; question_id: string | null } | null;

    if (existing) {
      console.log(`[OracleAgent] Dedup hit for ${parentHash}, skipping`);
      return { processed: false, error: 'already_processed' };
    }

    // The council answers an EXISTING question (the parent cast). It does NOT
    // create a Qbase question or post a snap — it records the summon in
    // oracle_ledger (dedup + audit) and posts each model's reply to the cast.
    const now = Date.now();
    const sanitizedQuestion = question.trim().substring(0, 500);

    const ledgerId = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO oracle_ledger
       (id, cast_hash, author_fid, author_username, cast_text, mentioned_providers,
        responses, question_id, question_created, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', NULL, 0, ?)`,
    )
      .bind(
        ledgerId,
        parentHash,
        askerFid,
        askerUsername || '',
        castText,
        JSON.stringify(models),
        now,
      )
      .run();

    // Call models and post each reply to the original question cast.
    const answerHashes: Array<{ model: string; hash: string; error?: string }> = [];

    for (const modelHandle of models) {
      const config = MODEL_CONFIGS[modelHandle];
      if (!config) {
        console.warn(`[OracleAgent] Unsupported model: ${modelHandle}`);
        answerHashes.push({ model: modelHandle, hash: '', error: `unsupported model: ${modelHandle}` });
        continue;
      }

      // Check API key is configured
      if (!(this.env as any)[config.envKey]) {
        const msg = `${modelHandle} API key not configured`;
        console.error(`[OracleAgent] ${msg}`);
        answerHashes.push({ model: modelHandle, hash: '', error: msg });
        continue;
      }

      try {
        // Call model API
        const modelResult = await this.callModel(sanitizedQuestion, config);
        const answerText = modelResult.text || '(no response)';

        // Post threaded reply chain to the original question cast (as this bot).
        const replyHashes = await this.postThreadedReply(answerText, parentHash, config);
        const lastHash = replyHashes[replyHashes.length - 1] || '';

        // Update ledger with this model's response
        const responseEntry = {
          text: answerText.substring(0, 200),
          model: config.modelName,
          model_id: config.modelId,
          tokens: modelResult.tokens,
          latency_ms: modelResult.latencyMs,
          reply_hashes: replyHashes,
        };

        const currentLedger = (await this.env.DB.prepare(
          'SELECT responses FROM oracle_ledger WHERE id = ?',
        ).bind(ledgerId).first()) as { responses: string } | null;

        const existingResponses = currentLedger ? JSON.parse(currentLedger.responses) : {};
        existingResponses[modelHandle] = responseEntry;

        await this.env.DB.prepare('UPDATE oracle_ledger SET responses = ? WHERE id = ?')
          .bind(JSON.stringify(existingResponses), ledgerId)
          .run();

        answerHashes.push({ model: modelHandle, hash: lastHash });
        console.log(`[OracleAgent] ${modelHandle} answered: ${lastHash} (${replyHashes.length} parts)`);
      } catch (error: any) {
        console.error(`[OracleAgent] ${modelHandle} failed:`, error);

        // Post error reply
        try {
          const errorText = `${config.handle} couldn't answer right now. try again or ask on qbase.tech`;
          const errHash = await this.postCastToNeynar(
            errorText.substring(0, MAX_CAST_LENGTH),
            parentHash,
            undefined,
            (this.env as any)[config.signerEnvKey] || this.env.QGENT_SIGNER_UUID,
          );
          answerHashes.push({ model: modelHandle, hash: errHash, error: error.message });
        } catch {
          answerHashes.push({ model: modelHandle, hash: '', error: error.message });
        }
      }
    }

    return { processed: true, answerHashes };
  }

  // ==========================================================================
  // Model API Calls
  // ==========================================================================

  private async callModel(
    question: string,
    config: ModelConfig,
  ): Promise<{ text: string; tokens: number; latencyMs: number }> {
    const start = Date.now();
    const apiKey = (this.env as any)[config.envKey] as string;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const url = config.apiUrl;
    let body: Record<string, unknown>;

    if (config.handle === 'qlaude') {
      // Anthropic Messages API — key in x-api-key, system prompt is a top-level field.
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: config.modelId,
        max_tokens: 1024,
        system: config.systemPrompt,
        messages: [{ role: 'user', content: question }],
      };
    } else {
      // OpenAI-compatible chat completions (chatqpt + qemini via OpenRouter) —
      // Bearer auth, system prompt as the first message.
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['HTTP-Referer'] = 'https://qbase.tech';
      headers['X-Title'] = 'Qbase Oracle';
      body = {
        model: config.modelId,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: config.systemPrompt },
          { role: 'user', content: question },
        ],
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    const text = config.parseResponse(data);
    if (!text) throw new Error('Empty response from model');

    const tokenInfo = config.parseTokens(data);

    return {
      text,
      tokens: tokenInfo.input + tokenInfo.output,
      latencyMs: Date.now() - start,
    };
  }

  // ==========================================================================
  // Farcaster Casting
  // ==========================================================================

  /**
   * Post a threaded model answer.
   * Splits text into 320-char chunks and posts them as a threaded chain:
   *   Reply 1/3: <chunk 1> (continued…)
   *   Reply 2/3: <chunk 2> (continued…)
   *   Reply 3/3: <chunk 3>
   *              — qlaude · Claude Sonnet 4 · qbase.tech/q/<id>
   */
  private async postThreadedReply(
    fullText: string,
    parentHash: string,
    config: ModelConfig,
  ): Promise<string[]> {
    const hashes: string[] = [];
    // Each bot replies as itself (its own approved signer); fall back to Q's signer.
    const signerUuid = (this.env as any)[config.signerEnvKey] || this.env.QGENT_SIGNER_UUID;

    // If answer fits in one cast with signature, do that
    const singleLine = `${fullText}\n\n— ${config.handle} · ${config.modelName}`;
    if (singleLine.length <= MAX_CAST_LENGTH) {
      const hash = await this.postCastToNeynar(singleLine, parentHash, undefined, signerUuid);
      return [hash];
    }

    // Multi-chunk threading
    // Reserve chars for suffix: " (continued…)" = 14, or full signature = ~50
    const CONTINUED_SUFFIX = ' (continued…)';
    const LAST_SUFFIX = `\n\n— ${config.handle} · ${config.modelName}`;
    const CHUNK_OVERHEAD = 14; // " (1/3)" style for middle chunks
    const chunkSize = MAX_CAST_LENGTH - CHUNK_OVERHEAD - 2;

    // Estimate chunks needed
    const estimatedChunks = Math.max(1, Math.ceil(fullText.length / chunkSize));

    // If it's only 2 chunks, use simpler overhead
    const actualOverhead = estimatedChunks > 2 ? CONTINUED_SUFFIX.length : 7; // "(2/2)" is short

    const textChunkSize = MAX_CAST_LENGTH - actualOverhead - 2;

    let pos = 0;
    let currentParent = parentHash;
    let chunkIndex = 0;

    while (pos < fullText.length) {
      const isLast = pos + textChunkSize >= fullText.length;
      let chunk: string;
      let suffix: string;

      if (isLast) {
        // Last chunk — fit what's left
        const remainder = fullText.substring(pos);
        const lastSuffixLen = LAST_SUFFIX.length;

        if (remainder.length + lastSuffixLen <= MAX_CAST_LENGTH) {
          chunk = remainder;
          suffix = LAST_SUFFIX;
        } else {
          // Still too long — split last chunk too
          const midChunkSize = MAX_CAST_LENGTH - CONTINUED_SUFFIX.length - 2;
          chunk = fullText.substring(pos, pos + midChunkSize).trim();
          suffix = CONTINUED_SUFFIX;
          // The remainder will be handled by the next (final) iteration
          pos = pos + midChunkSize;
          // Continue to let the loop handle the actual last piece
        }
      } else {
        // Middle chunk
        const rawChunk = fullText.substring(pos, pos + textChunkSize);
        // Try not to break mid-word if possible
        const lastSpace = rawChunk.lastIndexOf(' ');
        if (lastSpace > textChunkSize * 0.3) {
          chunk = rawChunk.substring(0, lastSpace).trim();
          pos = pos + lastSpace; // advance past the space
        } else {
          chunk = rawChunk.trim();
          pos = pos + textChunkSize;
        }
        suffix = CONTINUED_SUFFIX;
      }

      // If we didn't advance pos for the last-chunk-split case, advance to end
      // (meaning: if we're on the last iteration and didn't split further)
      if (isLast && !(pos + textChunkSize < fullText.length)) {
        pos = fullText.length;
      }

      const castText = chunk + suffix;

      try {
        const hash = await this.postCastToNeynar(
          castText.substring(0, MAX_CAST_LENGTH),
          currentParent,
          undefined,
          signerUuid,
        );
        hashes.push(hash);
        currentParent = hash; // Chain: each reply is a child of the previous
        chunkIndex++;
      } catch (error) {
        console.error(`[OracleAgent] Thread reply ${chunkIndex} failed:`, error);
        throw error;
      }

      // Safety: prevent infinite loop
      if (chunkIndex > 20) {
        console.error('[OracleAgent] Too many thread chunks, aborting');
        break;
      }
    }

    return hashes;
  }

  /**
   * Post a cast to Farcaster via Neynar API.
   * Uses Q's signer UUID for MVP.
   */
  private async postCastToNeynar(
    text: string,
    parentHash: string | null,
    embeds?: string[],
    signerUuid?: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      signer_uuid: signerUuid ?? this.env.QGENT_SIGNER_UUID,
      text: text.substring(0, MAX_CAST_LENGTH),
    };

    if (parentHash) {
      body.parent = parentHash;
    }

    if (embeds && embeds.length > 0) {
      body.embeds = embeds.map((url) => ({ url }));
    }

    const response = await fetch('https://api.neynar.com/v2/farcaster/cast', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.env.QGENT_NEYNAR_API_KEY,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Neynar ${response.status}: ${errText.substring(0, 200)}`);
    }

    const data = (await response.json()) as { cast?: { hash?: string } };
    return data.cast?.hash || '';
  }

}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract question text from a cast that contains oracle @mentions.
 * Everything before the first oracle mention is the question.
 * Returns the cleaned question string, or null if nothing useful.
 */
export function extractOracleQuestion(castText: string): string | null {
  if (!castText) return null;

  let cleaned = castText.trim();

  // Find the first oracle mention (case-insensitive)
  const mentionRegex = new RegExp(
    `\\B@(${ORACLE_HANDLES.join('|')})\\b`,
    'gi',
  );
  const match = mentionRegex.exec(castText);
  if (match && match.index > 0) {
    cleaned = castText.substring(0, match.index).trim();
  } else if (match && match.index === 0) {
    // Cast starts with @mention — no question text
    return null;
  }
  // If no oracle mention found (shouldn't happen if we're called correctly)

  // Remove stray @mentions to other handles
  cleaned = cleaned.replace(/@\w+/g, '').trim();

  // Strip leading punctuation that might remain after removal
  cleaned = cleaned.replace(/^[,.\s!?]+/, '').trim();

  // Minimum viable question length
  if (cleaned.length < 2) return null;

  return cleaned;
}

/**
 * Check if a cast text mentions any oracle model handles.
 * Returns the list of matched handles.
 */
export function extractOracleMentions(castText: string): string[] {
  if (!castText) return [];
  const mentions: string[] = [];
  for (const handle of ORACLE_HANDLES) {
    const regex = new RegExp(`\\B@${handle}\\b`, 'i');
    if (regex.test(castText)) {
      mentions.push(handle);
    }
  }
  return mentions;
}

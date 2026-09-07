/**
 * OracleAgent — the council: one question, several models, each answering as
 * its own Farcaster account.
 *
 * A Cloudflare Durable Object. Summoned either by a "@qgent council" reply on
 * Farcaster (`routes/webhooks.ts`) or from the web (`services/CouncilService`);
 * both go through `POST /dispatch`.
 *
 * Pipeline:
 * 1. Dedup via oracle_ledger (keyed by `ledgerKey`, default the parent cast hash)
 * 2. Call each model's API
 * 3. When the question has a cast, post the answer as a threaded reply chain
 *    (≤320 bytes per cast) signed by that model's own Ed25519 hub signer
 *    (`QLAUDE_SIGNER_KEY` / `QEMINI_SIGNER_KEY` / `CHATQPT_SIGNER_KEY`, FIDs in
 *    `*_FID`); Q's signer is the fallback while a model's key is unregistered
 * 4. Return every model's full text + cast hashes so the caller can persist
 *    them (`council_responses`)
 *
 * Track C card C5: no Neynar on this path.
 */

import { DurableObject } from "cloudflare:workers";
import { createHypersnapService, type HypersnapService } from "../services/HypersnapService";

// ============================================================================
// Types
// ============================================================================

export interface OracleEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;   // qlaude (direct Anthropic)
  OPENROUTER_API_KEY?: string;  // chatqpt + qemini (via OpenRouter, OpenAI-compatible)
  QBASE_EMBED_HOST?: string;
  HYPERSNAP_ENDPOINT?: string;
  HUB_ENDPOINT?: string;
  // Q — fallback signer while a council model's own key is not registered.
  QGENT_FID?: string;
  QGENT_SIGNER_KEY?: string;
  // Per-model hub signers — each oracle bot posts as itself.
  QLAUDE_FID?: string;
  QEMINI_FID?: string;
  CHATQPT_FID?: string;
  QLAUDE_SIGNER_KEY?: string;
  QEMINI_SIGNER_KEY?: string;
  CHATQPT_SIGNER_KEY?: string;
}

export interface OracleDispatchRequest {
  question: string;          // The question stem / parent cast text
  models: string[];          // ['qlaude'], ['qlaude', 'chatqpt'], etc.
  askerFid: number;
  askerUsername: string;
  /** Cast the models reply to. Omit for a web-only question: answers are returned, nothing is cast. */
  parentHash?: string;
  /** Author of `parentHash`; required with it (the hub addresses casts by fid + hash). */
  parentAuthorFid?: number;
  castText: string;          // Full original cast text (or the stem again)
  /** oracle_ledger dedup key; defaults to parentHash. Required when there is no cast. */
  ledgerKey?: string;
}

export interface OracleModelResponse {
  model: string;             // handle: qlaude | qemini | chatqpt
  text: string;              // full answer text ('' on failure)
  hash: string;              // last cast of the reply chain ('' when nothing was cast)
  hashes: string[];          // every cast in the chain, in order
  modelId?: string;
  tokens?: number;
  latencyMs?: number;
  error?: string;
}

export interface OracleDispatchResult {
  processed: boolean;
  responses: OracleModelResponse[];
  /** Back-compat alias of `responses` (model + last hash). */
  answerHashes: Array<{ model: string; hash: string; error?: string }>;
  error?: string;
}

interface HubSigner {
  signerKey: string;
  fid: number;
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
  signerEnvKey: string;        // Env var name for this bot's Ed25519 hub signer key
  fidEnvKey: string;           // Env var name for this bot's FID
  defaultFid: number;          // FID on the network as of 2026-09-07 (Haatz by_username)
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
    signerEnvKey: 'QLAUDE_SIGNER_KEY',
    fidEnvKey: 'QLAUDE_FID',
    defaultFid: 1729350,
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
    signerEnvKey: 'CHATQPT_SIGNER_KEY',
    fidEnvKey: 'CHATQPT_FID',
    defaultFid: 1729438,
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
    signerEnvKey: 'QEMINI_SIGNER_KEY',
    fidEnvKey: 'QEMINI_FID',
    defaultFid: 1729476,
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

  async dispatch(req: OracleDispatchRequest): Promise<OracleDispatchResult> {
    const { question, models, askerFid, askerUsername, parentHash, parentAuthorFid, castText } = req;

    const ledgerKey = req.ledgerKey ?? parentHash;
    if (!ledgerKey) {
      return { processed: false, responses: [], answerHashes: [], error: 'ledgerKey or parentHash required' };
    }
    if (parentHash && !parentAuthorFid) {
      return { processed: false, responses: [], answerHashes: [], error: 'parentAuthorFid required with parentHash' };
    }

    // ── 1. Dedup — check oracle_ledger ────────────────────────────────
    const existing = (await this.env.DB.prepare(
      'SELECT id, question_id FROM oracle_ledger WHERE cast_hash = ? LIMIT 1',
    ).bind(ledgerKey).first()) as { id: string; question_id: string | null } | null;

    if (existing) {
      console.log(`[OracleAgent] Dedup hit for ${ledgerKey}, skipping`);
      return { processed: false, responses: [], answerHashes: [], error: 'already_processed' };
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
        ledgerKey,
        askerFid,
        askerUsername || '',
        castText,
        JSON.stringify(models),
        now,
      )
      .run();

    // Call models; when the question has a cast, post each reply to it as that bot.
    const responses: OracleModelResponse[] = [];
    const hub = parentHash ? createHypersnapService(this.env) : null;

    for (const modelHandle of models) {
      const config = MODEL_CONFIGS[modelHandle];
      if (!config) {
        console.warn(`[OracleAgent] Unsupported model: ${modelHandle}`);
        responses.push({ model: modelHandle, text: '', hash: '', hashes: [], error: `unsupported model: ${modelHandle}` });
        continue;
      }

      // Check API key is configured
      if (!(this.env as any)[config.envKey]) {
        const msg = `${modelHandle} API key not configured`;
        console.error(`[OracleAgent] ${msg}`);
        responses.push({ model: modelHandle, text: '', hash: '', hashes: [], error: msg });
        continue;
      }

      try {
        // Call model API
        const modelResult = await this.callModel(sanitizedQuestion, config);
        const answerText = modelResult.text || '(no response)';

        // Post threaded reply chain to the original question cast (as this bot).
        const replyHashes = hub && parentHash && parentAuthorFid
          ? await this.postThreadedReply(hub, answerText, parentHash, parentAuthorFid, config)
          : [];
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

        responses.push({
          model: modelHandle,
          text: answerText,
          hash: lastHash,
          hashes: replyHashes,
          modelId: config.modelId,
          tokens: modelResult.tokens,
          latencyMs: modelResult.latencyMs,
        });
        console.log(`[OracleAgent] ${modelHandle} answered: ${lastHash || '(web only)'} (${replyHashes.length} parts)`);
      } catch (error: any) {
        console.error(`[OracleAgent] ${modelHandle} failed:`, error);

        // Post error reply when there is a cast to reply to.
        let errHash = '';
        if (hub && parentHash && parentAuthorFid) {
          try {
            const errorText = `${config.handle} couldn't answer right now. try again or ask on qbase.tech`;
            errHash = await this.postCast(hub, errorText, parentHash, parentAuthorFid, this.resolveSigner(config));
          } catch (castErr) {
            console.error(`[OracleAgent] ${modelHandle} error reply failed:`, castErr);
          }
        }
        responses.push({ model: modelHandle, text: '', hash: errHash, hashes: errHash ? [errHash] : [], error: error.message });
      }
    }

    return {
      processed: true,
      responses,
      answerHashes: responses.map(r => ({ model: r.model, hash: r.hash, ...(r.error ? { error: r.error } : {}) })),
    };
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
        max_tokens: 250,
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
        max_tokens: 250,
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
  // Farcaster Casting — hub protocol, one Ed25519 signer per council account
  // ==========================================================================

  /**
   * The signer a model casts with: its own registered key, else Q's key (so the
   * council keeps working while an operator registers the model's key on-chain;
   * the reply is then attributed to Q, which the log calls out).
   */
  private resolveSigner(config: ModelConfig): HubSigner {
    const env = this.env as any;
    const ownKey = env[config.signerEnvKey] as string | undefined;
    if (ownKey) {
      return { signerKey: ownKey, fid: Number(env[config.fidEnvKey]) || config.defaultFid };
    }
    if (this.env.QGENT_SIGNER_KEY) {
      console.warn(`[OracleAgent] ${config.signerEnvKey} not set — ${config.handle} replies will be cast by Q`);
      return { signerKey: this.env.QGENT_SIGNER_KEY, fid: Number(this.env.QGENT_FID) || 975961 };
    }
    throw new Error(`No hub signer for ${config.handle}: set ${config.signerEnvKey} (or QGENT_SIGNER_KEY as fallback)`);
  }

  /**
   * Post a model answer as a chain of replies to the question cast.
   * Splits on word boundaries into <=MAX_CAST_LENGTH-byte chunks and threads them.
   * No signature/suffix — the bot's own account is the attribution.
   */
  private async postThreadedReply(
    hub: HypersnapService,
    fullText: string,
    parentHash: string,
    parentAuthorFid: number,
    config: ModelConfig,
  ): Promise<string[]> {
    const signer = this.resolveSigner(config);

    const chunks = splitForCasts(fullText.trim(), MAX_CAST_LENGTH);
    const hashes: string[] = [];
    let parent = { hash: parentHash, fid: parentAuthorFid };
    for (const chunk of chunks) {
      const hash = await this.postCast(hub, chunk, parent.hash, parent.fid, signer);
      hashes.push(hash);
      parent = { hash, fid: signer.fid }; // chain each reply under the previous
    }
    return hashes;
  }

  /** One signed CastAdd reply, submitted to the hub. */
  private async postCast(
    hub: HypersnapService,
    text: string,
    parentHash: string,
    parentAuthorFid: number,
    signer: HubSigner,
  ): Promise<string> {
    const result = await hub.publishCast({
      signerKey: signer.signerKey,
      fid: signer.fid,
      text: text.substring(0, MAX_CAST_LENGTH),
      parentHash,
      parentAuthorFid,
    });
    return result.hash;
  }

}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Split text into chunks that each fit within `maxBytes` (Farcaster's cast limit
 * is measured in UTF-8 bytes). Breaks on word boundaries; hard-splits any single
 * word longer than the limit. Capped at 12 chunks as a runaway guard.
 */
function splitForCasts(text: string, maxBytes: number): string[] {
  const enc = new TextEncoder();
  const byteLen = (s: string) => enc.encode(s).length;
  const chunks: string[] = [];
  let cur = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (byteLen(candidate) <= maxBytes) {
      cur = candidate;
      continue;
    }
    if (cur) { chunks.push(cur); cur = ''; }
    if (byteLen(word) <= maxBytes) {
      cur = word;
    } else {
      // Single token longer than one cast — hard-split it by characters.
      let w = word;
      while (byteLen(w) > maxBytes) {
        let i = maxBytes;
        while (i > 1 && byteLen(w.slice(0, i)) > maxBytes) i--;
        chunks.push(w.slice(0, i));
        w = w.slice(i);
      }
      cur = w;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.slice(0, 12);
}

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

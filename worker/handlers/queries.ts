import { QueryType } from '../../src/lib/types';
import type { QuerySubmission } from '../../src/lib/types';
import { VectorService } from '../services/VectorService';
import { AIService } from '../services/AIService';
import { AnonAttributionService } from '../services/AnonAttributionService';
import { PointsService } from '../services/PointsService';
import { UserService } from '../services/UserService';
import { TopicService } from '../services/TopicService';
import { generateCompactToken } from '../services/SnapService';
import { openWave, resolveGate, validateCloseTime, validateGateSubmission, type ResolvedGate } from '../services/WaveService';
import { buildOptionsConfig, listVisibleOptions, parseOptionsConfig } from '../services/PollOptionsService';
import { getOpenPoll, getPoll, setPollCastHash, toPublicPoll } from '../services/PollService';
import { anon_id, anon_fid, MAX_Q_LENGTH, MAX_CAST_LENGTH_PRO } from '../../src/lib/consts';
import { formatCastText } from '../services/farcasterShared';
import { initFarcasterData } from '../services/farcaster';
import { isRewritten, lookupUserKeyForFid, userKeyForFid } from '../services/accounts/AccountService';

/** QP charged to create a plain question. Server-side only; see the deduction block. */
const QUESTION_CREATE_COST_QP = 0;


// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

// Cloudflare Workers ExecutionContext for background tasks
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Helper function to post to Farcaster in background (non-blocking)
// Returns castWarning if options were omitted due to length limits
async function postQueryToFarcaster(
  env: Env,
  queryId: string,
  stem: string,
  type: QueryType,
  options: string[] | undefined,
  isAnonymous: boolean,
  realCoinerFid: number | undefined,
  _channelId?: string,  // kept for backward compat; unused since Neynar removal
  includeEmbed?: boolean,
  pollId?: string | null,
): Promise<{ castWarning?: string }> {
  console.log(`[Farcaster Cast] Starting cast for query ${queryId}`);
  // A question that opened a wave embeds the wave's own snap URL so every
  // in-feed answer is attributed to it; the compact HMAC is scoped the same way.
  const snapPath = pollId ? `/snap/poll/${pollId}` : `/snap/question/${queryId}`;
  const snapSubject = pollId ? `poll:${pollId}` : queryId;
  console.log(`[Farcaster Cast] isAnonymous: ${isAnonymous}`);

  let castWarning: string | undefined;

  try {
    // Determine the actual cast text based on length limits and pro status
    // For MC with snap embed: skip options in cast text (they're in the snap)
    const hasEmbed = includeEmbed !== false;
    const formattedCastText = (type === 'mc' && hasEmbed)
      ? stem
      : formatCastText(stem, type, options);
    let actualCastText = formattedCastText;

    if (formattedCastText.length > MAX_Q_LENGTH) {
      // Check if caster has Pro subscription (from cached D1 value)
      const casterFid = isAnonymous ? anon_fid : realCoinerFid;
      let hasPro = false;

      if (casterFid) {
        // Users is keyed by the person key; the caster is addressed by fid.
        const casterKey = await lookupUserKeyForFid(env, casterFid);
        const casterUser = casterKey === undefined ? null : await UserService.getByFid(env, casterKey);
        hasPro = casterUser?.pro_status === 'subscribed';
        console.log(`[Farcaster Cast] Caster FID ${casterFid} pro_status: ${casterUser?.pro_status || 'none'}`);
      }

      if (hasPro) {
        // Pro user - can cast full text (up to MAX_CAST_LENGTH_PRO)
        if (formattedCastText.length > MAX_CAST_LENGTH_PRO) {
          actualCastText = formattedCastText.substring(0, MAX_CAST_LENGTH_PRO);
          console.log(`[Farcaster Cast] Pro user, but text exceeds Pro limit. Truncating to ${MAX_CAST_LENGTH_PRO} chars.`);
        } else {
          console.log(`[Farcaster Cast] Pro user - casting full text (${formattedCastText.length} chars)`);
        }
      } else {
        // Not Pro - cast stem only
        actualCastText = stem;
        castWarning = 'Question cast without options (Farcaster Pro required for longer casts)';
        console.log(`[Farcaster Cast] Non-Pro user - casting stem only (${stem.length} chars). Options omitted.`);
      }
    }

    if (isAnonymous) {
      // Cast from anon bot via Hypersnap hub protocol (no Neynar dependency)
      console.log(`[Farcaster Cast] Attempting anonymous cast with Hypersnap`);

      const anonSignerKey: string | undefined = env.ANON_SIGNER_KEY;
      const anonFid: number = Number(env.ANON_FID) || 514282;

      if (!anonSignerKey) {
        console.warn(`[Farcaster Cast] ANON_SIGNER_KEY not configured, skipping anonymous cast`);
      } else {
        const { createHypersnapService } = await import('../services/HypersnapService');
        const hypersnap = createHypersnapService(env);

        console.log(`[Farcaster Cast] Cast text length: ${actualCastText.length}`);

        // Build embed — use snap URL for inline snap rendering in Farcaster clients
        const embeds: { url: string }[] = [];
        if (includeEmbed !== false) {
          const hostname = env.HOSTNAME || 'qbase.tech';
          const baseUrl = hostname.startsWith('http') ? hostname : `https://${hostname}`;
          const compactToken = await generateCompactToken(snapSubject, env.QBASE_SECRET);
          embeds.push({ url: `${baseUrl}${snapPath}?compact=1&token=${compactToken}` });
          console.log(`[Farcaster Cast] Adding snap embed: ${embeds[0].url}`);
        }

        const result = await hypersnap.publishCast({
          signerKey: anonSignerKey,
          fid: anonFid,
          text: actualCastText,
          embeds,
        });

        console.log(`[Farcaster Cast] ✅ Anonymous query ${queryId} casted from @4n0n bot`);
        console.log(`[Farcaster Cast] Cast hash: ${result.hash}`);

        // Store cast hash in database
        const { FarcasterDBService } = await import('../services/FarcasterDBService');
        await FarcasterDBService.upsertCast(env.DB, {
          entity_type: 'query',
          entity_id: queryId,
          cast_hash: result.hash,
          cast_url: `https://farcaster.xyz/4n0n/${result.hash}`,
          caster_fid: anon_fid,
        });

        console.log(`[Farcaster Cast] ✅ Stored cast hash for anonymous query ${queryId} in database`);

        // Also update question_meta.cast_hash so answer casting can find it
        await env.DB.prepare(
          `UPDATE question_meta SET cast_hash = ?, cast_status = 'active', updated_at = ? WHERE question_id = ?`
        ).bind(result.hash, Date.now(), queryId).run();
        if (pollId) await setPollCastHash(env.DB, pollId, result.hash);
      }
    } else {
      // User casting via CastRouter (Snapchain → Neynar fallback)
      if (!realCoinerFid) {
        console.warn(`[Farcaster Cast] No coiner FID, skipping user cast for query ${queryId}`);
      } else {
        try {
          const { initCastRouter } = await import('../services/casting');
          const router = initCastRouter(env);

          const embeds: { url: string }[] = [];
          if (includeEmbed !== false) {
            const hostname = env.HOSTNAME || 'qbase.tech';
            const baseUrl = hostname.startsWith('http') ? hostname : `https://${hostname}`;
            const compactToken = await generateCompactToken(snapSubject, env.QBASE_SECRET);
            embeds.push({ url: `${baseUrl}${snapPath}?compact=1&token=${compactToken}` });
          }

          const result = await router.publish({
            fid: realCoinerFid,
            text: actualCastText,
            embeds,
          }, env);

          console.log(`[Farcaster Cast] ✅ User query ${queryId} casted from FID ${realCoinerFid} via ${result.provider}`);

          const { FarcasterDBService } = await import('../services/FarcasterDBService');
          await FarcasterDBService.upsertCast(env.DB, {
            entity_type: 'query',
            entity_id: queryId,
            cast_hash: result.hash,
            cast_url: `https://farcaster.xyz/${realCoinerFid}/${result.hash}`,
            caster_fid: realCoinerFid,
          });

          // Also update question_meta.cast_hash so answer casting can find it
          await env.DB.prepare(
            `UPDATE question_meta SET cast_hash = ?, cast_status = 'active', updated_at = ? WHERE question_id = ?`
          ).bind(result.hash, Date.now(), queryId).run();
          if (pollId) await setPollCastHash(env.DB, pollId, result.hash);
        } catch (userCastError: any) {
          console.warn(`[Farcaster Cast] User cast failed for FID ${realCoinerFid}: ${userCastError.message}`);
          console.warn(`[Farcaster Cast] Falling back to anon bot`);

          // Fallback: cast from anon bot
          const anonSignerKey: string | undefined = env.ANON_SIGNER_KEY;
          if (anonSignerKey) {
            const { createHypersnapService } = await import('../services/HypersnapService');
            const hypersnap = createHypersnapService(env);

            const embeds: { url: string }[] = [];
            if (includeEmbed !== false) {
              const hostname = env.HOSTNAME || 'qbase.tech';
              const baseUrl = hostname.startsWith('http') ? hostname : `https://${hostname}`;
              const compactToken = await generateCompactToken(snapSubject, env.QBASE_SECRET);
              embeds.push({ url: `${baseUrl}${snapPath}?compact=1&token=${compactToken}` });
            }

            const fallbackResult = await hypersnap.publishCast({
              signerKey: anonSignerKey,
              fid: Number(env.ANON_FID) || 514282,
              text: actualCastText,
              embeds,
            });

            const { FarcasterDBService } = await import('../services/FarcasterDBService');
            await FarcasterDBService.upsertCast(env.DB, {
              entity_type: 'query',
              entity_id: queryId,
              cast_hash: fallbackResult.hash,
              cast_url: `https://farcaster.xyz/4n0n/${fallbackResult.hash}`,
              caster_fid: Number(env.ANON_FID) || 514282,
            });

            // Also update question_meta.cast_hash so answer casting can find it
            await env.DB.prepare(
              `UPDATE question_meta SET cast_hash = ?, cast_status = 'active', updated_at = ? WHERE question_id = ?`
            ).bind(fallbackResult.hash, Date.now(), queryId).run();
            if (pollId) await setPollCastHash(env.DB, pollId, fallbackResult.hash);

            console.log(`[Farcaster Cast] ✅ Fallback: query ${queryId} casted from @4n0n bot`);
          }
        }
      }
    }
  } catch (castError) {
    console.error(`[Farcaster Cast] ❌ Failed to cast query ${queryId} to Farcaster:`, castError);
    console.error(`[Farcaster Cast] Error details:`, JSON.stringify(castError, null, 2));
    if (castError instanceof Error) {
      console.error(`[Farcaster Cast] Error message: ${castError.message}`);
      console.error(`[Farcaster Cast] Error stack:`, castError.stack);
    }
  }

  return { castWarning };
}

export async function handleCreateQuery(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  try {
    const body = await request.json() as QuerySubmission;

    // Validate required fields
    if (!body.stem || !body.type || !body.coiner_id) {
      return new Response('Missing required fields: stem, type, coiner_id', { status: 400 });
    }

    // Validate type
    const validTypes = Object.values(QueryType);
    if (!validTypes.includes(body.type)) {
      return new Response(`Invalid type. Must be one of: ${validTypes.join(', ')}`, { status: 400 });
    }

    // ── Wave fields validation (shape only; snapshot resolution runs later) ──
    // A closes_at opens the question's first wave. Gates and open options live
    // on waves only, so both require a closes_at.
    const opensWave = body.closes_at !== undefined && body.closes_at !== null;
    if (opensWave) {
      const err = validateCloseTime(body.closes_at);
      if (err) return new Response(err.error, { status: err.status });
    }
    if (body.eligibility_gate && !opensWave) {
      return new Response('eligibility_gate requires closes_at', { status: 400 });
    }
    if (body.eligibility_gate) {
      const err = validateGateSubmission(body.eligibility_gate);
      if (err) return new Response(err.error, { status: err.status });
    }
    // Open-options config (MC-only). NULL → classic closed MC.
    if (body.options_config !== undefined && body.options_config !== null) {
      if (!opensWave) {
        return new Response('options_config requires closes_at — open options live on waves', { status: 400 });
      }
      if (body.type !== 'mc') {
        return new Response('options_config is only valid for mc questions', { status: 400 });
      }
      if (!buildOptionsConfig(body.options_config)) {
        return new Response('Invalid options_config — expected { open: true, cap?, writeins_per_user? }', { status: 400 });
      }
      if (!Array.isArray(body.a_options) || body.a_options.length === 0) {
        return new Response('Open polls need at least one seed option in a_options', { status: 400 });
      }
    }

    // Who casts: 'server' (default, existing behavior), 'client' (composeCast), 'none'
    const castMode = body.cast_mode || 'server';
    if (!['server', 'client', 'none'].includes(castMode)) {
      return new Response(
        JSON.stringify({ error: "Invalid cast_mode — expected 'server', 'client', or 'none'" }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Types that require a Farcaster signer to cast as the user — only when the server casts
    const SIGNER_REQUIRED_TYPES = ['text', 'checkbox', 'scale'];
    const isAnon = body.isAnon === true;
    if (castMode === 'server' && SIGNER_REQUIRED_TYPES.includes(body.type) && !isAnon) {
      const verifiedFid = request.headers.get('X-Verified-FID');
      if (verifiedFid) {
        const signerRow = await env.DB.prepare(
          "SELECT 1 FROM user_signers WHERE fid = ? AND status = 'approved' LIMIT 1"
        ).bind(parseInt(verifiedFid, 10)).first();
        if (!signerRow) {
          return new Response(
            JSON.stringify({ error: 'Connect Farcaster to create this question type. Or enable "post anon".' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    // Initialize AI service for LLM-based validation and taxonomy classification
    const aiService = AIService.fromEnv(env);

    // Classify question using multi-dimensional taxonomy
    let taxonomy;
    try {
      taxonomy = await aiService.classifyQuestion(body.stem, body.a_options);
      console.log('Question taxonomy classification:', taxonomy);
    } catch (taxonomyError: unknown) {
      console.error('Taxonomy classification failed:', taxonomyError);
      return new Response(
        'Unable to classify question. AI service temporarily unavailable. Please try again.',
        { status: 503 }
      );
    }

    // Reject invalid inputs (not actually questions)
    if (taxonomy.primary_type === 'invalid') {
      return new Response(
        'Please enter a valid question. The input provided does not appear to be a question.',
        { status: 400 }
      );
    }

    // Requests (`intent = request`: help, advice, how-to) are a Q&A product —
    // a thread, not a tally (roadmap decision 11). A text question already
    // reads as a thread, so it goes through with `intent` stored on the
    // taxonomy. An MC/scale/checkbox request would be stored as a poll and
    // tallied, which is the wrong product; until a thread surface exists we
    // reject it with a pointer rather than silently mis-shaping it.
    if (taxonomy.intent === 'request' && body.type !== 'text') {
      return new Response(
        JSON.stringify({
          error:
            'This reads as a request for help or advice rather than a question for the crowd. ' +
            'qbase answers requests in a thread, not a tally: ask it as a text question, ' +
            'or rephrase it so people report their own view (e.g. "which would you pick?").',
          code: 'request_needs_thread',
          taxonomy: { intent: taxonomy.intent, primary_type: taxonomy.primary_type },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Process tags with attribution
    let finalTags: string[] = [];

    // Add user-provided tags with user attribution
    if (body.tags && body.tags.length > 0) {
      const userId = body.coiner_id; // person key of the question creator
      finalTags = body.tags.map(tag => `${userId}:${tag}`);
    }

    // Use AI-generated topics from taxonomy if no user tags
    if (finalTags.length === 0 && taxonomy.topics && taxonomy.topics.length > 0) {
      finalTags = taxonomy.topics.map(topic => `ai:${topic}`);
      console.log('Using AI-generated topics from taxonomy:', finalTags);
    }

    // Check if stem is incomplete (template) - now using taxonomy result
    const isIncomplete = taxonomy.is_template;

    // Reject incomplete stems without options
    if (isIncomplete && (!body.a_options || body.a_options.length < 2)) {
      return new Response(
        'This question stem is incomplete. ' +
        'Please provide at least 2 specific options to complete the question.',
        { status: 400 }
      );
    }

    // If options provided, validate them
    if (body.a_options && body.a_options.length > 0) {
      // Require at least 2 options if any provided
      if (body.a_options.length < 2) {
        return new Response('Please provide at least 2 options for multiple choice questions.', { status: 400 });
      }

      // Validate options are not empty
      if (body.a_options.some(o => !o.trim())) {
        return new Response('Question options cannot be empty.', { status: 400 });
      }
    }

    // Fork validation. A fork is a deliberate re-ask of an existing question
    // with a different answer shape (type or options/scale_config). We validate
    // that:
    //   1. forked_from resolves to a real question
    //   2. the fork actually changes shape vs the source (otherwise it's a dupe)
    // When both hold, we bypass the duplicate-similarity gates below — same stem
    // is the whole point of a fork.
    let isValidatedFork = false;
    if (body.forked_from) {
      const sourceRow = await env.DB.prepare(
        'SELECT id, type, a_options, scale_config, date_config FROM queries WHERE id = ? LIMIT 1'
      ).bind(body.forked_from).first() as
        | { id: string; type: string; a_options: string | null; scale_config: string | null; date_config: string | null }
        | null;

      if (!sourceRow) {
        return new Response(
          JSON.stringify({ error: 'forked_from references a question that does not exist' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const sourceOptions = sourceRow.a_options ? JSON.parse(sourceRow.a_options) : null;
      const sourceScale = sourceRow.scale_config ? JSON.parse(sourceRow.scale_config) : null;
      const sourceDate = sourceRow.date_config ? JSON.parse(sourceRow.date_config) : null;
      const typeChanged = sourceRow.type !== body.type;
      const optionsChanged =
        JSON.stringify(sourceOptions ?? null) !== JSON.stringify(body.a_options ?? null);
      const scaleChanged =
        JSON.stringify(sourceScale ?? null) !== JSON.stringify(body.scale_config ?? null);
      const dateChanged =
        JSON.stringify(sourceDate ?? null) !== JSON.stringify(body.date_config ?? null);

      if (!typeChanged && !optionsChanged && !scaleChanged && !dateChanged) {
        return new Response(
          JSON.stringify({
            error:
              'A fork must change the answer shape (type, options, scale, or date format). Edit the stem if you just want to re-ask.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      isValidatedFork = true;
    }

    // FIRST: Quick exact-match check in DB (catches true duplicates immediately, no eventual consistency issues)
    // This is a synchronous check that works even before Vectorize indexes the new question
    // Skipped for validated forks: same stem is the point of a fork.
    const normalizedStem = body.stem.trim().toLowerCase();
    const exactMatchCheck = isValidatedFork
      ? null
      : await env.DB.prepare(
          `SELECT id FROM queries WHERE LOWER(TRIM(stem)) = ? LIMIT 1`
        ).bind(normalizedStem).first();

    if (exactMatchCheck) {
      console.log(`[DUPLICATE CHECK] Exact match found for stem: "${body.stem.substring(0, 50)}..." -> existing ID: ${exactMatchCheck.id}`);
      return new Response(
        JSON.stringify({
          error: 'This exact question already exists',
          code: 'duplicate_exact',
          existing_id: exactMatchCheck.id,
          similarity: 1.0,
          // Re-ask routing: the same question can carry a fresh wave instead.
          reask: { question_id: exactMatchCheck.id, open_wave: 'POST /api/polls' },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // SECOND: Generate and check vector embedding for near-duplicate detection
    let vector: number[];
    let embeddingText: string;

    try {
      const vectorService = VectorService.fromEnv(env);

      // Generate embedding text with selective strategy using taxonomy
      // Template questions include options in embedding for semantic matching
      embeddingText = vectorService.generateEmbeddingText(
        body.stem,
        body.a_options,
        taxonomy.is_template
      );

      console.log(`Generated embedding text: "${embeddingText.substring(0, 100)}..."`);

      // Generate embedding vector
      vector = await vectorService.vectorize(embeddingText);

      // Check for duplicates using the two-threshold system (catches near-duplicates).
      // Skipped for validated forks: same stem ⇒ same vector, but the fork has a
      // different answer shape so it's not actually a duplicate.
      if (!isValidatedFork) {
        const similarResults = await vectorService.searchSimilar(vector, 'q', 5);

        if (similarResults.length > 0 && similarResults[0].score >= 0.98) {
          return new Response(
            JSON.stringify({
              error: 'A nearly identical question already exists',
              code: 'duplicate_similar',
              existing_id: similarResults[0].id,
              similarity: similarResults[0].score,
              reask: { question_id: similarResults[0].id, open_wave: 'POST /api/polls' },
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
      }

    } catch (vectorError: unknown) {
      console.error('Vector generation/search failed:', vectorError);
      return new Response(
        'Unable to process question for duplicate detection. Vector service temporarily unavailable. Please try again.',
        { status: 503 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Store real author info for anonymous queries before masking.
    // coiner_id is the PERSON KEY (set by routes/queries.ts from auth.userKey);
    // coiner_fid is the linked Farcaster fid, NULL for an account without one.
    const realCoinerId = body.coiner_id;
    const realCoinerFid = body.coiner_fid ?? undefined;
    const isAnonymous = body.isAnon === true;

    // If anonymous, mask the author info with anon bot account
    let displayCoinerId = body.coiner_id;
    let displayCoinerFname = body.coiner_fname || null;
    let displayCoinerFid = body.coiner_fid || null;

    if (isAnonymous) {
      // coiner_id / owner_id are person-key columns. Before the account cutover
      // the mask is the legacy anon id (3); after it, @4n0n's account — the
      // cutover remaps existing anon questions the same way (through coiner_fid).
      displayCoinerId = (await isRewritten(env)) ? await userKeyForFid(env, anon_fid) : anon_id;
      displayCoinerFname = '4n0n';
      displayCoinerFid = anon_fid; // Use anonymous FID (514282)
      console.log(`Creating anonymous query ${id}`);
    }

    // ── Holder snapshot (wave eligibility gate) ──
    // Heavy onchain + Neynar work; runs before QP deduction so a snapshot
    // failure doesn't leave the user charged. WaveService reuses a prior
    // wave's snapshot when the gate params match (resnapshot forces a fresh one).
    let resolvedGate: ResolvedGate | null = null;
    if (body.eligibility_gate) {
      try {
        resolvedGate = await resolveGate(env, body.eligibility_gate, { resnapshot: body.resnapshot === true });
      } catch (snapErr: unknown) {
        const msg = snapErr instanceof Error ? snapErr.message : String(snapErr);
        console.error('[Query Creation] Holder snapshot failed:', msg);
        return new Response(
          JSON.stringify({ error: `Holder snapshot failed: ${msg}` }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }

    // Check and deduct QP cost. The price is set HERE, never by the client:
    // the client-supplied cost field used to be honoured verbatim, so a caller
    // could set its own price (or none). Plain questions are free by decision
    // (2026-09-07): the growth signal from outside creators runs
    // on free questions, and the paid units are waves / sponsorship / council,
    // not the question itself. Change the constant to start charging QP.
    const queryCost = QUESTION_CREATE_COST_QP;
    let deductedFromAllowance = 0;
    let deductedFromBalance = 0;
    let deductedUserFid: number | null = null;
    
    if (queryCost > 0) {
      // SECURITY: Use the verified person key from the auth header (set by the
      // worker after authentication), not a body field which could be
      // manipulated. QP balances are person-level (KV_USER_POINTS by person key).
      const verifiedKeyHeader = request.headers.get('X-Verified-User-Key');

      if (!verifiedKeyHeader) {
        console.error('Missing X-Verified-User-Key header - authentication bypass attempt?');
        return new Response('Authentication error', { status: 401 });
      }

      const userFid = Number(verifiedKeyHeader);
      deductedUserFid = userFid;

      // Use PointsService to handle deduction
      const pointsService = PointsService.fromEnv(env);
      const deductResult = await pointsService.deductPoints(
        userFid,
        queryCost,
        `query creation: ${body.stem.substring(0, 50)}`
      );

      if (!deductResult) {
        const currentPoints = await pointsService.getPoints(userFid);
        const totalSpendable = pointsService.getTotalSpendable(currentPoints);
        return new Response(
          `Insufficient QP. Required: ${queryCost}, Available: ${totalSpendable}`,
          { status: 402 } // 402 Payment Required
        );
      }

      deductedFromAllowance = deductResult.deductedFromAllowance;
      deductedFromBalance = deductResult.deductedFromBalance;
      const { points: updatedPoints } = deductResult;
      console.log(`[Query Creation] Deducted ${queryCost} QP from user FID ${userFid}. New state: allowance=${updatedPoints.allowance}, earned=${updatedPoints.earned}, balance=${updatedPoints.balance}`);
    }

    // Prepare values for insertion
    const a_options = body.a_options ? JSON.stringify(body.a_options) : null;
    const scale_config = body.scale_config ? JSON.stringify(body.scale_config) : null;
    const date_config = body.date_config ? JSON.stringify(body.date_config) : null;
    const tags = finalTags.length > 0 ? JSON.stringify(finalTags) : null;
    const reqs = body.reqs ? JSON.stringify(body.reqs) : null;
    const assets = body.assets ? JSON.stringify(body.assets) : null;
    const taxonomyJson = JSON.stringify(taxonomy);
    // closes_at / eligibility_gate / options_config are wave fields: they go
    // to `polls` via openWave below, never to `queries` (columns dropped, 0068).
    const optionsConfig = body.options_config ? buildOptionsConfig(body.options_config) : null;

    // Insert into D1 database
    // For anonymous queries, coiner_id/owner_id/coiner_fid are masked with anon_fid
    const stmt = env.DB.prepare(`
      INSERT INTO queries (
        id, stem, type, a_options, scale_config, date_config, cost, created_at,
        coiner_id, owner_id, coiner_fname, coiner_fid,
        token_id, casthash, tags, parent, reqs, assets, template, taxonomy,
        channel_id, pub_answers, priv_answers, comments
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, 0, 0, 0
      )
    `).bind(
      id,
      body.stem,
      body.type,
      a_options,
      scale_config,
      date_config,
      queryCost,
      now,
      displayCoinerId,      // Masked if anonymous
      displayCoinerId,      // owner_id defaults to coiner_id (masked if anonymous)
      displayCoinerFname,   // '4n0n' if anonymous
      displayCoinerFid,     // anon_fid if anonymous
      body.token_id || null,
      body.casthash || null,
      tags,
      body.parent || null,
      reqs,
      assets,
      isIncomplete ? 1 : 0,  // Store LLM classification result for NFT minting
      taxonomyJson,
      body.channel_id || null,  // Farcaster channel ID
    );

    await stmt.run();

    // ── First wave: a closes_at makes this a poll. WaveService inserts the
    // `polls` row and seeds its option set; gates live there and nowhere else. ──
    let pollId: string | null = null;
    let waveSnapshot: { holder_address_count: number; holder_fid_count: number; snapshotted_at: string; reused_from?: string } | undefined;
    if (opensWave) {
      // polls.author_fid is a person key: the author's, or @4n0n's for an
      // anon question (its fid mapped to its person key, same mask as before).
      const waveAuthorKey = isAnonymous ? await userKeyForFid(env, anon_fid) : Number(realCoinerId);
      const wave = await openWave(env, {
        question_id: id,
        closes_at: body.closes_at as string,
        resolved_gate: resolvedGate,
        options_config: optionsConfig,
        author_fid: waveAuthorKey,
        channel_id: body.channel_id ?? null,
        created_at: now,
      });
      if (!wave.ok) {
        // The question row exists; the wave is what failed. Surface it — the
        // creator can open a wave on the question from its page.
        console.error(`[Query Creation] wave open failed for ${id}: ${wave.status} ${wave.error}`);
      } else {
        pollId = wave.poll.id;
        waveSnapshot = wave.snapshot;
      }
    }

    // ── Dual-write: seed question_meta for Hypersnap data layer ──
    try {
      const nowMs = Date.now();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO question_meta
         (question_id, cast_hash, cast_status, author_fid, is_anon, answer_type_id, value_schema, topic_id, canonical_id, forked_from, created_at, updated_at)
         VALUES (?, NULL, 'pending', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
      ).bind(
        id,
        displayCoinerFid,
        isAnonymous ? 1 : 0,
        body.type ?? 'text',
        body.forked_from ?? null,
        nowMs,
        nowMs,
      ).run();
      console.log(`[DualWrite] Seeded question_meta for ${id}${body.forked_from ? ` (forked from ${body.forked_from})` : ''}`);
    } catch (metaErr) {
      // Non-fatal — reconciler will pick up orphaned rows
      console.error(`[DualWrite] Failed to seed question_meta for ${id}:`, metaErr);
    }

    // Vector storage moved to backgroundTask below — the index entry only matters
    // for future duplicate detection of *other* questions, not for this response.

    // For anonymous questions, attribution is REQUIRED for governance/accountability
    // Attribution must succeed before we return success - if it fails, rollback everything
    if (isAnonymous) {
      console.log(`[QUERY CREATE] Creating required attribution for anonymous query ${id}`);
      try {
        await AnonAttributionService.createAttribution(env, {
          public_id: id,
          fid: Number(realCoinerId), // the tag and sealed author are over the person key
          type: 'question',
          scope_id: id,
        });
        console.log(`[QUERY CREATE] ✅ Attribution created for anonymous query ${id}`);
      } catch (attributionError) {
        console.error(`[QUERY CREATE] ❌ Attribution failed for anonymous query ${id}:`, attributionError);
        
        // ROLLBACK: Delete the query and refund QP. The Vectorize entry is
        // written in backgroundTask after this point, so on this path it
        // never gets created and there's nothing to clean up.
        console.log(`[QUERY CREATE] Rolling back anonymous query ${id} due to attribution failure`);

        try {
          // Delete from D1
          await env.DB.prepare('DELETE FROM queries WHERE id = ?').bind(id).run();

          // Refund QP
          if (queryCost > 0 && deductedUserFid) {
            const pointsService = PointsService.fromEnv(env);
            await pointsService.refundPoints(
              deductedUserFid,
              deductedFromAllowance,
              deductedFromBalance,
              'refund: anonymous attribution failed'
            );
            console.log(`[QUERY CREATE] Refunded ${queryCost} QP to user FID ${deductedUserFid}`);
          }
        } catch (rollbackError) {
          console.error(`[QUERY CREATE] ❌ Rollback failed:`, rollbackError);
        }
        
        return new Response(
          JSON.stringify({
            error: 'Failed to create anonymous question. Attribution service unavailable. Please try again.',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Post to Farcaster in background (non-blocking)
    // This allows us to return immediately after DB write for faster UX
    console.log(`[QUERY CREATE] Question ${id} created in DB, initiating background Farcaster post`);
    console.log(`[QUERY CREATE] isAnonymous: ${isAnonymous}`);

    // Background task: store vector index entry, post to Farcaster, etc.
    // None of these block the user response. If addVectors fails the question is
    // still live in D1 — it just won't show up in dup-detection until the hourly
    // reconciler backfills the missing vector (worker/services/VectorReconciler.ts).
    const backgroundTask = async () => {
      try {
        const vectorService = VectorService.fromEnv(env);
        await vectorService.addVectors([{
          id,
          values: vector,
          metadata: {
            stem: body.stem,
            text: body.stem, // Alias for backward compatibility
            type: body.type,
            created_at: now,
            coiner_id: displayCoinerId, // never the real author of an anon question
            coiner_fid: displayCoinerFid,
            coiner_fname: displayCoinerFname,
            options_count: body.a_options?.length || 0,
          },
        }], 'q');
        console.log(`Vector stored for query ${id}`);
      } catch (vectorError) {
        console.error(`[QUERY CREATE] ⚠️ Vector storage failed for ${id} (will need reconciliation):`, vectorError);
      }

      try {
        if (castMode === 'server') {
          await postQueryToFarcaster(
            env,
            id,
            body.stem,
            body.type,
            body.a_options,
            isAnonymous,
            realCoinerFid,
            body.channel_id,
            body.includeEmbed,
            pollId,
          );
          console.log(`[QUERY CREATE] ✅ Background Farcaster cast completed for ${id}`);
        } else {
          console.log(`[QUERY CREATE] cast_mode=${castMode} — skipping server cast for ${id}`);
        }
      } catch (err) {
        console.error(`[QUERY CREATE] ⚠️ Background Farcaster posting failed:`, err);
        // Question already created - cast failure is non-critical
      }

      // Extract topics from tags and store in Topics/QueryTopics tables
      // Tags format: "source:topic" (e.g., "ai:blockchain" or "12345:crypto")
      try {
        if (finalTags.length > 0) {
          const topicNames = finalTags
            .map(tag => {
              const parts = tag.split(':');
              return parts.length >= 2 ? parts.slice(1).join(':').trim() : null;
            })
            .filter((name): name is string => name !== null && name.length > 0);

          if (topicNames.length > 0) {
            const topics = await TopicService.getOrCreateTopics(env.DB, topicNames);
            const topicIds = topics.map(t => t.id);
            await TopicService.associateTopicsWithQuery(env.DB, id, topicIds);
            console.log(`[QUERY CREATE] ✅ Associated ${topicIds.length} topics with query ${id}`);
          }
        }
      } catch (topicErr) {
        console.error(`[QUERY CREATE] ⚠️ Topic association failed:`, topicErr);
        // Non-critical - question still created successfully
      }

      // Poke Q's event trigger system (fire-and-forget)
      try {
        if (env.QGENT) {
          const qId = env.QGENT.idFromName("Q");
          const qStub = env.QGENT.get(qId);
          const topicNames = finalTags
            .map((tag: string) => { const p = tag.split(':'); return p.length >= 2 ? p.slice(1).join(':').trim() : null; })
            .filter((n: string | null): n is string => n !== null && n.length > 0);

          // Get total question count for milestone detection
          const countResult = await env.DB.prepare('SELECT COUNT(*) as cnt FROM queries').first();

          const triggerReq = new Request("https://internal/trigger", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.QGENT_ADMIN_SECRET}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event: "question_created",
              question_id: id,
              stem: body.stem,
              topics: topicNames,
              is_anonymous: isAnonymous,
              total_questions: countResult?.cnt || 0,
            }),
          });
          await qStub.fetch(triggerReq);
          console.log(`[QUERY CREATE] Q trigger poked for question ${id}`);
        }
      } catch (qErr) {
        console.error(`[QUERY CREATE] ⚠️ Q trigger failed (non-critical):`, qErr);
      }
    };

    // Use waitUntil if available (Cloudflare Workers context), otherwise fire-and-forget
    if (ctx?.waitUntil) {
      ctx.waitUntil(backgroundTask());
    } else {
      // Fallback for environments without waitUntil (shouldn't happen in production)
      backgroundTask().catch(err => console.error('[QUERY CREATE] Background task error:', err));
    }

    // Return immediately - frontend navigates to question page while cast posts in background
    // cast_text mirrors the server's casting rule: MC with an embed casts stem-only
    // (options live in the snap), everything else uses formatCastText.
    const hasEmbedForCastText = body.includeEmbed !== false;
    const castText = (body.type === 'mc' && hasEmbedForCastText)
      ? body.stem
      : formatCastText(body.stem, body.type, body.a_options);
    return Response.json({
      success: true,
      id,
      message: 'Query created successfully',
      isAnonymous,  // Let frontend know this was anonymous
      castPending: castMode === 'server',  // Frontend knows cast is still in progress (server mode only)
      cast_text: castText,
      // The wave opened on this question (only when closes_at was set).
      ...(pollId ? { poll_id: pollId } : {}),
      // Snapshot coverage so the creator can see how many holders are reachable
      ...(waveSnapshot ? { snapshot: waveSnapshot } : {}),
    });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error creating query:', e);
    return new Response(`Error creating query: ${err.message}`, { status: 500 });
  }
}

export async function handleGetQuery(request: Request, env: Env, id: string): Promise<Response> {
  try {
    // Check for optional authentication to include user-specific data
    const { getOptionalAuth } = await import('../middleware/auth');
    const currentUserFid = await getOptionalAuth(request, env);

    // Get query with engagement data
    // Prefer cached Farcaster stats (from live API sync) over computed stats (from local reactions only)
    const queryStr = `
      SELECT
        q.*,
        fc.cast_hash,
        fc.cached_likes_count,
        fc.cached_recasts_count,
        fc.cached_replies_count,
        fc.stats_synced_at,
        qm.forked_from as forked_from,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'like' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as computed_likes,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'recast' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as computed_recasts,
        COALESCE(COUNT(DISTINCT frep.id), 0) as computed_replies,
        (SELECT COUNT(*) FROM polls p WHERE p.question_id = q.id) as poll_count
      FROM queries q
      LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
      LEFT JOIN farcaster_reactions fr ON fr.cast_hash = fc.cast_hash
      LEFT JOIN farcaster_replies frep ON frep.parent_cast_hash = fc.cast_hash AND frep.is_active = 1
      LEFT JOIN question_meta qm ON qm.question_id = q.id
      WHERE q.id = ?
      GROUP BY q.id
    `;

    const query = await env.DB.prepare(queryStr).bind(id).first();

    if (!query) {
      return new Response('Query not found', { status: 404 });
    }

    // Resolve fork parent metadata so the frontend can render a backlink without a second round trip
    let forkedFromStem: string | undefined;
    let forkedFromCoinerFname: string | undefined;
    let forkedFromCoinerFid: number | undefined;
    if (query.forked_from) {
      const parentRow = await env.DB.prepare(
        'SELECT stem, coiner_fname, coiner_fid FROM queries WHERE id = ? LIMIT 1'
      ).bind(query.forked_from).first() as
        | { stem: string; coiner_fname: string | null; coiner_fid: number | null }
        | null;
      if (parentRow) {
        forkedFromStem = parentRow.stem;
        forkedFromCoinerFname = parentRow.coiner_fname ?? undefined;
        forkedFromCoinerFid = parentRow.coiner_fid ?? undefined;
      }
    }

    // Check if current user has liked/recasted this query
    let userHasLiked = false;
    let userHasRecasted = false;

    if (currentUserFid && query.cast_hash) {
      const userReactionsQuery = `
        SELECT reaction_type 
        FROM farcaster_reactions 
        WHERE cast_hash = ? AND reactor_fid = ? AND is_deleted = 0
      `;
      const { results } = await env.DB.prepare(userReactionsQuery)
        .bind(query.cast_hash, currentUserFid)
        .all();

      userHasLiked = results.some((r: any) => r.reaction_type === 'like');
      userHasRecasted = results.some((r: any) => r.reaction_type === 'recast');
    }

    // Parse JSON fields
    // Use cached Farcaster stats when available (synced from live API), otherwise fall back to computed stats
    const hasCachedStats = query.stats_synced_at !== null;
    
    // Extract internal fields that shouldn't be returned
    const {
      cached_likes_count,
      cached_recasts_count,
      cached_replies_count,
      stats_synced_at: _stats_synced_at,
      computed_likes,
      computed_recasts,
      computed_replies,
      cast_hash,
      ...restQuery
    } = query;

    // The wave this page answers through: ?poll=<id> when the URL names one
    // (must belong to this question), else the open wave if any. Open-options
    // config and the live (visible) option set come from that wave so the
    // client renders from one fetch. created_by_fid is never included.
    const requestedPollId = new URL(request.url).searchParams.get('poll');
    let currentPoll = requestedPollId ? await getPoll(env.DB, requestedPollId) : null;
    if (currentPoll && currentPoll.question_id !== query.id) currentPoll = null;
    if (!currentPoll && !requestedPollId) currentPoll = await getOpenPoll(env.DB, query.id);
    const optionsConfig = currentPoll ? (parseOptionsConfig(currentPoll.options_config) ?? undefined) : undefined;
    const pollOptions = optionsConfig && currentPoll
      ? await listVisibleOptions(env.DB, currentPoll.id)
      : undefined;

    const parsedQuery = {
      ...restQuery,
      a_options: query.a_options ? JSON.parse(query.a_options) : undefined,
      options_config: optionsConfig,
      poll_options: pollOptions,
      current_poll: currentPoll ? toPublicPoll(currentPoll) : undefined,
      scale_config: query.scale_config ? JSON.parse(query.scale_config) : undefined,
      date_config: query.date_config ? JSON.parse(query.date_config) : undefined,
      tags: query.tags ? JSON.parse(query.tags) : undefined,
      reqs: query.reqs ? JSON.parse(query.reqs) : undefined,
      assets: query.assets ? JSON.parse(query.assets) : undefined,
      template: Boolean(query.template),
      created_at: new Date(query.created_at).getTime(), // Convert to unix epoch for frontend
      // Map cast_hash to casthash for frontend compatibility
      casthash: cast_hash || undefined,
      // Add engagement data - prefer cached stats from Farcaster API over local-only computed stats
      farcaster_likes: hasCachedStats ? Number(cached_likes_count) || 0 : Number(computed_likes) || 0,
      farcaster_recasts: hasCachedStats ? Number(cached_recasts_count) || 0 : Number(computed_recasts) || 0,
      farcaster_replies: hasCachedStats ? Number(cached_replies_count) || 0 : Number(computed_replies) || 0,
      // Add user-specific reaction data
      user_has_liked: userHasLiked,
      user_has_recasted: userHasRecasted,
      // Fork lineage (forked_from already on restQuery from the JOIN, only undefined if no row)
      forked_from: query.forked_from ?? undefined,
      forked_from_stem: forkedFromStem,
      forked_from_coiner_fname: forkedFromCoinerFname,
      forked_from_coiner_fid: forkedFromCoinerFid,
    };

    return Response.json(parsedQuery);
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error fetching query:', e);
    return new Response(`Error fetching query: ${err.message}`, { status: 500 });
  }
}

export async function handleListQueries(request: Request, env: Env): Promise<Response> {
  try {
    // Check for optional authentication to include user-specific data
    const { getOptionalAuth } = await import('../middleware/auth');
    const currentUserFid = await getOptionalAuth(request, env);

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const search = url.searchParams.get('search');
    // 'new' (by latest activity: the question or its newest poll), 'popular',
    // or 'open' (questions with a poll still open, newest poll first).
    const sort = url.searchParams.get('sort') || 'new';

    // Build query with engagement data from Farcaster tables
    // Prefer cached Farcaster stats (from live API sync) over computed stats (from local reactions only)
    let query = `
      SELECT 
        q.*,
        fc.cast_hash,
        fc.cached_likes_count,
        fc.cached_recasts_count,
        fc.cached_replies_count,
        fc.stats_synced_at,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'like' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as computed_likes,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'recast' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as computed_recasts,
        COALESCE(COUNT(DISTINCT frep.id), 0) as computed_replies,
        (SELECT COUNT(*) FROM polls p WHERE p.question_id = q.id) as poll_count,
        (SELECT MAX(p.created_at) FROM polls p WHERE p.question_id = q.id) as last_poll_at,
        (SELECT MAX(p.created_at) FROM polls p WHERE p.question_id = q.id AND julianday(p.closes_at) > julianday('now')) as open_poll_at
      FROM queries q
      LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
      LEFT JOIN farcaster_reactions fr ON fr.cast_hash = fc.cast_hash
      LEFT JOIN farcaster_replies frep ON frep.parent_cast_hash = fc.cast_hash AND frep.is_active = 1
    `;

    const params: (string | number)[] = [];

    if (search) {
      query += ' WHERE q.stem LIKE ?';
      params.push(`%${search}%`);
    }

    // Filter by coiner_fid if provided
    const coinerFid = url.searchParams.get('coiner_fid');
    if (coinerFid) {
      const fid = parseInt(coinerFid);
      if (!isNaN(fid)) {
        // If WHERE clause already exists (from search), add AND, else add WHERE
        if (params.length > 0) {
          query += ' AND q.coiner_fid = ?';
        } else {
          query += ' WHERE q.coiner_fid = ?';
        }
        params.push(fid);
      }
    }

    query += ' GROUP BY q.id';
    if (sort === 'open') query += ' HAVING open_poll_at IS NOT NULL';

    // Sort by popularity or recency
    if (sort === 'popular') {
      // Popularity algorithm:
      // - Answers are the primary engagement metric (people took time to answer)
      // - Farcaster engagement adds secondary weight
      // - Recency boost: questions lose ~50% of their score after 7 days
      // 
      // Formula: (answers * 5 + likes * 2 + recasts * 3 + replies * 1) * recency_multiplier
      // Recency multiplier: 1.0 for new questions, decays over time using exponential decay
      //
      // SQLite doesn't have great date math, so we use:
      // - julianday() to get days since creation
      // - exp(-days/7) for smooth decay (half-life of about 5 days)
      query += ` ORDER BY (
        (COALESCE(q.pub_answers, 0) + COALESCE(q.priv_answers, 0)) * 5 +
        COALESCE(CASE WHEN fc.stats_synced_at IS NOT NULL THEN fc.cached_likes_count ELSE computed_likes END, 0) * 2 +
        COALESCE(CASE WHEN fc.stats_synced_at IS NOT NULL THEN fc.cached_recasts_count ELSE computed_recasts END, 0) * 3 +
        COALESCE(CASE WHEN fc.stats_synced_at IS NOT NULL THEN fc.cached_replies_count ELSE computed_replies END, 0)
      ) * (1.0 / (1.0 + (julianday('now') - julianday(q.created_at)) / 7.0)) DESC, q.created_at DESC`;
    } else if (sort === 'open') {
      query += ' ORDER BY julianday(open_poll_at) DESC';
    } else {
      // A new poll on an old question brings the question back to the top.
      query += ' ORDER BY MAX(julianday(q.created_at), COALESCE(julianday(last_poll_at), 0)) DESC, q.created_at DESC';
    }

    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await env.DB.prepare(query).bind(...params).all();

    // Fetch avatar URLs for unique FIDs through the Farcaster data providers
    const uniqueFids = [...new Set(
      results
        .map((q: Record<string, unknown>) => q.coiner_fid)
        .filter((fid: unknown): fid is number => Boolean(fid))
    )];

    const fidToAvatarMap = new Map<number, string>();

    if (uniqueFids.length > 0) {
      try {
        const users = await initFarcasterData(env).getUsers(uniqueFids.map(Number));
        users.forEach(user => {
          if (user.pfp_url) fidToAvatarMap.set(user.fid, user.pfp_url);
        });
      } catch (error) {
        console.error('Error fetching avatars:', error);
        // Continue without avatars if fetch fails
      }
    }

    // Get user reactions if authenticated
    const userReactionsMap = new Map<string, { liked: boolean; recasted: boolean }>();

    if (currentUserFid) {
      const castHashes = results
        .map((q: Record<string, unknown>) => q.cast_hash)
        .filter((hash: unknown): hash is string => Boolean(hash));

      if (castHashes.length > 0) {
        const placeholders = castHashes.map(() => '?').join(',');
        const userReactionsQuery = `
          SELECT cast_hash, reaction_type 
          FROM farcaster_reactions 
          WHERE cast_hash IN (${placeholders}) AND reactor_fid = ? AND is_deleted = 0
        `;
        const { results: reactions } = await env.DB.prepare(userReactionsQuery)
          .bind(...castHashes, currentUserFid)
          .all();

        // Build map of cast_hash -> {liked, recasted}
        reactions.forEach((r: any) => {
          const existing = userReactionsMap.get(r.cast_hash) || { liked: false, recasted: false };
          if (r.reaction_type === 'like') existing.liked = true;
          if (r.reaction_type === 'recast') existing.recasted = true;
          userReactionsMap.set(r.cast_hash, existing);
        });
      }
    }

    const parsedResults = results.map((q: Record<string, unknown>) => {
      const userReactions = q.cast_hash ? userReactionsMap.get(q.cast_hash as string) : undefined;
      // Use cached Farcaster stats when available (synced from live API), otherwise fall back to computed stats
      const hasCachedStats = q.stats_synced_at !== null;
      
      // Extract internal fields to exclude from spread
      const {
        cached_likes_count,
        cached_recasts_count,
        cached_replies_count,
        stats_synced_at: _stats_synced_at,
        computed_likes,
        computed_recasts,
        computed_replies,
        cast_hash,
        ...rest
      } = q;

      return {
        ...rest,
        a_options: q.a_options ? JSON.parse(q.a_options as string) : undefined,
        scale_config: q.scale_config ? JSON.parse(q.scale_config as string) : undefined,
        date_config: q.date_config ? JSON.parse(q.date_config as string) : undefined,
        tags: q.tags ? JSON.parse(q.tags as string) : undefined,
        reqs: q.reqs ? JSON.parse(q.reqs as string) : undefined,
        assets: q.assets ? JSON.parse(q.assets as string) : undefined,
        template: Boolean(q.template),
        created_at: new Date(q.created_at as string).getTime(),
        // Map cast_hash to casthash for frontend compatibility
        casthash: cast_hash || undefined,
        // Add engagement data - prefer cached stats from Farcaster API over local-only computed stats
        farcaster_likes: hasCachedStats ? Number(cached_likes_count) || 0 : Number(computed_likes) || 0,
        farcaster_recasts: hasCachedStats ? Number(cached_recasts_count) || 0 : Number(computed_recasts) || 0,
        farcaster_replies: hasCachedStats ? Number(cached_replies_count) || 0 : Number(computed_replies) || 0,
        // Add avatar URL
        coiner_avatar_url: q.coiner_fid ? fidToAvatarMap.get(q.coiner_fid as number) : undefined,
        // Add user-specific reaction data
        user_has_liked: userReactions?.liked || false,
        user_has_recasted: userReactions?.recasted || false,
      };
    });

    return Response.json({
      results: parsedResults,
      limit,
      offset
    });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error listing queries:', e);
    return new Response(`Error listing queries: ${err.message}`, { status: 500 });
  }
}

/**
 * GET /api/queries/:id/forks
 *
 * List questions that have been forked from `id`. Powers the "Variants — N"
 * section on the question detail page.
 */
export async function handleListForks(_request: Request, env: Env, id: string): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT q.id, q.stem, q.type, q.a_options, q.scale_config, q.date_config,
              q.coiner_fname, q.coiner_fid, q.created_at
       FROM question_meta qm
       JOIN queries q ON q.id = qm.question_id
       WHERE qm.forked_from = ?
       ORDER BY qm.created_at DESC
       LIMIT 50`
    ).bind(id).all();

    const forks = (results || []).map((r: any) => ({
      id: r.id,
      stem: r.stem,
      type: r.type,
      a_options: r.a_options ? JSON.parse(r.a_options) : undefined,
      scale_config: r.scale_config ? JSON.parse(r.scale_config) : undefined,
      date_config: r.date_config ? JSON.parse(r.date_config) : undefined,
      coiner_fname: r.coiner_fname ?? undefined,
      coiner_fid: r.coiner_fid ?? undefined,
      created_at: r.created_at ? new Date(r.created_at).getTime() : undefined,
    }));

    return Response.json({ forks });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error listing forks:', e);
    return new Response(`Error listing forks: ${err.message}`, { status: 500 });
  }
}

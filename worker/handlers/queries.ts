import { QueryType } from '../../src/lib/types';
import type { QuerySubmission } from '../../src/lib/types';
import { VectorService } from '../services/VectorService';
import { AIService } from '../services/AIService';
import { AnonAttributionService } from '../services/AnonAttributionService';
import { PointsService } from '../services/PointsService';
import { UserService } from '../services/UserService';
import { TopicService } from '../services/TopicService';
import { generateCompactToken } from '../services/SnapService';
import { anon_id, anon_fid, MAX_Q_LENGTH, MAX_CAST_LENGTH_PRO } from '../../src/lib/consts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

// Cloudflare Workers ExecutionContext for background tasks
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Circled numbers for MC options (① through ⑳)
const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳'];

// Format cast text with answer options for MC questions
function formatCastText(stem: string, type: QueryType, options?: string[]): string {
  if (type !== QueryType.MC || !options || options.length === 0) {
    return stem;
  }
  
  const optionsText = options
    .slice(0, CIRCLED_NUMBERS.length) // Safety limit
    .map((opt, i) => `${CIRCLED_NUMBERS[i]} ${opt}`)
    .join('\n');
  
  return `${stem}\n\n${optionsText}`;
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
  includeEmbed?: boolean
): Promise<{ castWarning?: string }> {
  console.log(`[Farcaster Cast] Starting cast for query ${queryId}`);
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
        const casterUser = await UserService.getByFid(env, casterFid);
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
          const compactToken = await generateCompactToken(queryId, env.QBASE_SECRET);
          embeds.push({ url: `${baseUrl}/snap/question/${queryId}?compact=1&token=${compactToken}` });
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
            const compactToken = await generateCompactToken(queryId, env.QBASE_SECRET);
            embeds.push({ url: `${baseUrl}/snap/question/${queryId}?compact=1&token=${compactToken}` });
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
              const compactToken = await generateCompactToken(queryId, env.QBASE_SECRET);
              embeds.push({ url: `${baseUrl}/snap/question/${queryId}?compact=1&token=${compactToken}` });
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

    // Types that require a Farcaster signer to cast as the user
    const SIGNER_REQUIRED_TYPES = ['text', 'checkbox', 'scale'];
    const isAnon = body.isAnon === true;
    if (SIGNER_REQUIRED_TYPES.includes(body.type) && !isAnon) {
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

    // Process tags with attribution
    let finalTags: string[] = [];

    // Add user-provided tags with user attribution
    if (body.tags && body.tags.length > 0) {
      const userId = body.coiner_id; // FID of the question creator
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

    // FIRST: Quick exact-match check in DB (catches true duplicates immediately, no eventual consistency issues)
    // This is a synchronous check that works even before Vectorize indexes the new question
    const normalizedStem = body.stem.trim().toLowerCase();
    const exactMatchCheck = await env.DB.prepare(
      `SELECT id FROM queries WHERE LOWER(TRIM(stem)) = ? LIMIT 1`
    ).bind(normalizedStem).first();

    if (exactMatchCheck) {
      console.log(`[DUPLICATE CHECK] Exact match found for stem: "${body.stem.substring(0, 50)}..." -> existing ID: ${exactMatchCheck.id}`);
      return new Response(
        JSON.stringify({
          error: 'This exact question already exists',
          existing_id: exactMatchCheck.id,
          similarity: 1.0
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

      // Check for duplicates using the two-threshold system (catches near-duplicates)
      const vectorService2 = VectorService.fromEnv(env);
      const similarResults = await vectorService2.searchSimilar(vector, 'q', 5);

      if (similarResults.length > 0 && similarResults[0].score >= 0.98) {
        return new Response(
          JSON.stringify({
            error: 'A nearly identical question already exists',
            existing_id: similarResults[0].id,
            similarity: similarResults[0].score
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }
        );
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

    // Store real author info for anonymous queries before masking
    const realCoinerId = body.coiner_id;
    const realCoinerFid = body.coiner_fid;
    const isAnonymous = body.isAnon === true;

    // If anonymous, mask the author info with anon bot account
    let displayCoinerId = body.coiner_id;
    let displayCoinerFname = body.coiner_fname || null;
    let displayCoinerFid = body.coiner_fid || null;

    if (isAnonymous) {
      displayCoinerId = anon_id; // Use anonymous DB ID (3)
      displayCoinerFname = '4n0n';
      displayCoinerFid = anon_fid; // Use anonymous FID (514282)
      console.log(`Creating anonymous query ${id} for real author FID ${realCoinerFid}`);
    }

    // Check and deduct QP cost
    const queryCost = body.cost || 0;
    let deductedFromAllowance = 0;
    let deductedFromBalance = 0;
    let deductedUserFid: number | null = null;
    
    if (queryCost > 0) {
      // SECURITY: Use verified FID from auth header (set by worker after authentication)
      // This is the source of truth, not body.coiner_fid which could be manipulated
      const verifiedFidHeader = request.headers.get('X-Verified-FID');

      if (!verifiedFidHeader) {
        console.error('Missing X-Verified-FID header - authentication bypass attempt?');
        return new Response('Authentication error', { status: 401 });
      }

      const userFid = parseInt(verifiedFidHeader, 10);
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
    const tags = finalTags.length > 0 ? JSON.stringify(finalTags) : null;
    const reqs = body.reqs ? JSON.stringify(body.reqs) : null;
    const assets = body.assets ? JSON.stringify(body.assets) : null;
    const taxonomyJson = JSON.stringify(taxonomy);

    // Insert into D1 database
    // For anonymous queries, coiner_id/owner_id/coiner_fid are masked with anon_fid
    const stmt = env.DB.prepare(`
      INSERT INTO queries (
        id, stem, type, a_options, scale_config, cost, created_at,
        coiner_id, owner_id, coiner_fname, coiner_fid,
        token_id, casthash, tags, parent, reqs, assets, template, taxonomy,
        channel_id, pub_answers, priv_answers, comments
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
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
      body.cost || 0,
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
      body.channel_id || null  // Farcaster channel ID
    );

    await stmt.run();

    // ── Dual-write: seed question_meta for Hypersnap data layer ──
    try {
      const nowMs = Date.now();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO question_meta
         (question_id, cast_hash, cast_status, author_fid, is_anon, answer_type_id, value_schema, topic_id, canonical_id, created_at, updated_at)
         VALUES (?, NULL, 'pending', ?, ?, ?, NULL, NULL, NULL, ?, ?)`
      ).bind(
        id,
        displayCoinerFid,
        isAnonymous ? 1 : 0,
        body.type ?? 'text',
        nowMs,
        nowMs,
      ).run();
      console.log(`[DualWrite] Seeded question_meta for ${id}`);
    } catch (metaErr) {
      // Non-fatal — reconciler will pick up orphaned rows
      console.error(`[DualWrite] Failed to seed question_meta for ${id}:`, metaErr);
    }

    // Store the pre-generated vector in Vectorize
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
          coiner_id: body.coiner_id,
          coiner_fid: displayCoinerFid,
          coiner_fname: displayCoinerFname,
          // Note: We don't store avatar URLs here as they can become stale
          // CompactQuestionCard will fetch them dynamically or use dicebear fallback
          options_count: body.a_options?.length || 0
        }
      }], 'q');

      console.log(`Vector stored for query ${id}`);
    } catch (vectorError) {
      // This should be very rare since we already generated the vector successfully
      // But if storage fails, we need to clean up the query AND refund QP
      console.error('CRITICAL: Vector storage failed after query creation:', vectorError);

      // Delete the query we just created
      await env.DB.prepare('DELETE FROM queries WHERE id = ?').bind(id).run();

      // Refund QP if any was deducted - refund to the SAME buckets they came from
      if (queryCost > 0 && deductedUserFid) {
        const pointsService = PointsService.fromEnv(env);
        await pointsService.refundPoints(
          deductedUserFid, 
          deductedFromAllowance, 
          deductedFromBalance, 
          'refund: vector storage failed'
        );
        console.log(`Refunded ${queryCost} QP to user FID ${deductedUserFid}`);
      }

      return new Response(
        'Failed to store query. Please try again.',
        { status: 503 }
      );
    }

    // For anonymous questions, attribution is REQUIRED for governance/accountability
    // Attribution must succeed before we return success - if it fails, rollback everything
    if (isAnonymous) {
      console.log(`[QUERY CREATE] Creating required attribution for anonymous query ${id}`);
      try {
        await AnonAttributionService.createAttribution(env, {
          public_id: id,
          author_id: realCoinerId,
          type: 'question',
        });
        console.log(`[QUERY CREATE] ✅ Attribution created for anonymous query ${id}`);
      } catch (attributionError) {
        console.error(`[QUERY CREATE] ❌ Attribution failed for anonymous query ${id}:`, attributionError);
        
        // ROLLBACK: Delete the query and vector, refund QP
        console.log(`[QUERY CREATE] Rolling back anonymous query ${id} due to attribution failure`);
        
        try {
          // Delete from D1
          await env.DB.prepare('DELETE FROM queries WHERE id = ?').bind(id).run();
          
          // Delete from Vectorize
          const vectorService = VectorService.fromEnv(env);
          await vectorService.deleteVectors([id], 'q');
          
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

    // Background task: Post to Farcaster (non-critical, can fail without affecting question)
    const backgroundTask = async () => {
      try {
        await postQueryToFarcaster(
          env,
          id,
          body.stem,
          body.type,
          body.a_options,
          isAnonymous,
          realCoinerFid,
          body.channel_id,
          body.includeEmbed
        );
        console.log(`[QUERY CREATE] ✅ Background Farcaster cast completed for ${id}`);
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
    return Response.json({
      success: true,
      id,
      message: 'Query created successfully',
      isAnonymous,  // Let frontend know this was anonymous
      castPending: true,  // Frontend knows cast is still in progress
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
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'like' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as computed_likes,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'recast' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as computed_recasts,
        COALESCE(COUNT(DISTINCT frep.id), 0) as computed_replies
      FROM queries q
      LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
      LEFT JOIN farcaster_reactions fr ON fr.cast_hash = fc.cast_hash
      LEFT JOIN farcaster_replies frep ON frep.parent_cast_hash = fc.cast_hash AND frep.is_active = 1
      WHERE q.id = ?
      GROUP BY q.id
    `;

    const query = await env.DB.prepare(queryStr).bind(id).first();

    if (!query) {
      return new Response('Query not found', { status: 404 });
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
    
    const parsedQuery = {
      ...restQuery,
      a_options: query.a_options ? JSON.parse(query.a_options) : undefined,
      scale_config: query.scale_config ? JSON.parse(query.scale_config) : undefined,
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
    const sort = url.searchParams.get('sort') || 'new'; // 'new' or 'popular'

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
        COALESCE(COUNT(DISTINCT frep.id), 0) as computed_replies
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
    } else {
      query += ' ORDER BY q.created_at DESC';
    }

    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await env.DB.prepare(query).bind(...params).all();

    // Fetch avatar URLs for unique FIDs using Neynar
    const uniqueFids = [...new Set(
      results
        .map((q: Record<string, unknown>) => q.coiner_fid)
        .filter((fid: unknown): fid is number => Boolean(fid))
    )];

    const fidToAvatarMap = new Map<number, string>();

    if (uniqueFids.length > 0 && env.NEYNAR_API_KEY) {
      try {
        const { NeynarService } = await import('../../src/services/NeynarService');
        const users = await NeynarService.fetchBulkUsers(
          uniqueFids.map(String),
          env.NEYNAR_API_KEY
        );
        users.forEach(user => {
          fidToAvatarMap.set(Number(user.fid), user.pfp_url);
        });
      } catch (error) {
        console.error('Error fetching avatars from Neynar:', error);
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

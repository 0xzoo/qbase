/**
 * Answers API - Hybrid storage with Q Storage for private data
 * 
 * - Public answers: Stored in D1 (no encryption needed)
 * - Anon answers: Stored in D1 (user_id = anon bot, attribution in Q Storage)
 * - Private answers: Metadata in D1 + encrypted value in Q Storage
 * - Allowlist answers: Metadata in D1 + encrypted value in Q Storage
 * 
 * Architecture: "Server stays ignorant" - encrypted blobs in Q Storage,
 * D1 holds only metadata for queryability. Client-side encryption.
 */

import { AllowlistService } from '../../worker/services/AllowlistService';
import { AuthService } from '../../worker/services/AuthService';
import { QStorageService } from '../../worker/services/QStorageService';
import { PointsService } from '../../worker/services/PointsService';
import { VectorService } from '../../worker/services/VectorService';
import { answer_cost, anon_id, MAX_A_LENGTH } from '../lib/consts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

interface AnswerRequest {
  q_id: string;
  user_id: number; // Injected by worker from auth token
  value: string;   // Plain display text of the answer
  answer_type_id: number; // FK to answer_types table: 1=text, 2=mc, 3=scale, 4=checkbox
  answer_data?: Record<string, unknown>; // Type-specific structured data (indices, ranges, etc.)
  audience: 'Public' | 'Private' | 'Anon' | 'Allowlist';
  allowlist_id?: string; // Reference to named allowlist
  allowlist?: number[]; // One-off FID array
  // Knowledge question fields (optional)
  reasoning?: string; // Explanation/justification for knowledge answers
  topics?: string[]; // Domain tags for knowledge answers
}

export async function handleCreateAnswer(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as AnswerRequest;

    // Validate required fields
    // user_id is required for Public/Private/Allowlist (injected by auth or client)
    // For Anon, user_id is optional — server substitutes anon_id
    if (!body.q_id || !body.value || !body.audience) {
      return new Response('Missing required fields', { status: 400 });
    }
    if (body.audience !== 'Anon' && !body.user_id) {
      return new Response('Missing required fields', { status: 400 });
    }

    // Input Validation
    // 1. Validate q_id (UUID format)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(body.q_id)) {
      return new Response('Invalid q_id format', { status: 400 });
    }

    // 2. Validate value length
    if (body.value.length > MAX_A_LENGTH) {
      return new Response(`Answer value too long (max ${MAX_A_LENGTH} chars)`, { status: 400 });
    }

    // 3. Validate answer_type_id (integer FK to answer_types table)
    const allowedTypeIds = [1, 2, 3, 4]; // TEXT=1, MC=2, SCALE=3, CHECKBOX=4
    if (body.answer_type_id && !allowedTypeIds.includes(body.answer_type_id)) {
      return new Response('Invalid answer_type_id', { status: 400 });
    }

    // 4. Validate audience
    const allowedAudiences = ['Public', 'Private', 'Anon', 'Allowlist'];
    if (!allowedAudiences.includes(body.audience)) {
      return new Response('Invalid audience', { status: 400 });
    }

    // 5. Validate Allowlist-specific fields
    if (body.audience === 'Allowlist') {
      if (!body.allowlist_id && !body.allowlist) {
        return new Response('Allowlist audience requires either allowlist_id or allowlist field', { status: 400 });
      }
      if (body.allowlist && body.allowlist.length > 100) {
        return new Response('One-off allowlists cannot exceed 100 members', { status: 400 });
      }
    }

    // Determine primary_type from the query's taxonomy JSON field and get question owner + cast info
    const query = await env.DB.prepare(
      `SELECT json_extract(q.taxonomy, '$.primary_type') as primary_type, q.coiner_fid, q.owner_id,
              qm.cast_hash, qm.author_fid as cast_author_fid
       FROM queries q
       LEFT JOIN question_meta qm ON qm.question_id = q.id
       WHERE q.id = ?`
    ).bind(body.q_id).first() as { primary_type?: string; coiner_fid?: number; owner_id?: number; cast_hash?: string; cast_author_fid?: number } | null;

    if (!query) {
      return new Response('Question not found', { status: 404 });
    }

    const primary_type = query.primary_type || 'recurring';
    const questionOwnerFid = query.coiner_fid; // FID of the question creator

    // For anon answers, skip user lookup and points — attribution is handled separately
    let answererFid: number | null = null;
    if (body.audience !== 'Anon') {
      // Get answerer's FID from user_id (user_id IS fid after migration)
      const answererRow = await env.DB.prepare(
        'SELECT fid FROM users WHERE fid = ?'
      ).bind(body.user_id).first() as { fid: number } | null;

      if (!answererRow) {
        return new Response('User not found', { status: 404 });
      }

      answererFid = answererRow.fid;

      // Handle points: Deduct from answerer, award to question owner
      const pointsService = PointsService.fromEnv(env);

      // Deduct answer_cost from answerer (deducts from allowance first, then balance)
      const deductResult = await pointsService.deductPoints(
        answererFid,
        answer_cost,
        `answer to question: ${body.q_id.substring(0, 8)}`
      );

      if (!deductResult) {
        // Get current points for error message
        const currentPoints = await pointsService.getPoints(answererFid);
        const totalSpendable = (currentPoints?.allowance || 0) + (currentPoints?.balance || 0);

        return new Response(
          `Insufficient QP. Required: ${answer_cost}, Available: ${totalSpendable}`,
          { status: 402 } // 402 Payment Required
        );
      }

      const { points: updatedPoints } = deductResult;
      console.log(`[Answer Creation] Deducted ${answer_cost} QP from answerer FID ${answererFid}. New state: allowance=${updatedPoints.allowance}, earned=${updatedPoints.earned}, balance=${updatedPoints.balance}`);

      // Award earned points to question owner (if it's not the same person answering their own question)
      if (questionOwnerFid && questionOwnerFid !== answererFid) {
        await pointsService.addEarnedPoints(
          questionOwnerFid,
          answer_cost,
          `earned from answer to question: ${body.q_id.substring(0, 8)}`
        );
        console.log(`[Answer Creation] Awarded ${answer_cost} earned QP to question owner FID ${questionOwnerFid}`);
      } else {
        console.log(`[Answer Creation] No points awarded - answerer is the question owner or owner FID missing`);
      }
    } else {
      console.log(`[Answer Creation] Anon answer — skipping user lookup and points`);
    }

    const answerId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Route based on audience
    try {
      if (body.audience === 'Public') {
        // ── MC append-only: always INSERT, never UPDATE ──
        // Old answers preserved for time-series. Latest row per user is canonical.
        // Only increment pub_answers on first MC answer per user for this question.
        if (body.answer_type_id === 2 && body.user_id) {
          const existing = await env.DB.prepare(
            `SELECT a.id FROM Answers a
             WHERE a.q_id = ? AND a.user_id = ? AND a.answer_type_id = 2`
          ).bind(body.q_id, body.user_id).first() as { id: string } | null;

          // Insert new MC answer (append-only)
          await env.DB.prepare(
            `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type, reasoning, topics)
             VALUES (?, ?, ?, ?, ?, ?, 'Public', ?, ?, ?, ?)`
          ).bind(
            answerId,
            body.q_id,
            body.user_id,
            body.value,
            body.answer_type_id,
            body.answer_data ? JSON.stringify(body.answer_data) : null,
            now,
            primary_type,
            body.reasoning || null,
            body.topics ? JSON.stringify(body.topics) : null,
          ).run();

          // Seed answer_meta
          try {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO answer_meta
               (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
               VALUES (?, ?, NULL, NULL, ?, 'public', ?, ?, NULL, 1, ?)`
            ).bind(
              answerId,
              body.q_id,
              body.user_id,
              null,
              typeof body.value === 'string' ? body.value.slice(0, 500) : null,
              Date.now(),
            ).run();
          } catch (metaErr) {
            console.error('[MC Append] Failed to seed answer_meta:', metaErr);
          }

          // Only increment pub_answers on first answer
          if (!existing) {
            await env.DB.prepare(
              'UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?'
            ).bind(body.q_id).run();
          }

          return Response.json({
            success: true,
            storage: 'd1',
            answerId,
            updated: false,
          });
        }

        // Store Public answers in D1 (includes primary_type for routing)
        const stmt = env.DB.prepare(
          `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type, reasoning, topics) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          answerId,
          body.q_id,
          body.user_id,
          body.value,
          body.answer_type_id,
          body.answer_data ? JSON.stringify(body.answer_data) : null,
          body.audience,
          now,
          primary_type,
          body.reasoning || null,
          body.topics ? JSON.stringify(body.topics) : null
        );

        await stmt.run();

        // ── Dual-write: seed answer_meta for Hypersnap data layer ──
        try {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO answer_meta
             (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
             VALUES (?, ?, NULL, NULL, ?, 'public', ?, ?, NULL, 1, ?)`
          ).bind(
            answerId,
            body.q_id,
            body.user_id,
            null, // storage_ref — not used for public answers
            typeof body.value === 'string' ? body.value.slice(0, 500) : null,
            Date.now(),
          ).run();
          console.log(`[DualWrite] Seeded answer_meta for public answer ${answerId}`);

          // ── Enqueue answer cast to Farcaster ──
          if (query.cast_hash && env.ANSWER_CAST_QUEUE) {
            const castText = typeof body.value === 'string' ? body.value.slice(0, 320) : String(body.value).slice(0, 320);
            const hostname = env.HOSTNAME || 'qbase.tech';
            const baseUrl = hostname.startsWith('http') ? hostname : `https://${hostname}`;
            await env.ANSWER_CAST_QUEUE.send({
              answerId,
              questionId: body.q_id,
              parentCastHash: query.cast_hash,
              parentAuthorFid: query.cast_author_fid || query.coiner_fid || 0,
              signer: 'anon',
              text: castText,
              embedUrl: `${baseUrl}/answer/${answerId}`,
            });
            console.log(`[AnswerCast] Enqueued cast for answer ${answerId}`);
          }
        } catch (metaErr) {
          console.error(`[DualWrite] Failed to seed answer_meta for ${answerId}:`, metaErr);
        }

        // Update answer counts
        await env.DB.prepare(
          `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
        ).bind(body.q_id).run();

        // Generate and store answer embedding for semantic search
        // Include question context for better semantic matching
        try {
          const questionRow = await env.DB.prepare(
            'SELECT stem FROM queries WHERE id = ?'
          ).bind(body.q_id).first() as { stem: string } | null;

          if (questionRow) {
            const vectorService = VectorService.fromEnv(env);
            const embeddingText = `Question: ${questionRow.stem} Answer: ${body.value}`;
            const vector = await vectorService.vectorize(embeddingText);

            await vectorService.addVectors([{
              id: answerId,
              values: vector,
              metadata: {
                q_id: body.q_id,
                user_id: body.user_id,
                audience: 'Public',
                answer_type_id: body.answer_type_id,
                created_at: now,
                primary_type,
              }
            }], 'a');

            console.log(`[Answer Embedding] Stored embedding for public answer ${answerId}`);
          }
        } catch (vectorError) {
          // Log but don't fail - embedding is not critical for answer creation
          console.error('[Answer Embedding] Failed to store embedding:', vectorError);
        }

        return Response.json({
          success: true,
          storage: 'd1',
          answerId,
        });

      } else if (body.audience === 'Anon') {
        // Store Anonymous answers in D1 with anon_id as user_id (publicly visible but anonymous)
        const answerId = crypto.randomUUID();

        await env.DB.prepare(
          `INSERT INTO answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          answerId,
          body.q_id,
          anon_id, // Use anon bot ID as the user_id
          body.value,
          body.answer_type_id,
          body.answer_data ? JSON.stringify(body.answer_data) : null,
          'Anon',
          now,
          primary_type
        ).run();

        // ── Dual-write: seed answer_meta for anon answer ──
        try {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO answer_meta
             (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
             VALUES (?, ?, NULL, NULL, ?, 'anon', NULL, ?, NULL, 0, ?)`
          ).bind(
            answerId,
            body.q_id,
            anon_id,
            typeof body.value === 'string' ? body.value.slice(0, 500) : null,
            Date.now(),
          ).run();
          console.log(`[DualWrite] Seeded answer_meta for anon answer ${answerId}`);
        } catch (metaErr) {
          console.error(`[DualWrite] Failed to seed answer_meta for ${answerId}:`, metaErr);
        }

        // Update public answer count
        await env.DB.prepare(
          `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
        ).bind(body.q_id).run();

        // Create attribution record (non-blocking for speed)
        console.log('[Anon Answer] Creating attribution for answer:', { answerId, author_id: body.user_id, q_id: body.q_id });
        const { AnonAttributionService } = await import('../../worker/services/AnonAttributionService');
        AnonAttributionService.createAttribution(env, {
          public_id: answerId,
          author_id: body.user_id,
          type: 'answer',
        }).then(() => {
          console.log('[Anon Answer] Attribution created successfully for answer:', answerId);
        }).catch(attributionError => {
          console.error('[Anon Answer] Failed to create attribution for anonymous answer:', attributionError);
          // Continue anyway - answer is created, attribution can be retried
        });

        // Generate and store answer embedding for anonymous answers
        try {
          const questionRow = await env.DB.prepare(
            'SELECT stem FROM queries WHERE id = ?'
          ).bind(body.q_id).first() as { stem: string } | null;

          if (questionRow) {
            const vectorService = VectorService.fromEnv(env);
            const embeddingText = `Question: ${questionRow.stem} Answer: ${body.value}`;
            const vector = await vectorService.vectorize(embeddingText);

            await vectorService.addVectors([{
              id: answerId,
              values: vector,
              metadata: {
                q_id: body.q_id,
                user_id: anon_id, // Use anon bot ID to preserve anonymity
                audience: 'Anon',
                answer_type_id: body.answer_type_id,
                created_at: now,
                primary_type,
              }
            }], 'a');

            console.log(`[Answer Embedding] Stored embedding for anonymous answer ${answerId}`);
          }
        } catch (vectorError) {
          console.error('[Answer Embedding] Failed to store embedding for anon answer:', vectorError);
        }

        return Response.json({
          success: true,
          storage: 'd1',
          answerId,
        });

      } else {
        // Store Private and Allowlist answers:
        // 1. Metadata in D1 (for querying/listing)
        // 2. Actual value in Q Storage (encrypted blob)
        const storageKey = `answers/${body.audience.toLowerCase()}/${answerId}`;

        // Store encrypted value in Q Storage
        const qstorage = QStorageService.fromEnv(env);
        const answerPayload = JSON.stringify({
          value: body.value,
          answer_data: body.answer_data,
          reasoning: body.reasoning,
        });

        await qstorage.put(storageKey, answerPayload, {
          'q-id': body.q_id,
          'user-id': String(body.user_id),
          'audience': body.audience,
          'answer-type-id': String(body.answer_type_id),
        }, 'application/json');

        // Store metadata in D1 (value is placeholder, real content in Q Storage)
        await env.DB.prepare(
          `INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, answer_data, audience, created_at, primary_type, storage_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          answerId,
          body.q_id,
          body.user_id,
          '[encrypted]', // placeholder - real value in Q Storage
          body.answer_type_id,
          body.answer_data ? JSON.stringify(body.answer_data) : null,
          body.audience,
          now,
          primary_type,
          `qstorage:${storageKey}`
        ).run();

        // ── Dual-write: seed answer_meta for private/allowlist answer ──
        try {
          const privacyTier = body.audience === 'Allowlist' ? 'allowlist' : 'private';
          await env.DB.prepare(
            `INSERT OR IGNORE INTO answer_meta
             (id, question_id, reply_cast_hash, replied_to_hash, responder_fid, privacy_tier, storage_ref, primary_value, answer_index, pending, created_at)
             VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, 0, ?)`
          ).bind(
            answerId,
            body.q_id,
            body.user_id,
            privacyTier,
            `qstorage:${storageKey}`,
            Date.now(),
          ).run();
          console.log(`[DualWrite] Seeded answer_meta for ${privacyTier} answer ${answerId}`);
        } catch (metaErr) {
          console.error(`[DualWrite] Failed to seed answer_meta for ${answerId}:`, metaErr);
        }

        // Handle allowlist storage
        if (body.audience === 'Allowlist') {
          if (body.allowlist_id) {
            // Store reference to named allowlist
            await env.DB.prepare(
              `INSERT OR IGNORE INTO answer_allowlists (answer_id, allowlist_id) VALUES (?, ?)`
            ).bind(answerId, body.allowlist_id).run();
          }
          // One-off allowlist FIDs stored in answer_data
        }

        // Update private answer count
        await env.DB.prepare(
          `UPDATE queries SET priv_answers = priv_answers + 1 WHERE id = ?`
        ).bind(body.q_id).run();

        return Response.json({
          success: true,
          storage: 'qstorage',
          answerId,
          storageRef: `qstorage:${storageKey}`,
        });
      }
    } catch (storageError) {
      // Refund points if answer creation fails - only for non-anon answers
      console.error('[Answer Creation] Failed to store answer:', storageError);
      if (body.audience !== 'Anon' && answererFid) {
        const pointsService = PointsService.fromEnv(env);
        await pointsService.refundPoints(
          answererFid,
          answer_cost,
          0,
          'refund: answer creation failed'
        );
        if (questionOwnerFid && questionOwnerFid !== answererFid) {
          const ownerPoints = await pointsService.getPoints(questionOwnerFid);
          ownerPoints.earned = Math.max(0, ownerPoints.earned - answer_cost);
          await env.KV_USER_POINTS.put(
            questionOwnerFid.toString(),
            JSON.stringify(ownerPoints)
          );
          console.log(`[Answer Creation] Removed ${answer_cost} earned QP from question owner FID ${questionOwnerFid}`);
        }
      }

      throw storageError; // Re-throw to be caught by outer catch
    }

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error creating answer:', e);
    return new Response(`Error creating answer: ${err.message}`, { status: 500 });
  }
}

/**
 * GET /api/answers/:id - Retrieve a single answer
 * Auth: Required for Private/Allowlist answers, optional for Public/Anon
 */
export async function handleGetAnswer(request: Request, env: Env, answerId: string): Promise<Response> {
  try {
    // Check for optional authentication to include user-specific data
    let requesterFid: number | null = null;
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const authService = AuthService.fromEnv(env, request.url);
      const auth = await authService.verifyAuthHeader(authHeader);
      if (auth.valid && auth.fid) {
        requesterFid = auth.fid;
      }
    }

    // Try D1 first (for Public and Anon answers)
    const answer = await env.DB.prepare(
      `SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash,
              COALESCE(lc.like_count, 0) as like_count
       FROM Answers a
       LEFT JOIN users u ON a.user_id = u.fid
       LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
       LEFT JOIN (
         SELECT answer_id, COUNT(*) as like_count 
         FROM answer_likes 
         GROUP BY answer_id
       ) lc ON lc.answer_id = a.id
       WHERE a.id = ?`
    ).bind(answerId).first();

    if (answer) {
      // Public and Anon answers - return immediately
      if (answer.audience === 'Public' || answer.audience === 'Anon') {
        // Check if user has liked this answer
        let userHasLiked = false;
        if (requesterFid) {
          const userLike = await env.DB.prepare(
            `SELECT 1 FROM answer_likes WHERE answer_id = ? AND user_fid = ?`
          ).bind(answerId, requesterFid).first();
          userHasLiked = !!userLike;
        }

        return Response.json({
          ...answer,
          created_at: new Date(answer.created_at).getTime(),
          like_count: answer.like_count as number,
          user_has_liked: userHasLiked,
          // Parse answer_data JSON string if present
          answer_data: answer.answer_data && typeof answer.answer_data === 'string' 
            ? JSON.parse(answer.answer_data as string) 
            : answer.answer_data,
        });
      }
    }

    // If answer is in D1 but has a storage_ref, fetch value from Q Storage
    if (answer && answer.storage_ref && typeof answer.storage_ref === 'string') {
      // Private/Allowlist answer - requires authentication
      const authService = AuthService.fromEnv(env, request.url);
      const auth = await authService.verifyAuthHeader(request.headers.get('Authorization'));

      if (!auth.valid || !auth.fid) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get requester's internal user ID
      const userRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
        .bind(auth.fid)
        .first() as { fid: number } | null;

      if (!userRow) {
        return new Response('User not found', { status: 404 });
      }

      const requesterId = userRow.fid;

      // Private answers - only the author can view
      if (answer.audience === 'Private') {
        if (answer.user_id !== requesterId) {
          return new Response('Forbidden', { status: 403 });
        }
      }

      // Allowlist answers - check if requester is author or in allowlist
      if (answer.audience === 'Allowlist') {
        const isAuthor = answer.user_id === requesterId;

        if (!isAuthor) {
          // Check allowlist membership via answer_allowlists table
          const allowlistRef = await env.DB.prepare(
            'SELECT allowlist_id FROM answer_allowlists WHERE answer_id = ?'
          ).bind(answerId).first() as { allowlist_id: string } | null;

          if (allowlistRef) {
            const members = await AllowlistService.getMembers(env, allowlistRef.allowlist_id);
            if (!members.includes(requesterId)) {
              return new Response('Forbidden', { status: 403 });
            }
          } else {
            // Check one-off allowlist from answer_data
            const answerData = answer.answer_data && typeof answer.answer_data === 'string'
              ? JSON.parse(answer.answer_data as string)
              : answer.answer_data;
            const allowlistFids = answerData?.allowlist || [];
            if (!allowlistFids.includes(auth.fid)) {
              return new Response('Forbidden', { status: 403 });
            }
          }
        }
      }

      // Fetch actual value from Q Storage
      const storageKey = (answer.storage_ref as string).replace('qstorage:', '');
      try {
        const qstorage = QStorageService.fromEnv(env);
        const stored = await qstorage.get(storageKey);

        if (stored) {
          const payload = JSON.parse(new TextDecoder().decode(stored.data));

          return Response.json({
            ...answer,
            value: payload.value,
            answer_data: payload.answer_data || (answer.answer_data && typeof answer.answer_data === 'string'
              ? JSON.parse(answer.answer_data as string)
              : answer.answer_data),
            reasoning: payload.reasoning,
            created_at: new Date(answer.created_at as string).getTime(),
            like_count: answer.like_count as number || 0,
            user_has_liked: false,
            storage_ref: undefined, // don't expose internal ref
          });
        }
      } catch (qsError) {
        console.error('[QStorage] Error fetching answer value:', qsError);
      }

      // Q Storage fetch failed - return metadata without value
      return Response.json({
        ...answer,
        value: '[content unavailable]',
        created_at: new Date(answer.created_at as string).getTime(),
        storage_ref: undefined,
      });
    }

    if (!answer) {
      return new Response('Answer not found', { status: 404 });
    }

    return new Response('Answer not found', { status: 404 });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error fetching answer:', e);
    return new Response(`Error fetching answer: ${err.message}`, { status: 500 });
  }
}

/**
 * GET /api/queries/:q_id/answers - List answers for a query
 * Auth: Optional - affects which answers are visible
 * Query params:
 *   - audience: Filter by audience type (default: Public,Anon)
 *   - limit: Results per page (default: 20, max: 100)
 *   - offset: Pagination offset (default: 0)
 */
export async function handleListAnswers(request: Request, env: Env, queryId: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const audienceParam = url.searchParams.get('audience') || 'Public,Anon';
    const audiences = audienceParam.split(',').map(a => a.trim());

    // Verify the query exists
    const query = await env.DB.prepare('SELECT id FROM queries WHERE id = ?')
      .bind(queryId)
      .first();

    if (!query) {
      return new Response('Query not found', { status: 404 });
    }

    let requesterId: number | null = null;

    // Check authentication (optional)
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const authService = AuthService.fromEnv(env, request.url);
      const auth = await authService.verifyAuthHeader(authHeader);

      if (auth.valid && auth.fid) {
        const userRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
          .bind(auth.fid)
          .first() as { fid: number } | null;

        if (userRow) {
          requesterId = userRow.fid;
        }
      }
    }

    const results: Array<Record<string, unknown>> = [];

    // Get the requester's FID for checking user_has_liked
    let requesterFid: number | null = null;
    if (requesterId) {
      const requesterRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
        .bind(requesterId)
        .first() as { fid: number } | null;
      if (requesterRow) {
        requesterFid = requesterRow.fid;
      }
    }

    // Fetch Public and Anon answers from D1
    const d1Audiences = audiences.filter(a => ['Public', 'Anon'].includes(a));
    let publicAnonTotal = 0;
    let publicAnonRowCount = 0;
    if (d1Audiences.length > 0) {
      const placeholders = d1Audiences.map(() => '?').join(',');

      // Count total unique responders (for display)
      const distinctResult = await env.DB.prepare(
        `SELECT COUNT(DISTINCT user_id) as count FROM Answers WHERE q_id = ? AND audience IN (${placeholders})`
      ).bind(queryId, ...d1Audiences).first() as { count: number } | null;
      publicAnonTotal = distinctResult?.count ?? 0;

      // Count total rows (for pagination — offset moves through rows, not distinct users)
      const rowCountResult = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM Answers WHERE q_id = ? AND audience IN (${placeholders})`
      ).bind(queryId, ...d1Audiences).first() as { count: number } | null;
      publicAnonRowCount = rowCountResult?.count ?? 0;

      const d1Answers = await env.DB.prepare(`
        SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash,
               COALESCE(lc.like_count, 0) as like_count
        FROM Answers a
        LEFT JOIN users u ON a.user_id = u.fid
        LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
        LEFT JOIN (
          SELECT answer_id, COUNT(*) as like_count 
          FROM answer_likes 
          GROUP BY answer_id
        ) lc ON lc.answer_id = a.id
        WHERE a.q_id = ? AND a.audience IN (${placeholders})
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?
      `).bind(queryId, ...d1Audiences, limit, offset).all();

      // If user is authenticated, check which answers they've liked
      let userLikedAnswerIds = new Set<string>();
      if (requesterFid && d1Answers.results.length > 0) {
        const answerIds = d1Answers.results.map((a: Record<string, unknown>) => a.id as string);
        const likePlaceholders = answerIds.map(() => '?').join(',');
        const userLikes = await env.DB.prepare(`
          SELECT answer_id FROM answer_likes 
          WHERE user_fid = ? AND answer_id IN (${likePlaceholders})
        `).bind(requesterFid, ...answerIds).all();
        userLikedAnswerIds = new Set(userLikes.results.map((l: Record<string, unknown>) => l.answer_id as string));
      }

      results.push(...d1Answers.results.map((a: Record<string, unknown>) => ({
        ...a,
        created_at: new Date(a.created_at as string).getTime(),
        like_count: a.like_count as number,
        user_has_liked: userLikedAnswerIds.has(a.id as string),
        // Parse answer_data JSON string if present
        answer_data: a.answer_data && typeof a.answer_data === 'string' 
          ? JSON.parse(a.answer_data as string) 
          : a.answer_data,
      })));
    }

    // Check anon answer attributions to mark user's own anon answers
    if (requesterId && audiences.includes('Anon')) {
      try {
        const { AnonAttributionService } = await import('../../worker/services/AnonAttributionService');
        const userAnonContent = await AnonAttributionService.getUserAnonymousContent(env, requesterId);

        // Filter for answers only and create a set of answer IDs
        const ownAnonAnswerIds = new Set(
          userAnonContent
            .filter((attr) => attr.type === 'answer')
            .map((attr) => attr.public_id)
        );

        // Mark the user's own anon answers in the results
        results.forEach((result) => {
          if (result.audience === 'Anon' && ownAnonAnswerIds.has(result.id as string)) {
            result.is_own_anon = true;
          }
        });
      } catch (error) {
        console.error('Error checking anon answer attributions:', error);
        // Non-critical, continue without marking own anon answers
      }
    }

    // Fetch Private and Allowlist answers from D1 + Q Storage
    const needsPrivate = audiences.some(a => ['Private', 'Allowlist'].includes(a));

    if (needsPrivate && requesterId) {
      try {
        const privateAudiences = audiences.filter(a => ['Private', 'Allowlist'].includes(a));
        const placeholders2 = privateAudiences.map(() => '?').join(',');

        // For Private: only show user's own answers
        // For Allowlist: show all (access control checked per-answer)
        const privateAnswers = await env.DB.prepare(`
          SELECT a.*, u.fname as user_fname, u.fid as user_fid
          FROM Answers a
          LEFT JOIN users u ON a.user_id = u.fid
          WHERE a.q_id = ? AND a.audience IN (${placeholders2})
            AND (a.audience != 'Private' OR a.user_id = ?)
          ORDER BY a.created_at DESC
          LIMIT ? OFFSET ?
        `).bind(queryId, ...privateAudiences, requesterId, limit, offset).all();

        const qstorage = QStorageService.fromEnv(env);

        for (const pa of privateAnswers.results as Record<string, unknown>[]) {

          // Fetch actual value from Q Storage if storage_ref exists
          let value = pa.value as string;
          let answerData = pa.answer_data && typeof pa.answer_data === 'string'
            ? JSON.parse(pa.answer_data as string)
            : pa.answer_data;

          if (pa.storage_ref && typeof pa.storage_ref === 'string') {
            try {
              const storageKey = (pa.storage_ref as string).replace('qstorage:', '');
              const stored = await qstorage.get(storageKey);
              if (stored) {
                const payload = JSON.parse(new TextDecoder().decode(stored.data));
                value = payload.value || value;
                answerData = payload.answer_data || answerData;
              }
            } catch (fetchErr) {
              console.error(`[QStorage] Failed to fetch answer ${pa.id}:`, fetchErr);
              value = '[content unavailable]';
            }
          }

          results.push({
            ...pa,
            value,
            answer_data: answerData,
            created_at: new Date(pa.created_at as string).getTime(),
            storage_ref: undefined, // don't expose internal ref
          });
        }
      } catch (error) {
        console.error('Error fetching private/allowlist answers:', error);
        // Don't fail the whole request — just log and continue with D1 results
      }
    }

    // Sort by created_at descending
    results.sort((a, b) => {
      const aTime = typeof a.created_at === 'number' ? a.created_at : 0;
      const bTime = typeof b.created_at === 'number' ? b.created_at : 0;
      return bTime - aTime;
    });

    const hasMore = results.length >= limit && (offset + limit) < publicAnonRowCount;
    return Response.json({
      results: results.slice(0, limit),
      query_id: queryId,
      limit,
      offset,
      total: publicAnonTotal,
      has_more: hasMore,
    });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error listing answers:', e);
    return new Response(`Error listing answers: ${err.message}`, { status: 500 });
  }
}


/**
 * GET /api/users/:fid/answers - Get user's existing answer(s)
 * - If q_id provided: Get answer for that specific question
 * - If q_id missing: List all public answers by this user
 */
export async function handleGetUserAnswers(
  request: Request,
  env: Env,
  fid: string
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const qId = url.searchParams.get('q_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    // Resolve FID to internal user ID
    const fidNum = parseInt(fid);
    if (isNaN(fidNum)) {
      return new Response('Invalid FID', { status: 400 });
    }

    const userRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
      .bind(fidNum)
      .first() as { fid: number } | null;

    if (!userRow) {
      if (qId) {
        // User doesn't exist yet - no answer for specific question
        return Response.json({
          primary_type: 'identity',
          answer: null
        });
      } else {
        // User doesn't exist - empty list
        return Response.json({
          results: [],
          limit,
          offset,
          total: 0
        });
      }
    }

    const userId = userRow.fid;

    // CASE 1: Get answers for a specific question (existing logic)
    if (qId) {
      // Get question to determine its type
      const question = await env.DB.prepare(
        'SELECT json_extract(taxonomy, \'$.primary_type\') as primary_type FROM queries WHERE id = ?'
      ).bind(qId).first() as { primary_type?: string } | null;

      if (!question) {
        return new Response('Question not found', { status: 404 });
      }

      const primaryType = question.primary_type || 'identity';

      if (primaryType === 'identity') {
        // For identity questions, check D1 for Public answers
        const publicAnswer = await env.DB.prepare(`
          SELECT a.*, fc.cast_hash as casthash
          FROM Answers a
          LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
          WHERE a.q_id = ? AND a.user_id = ? AND a.audience = 'Public'
          ORDER BY a.created_at DESC LIMIT 1
        `).bind(qId, userId).first();

        if (publicAnswer) {
          return Response.json({
            primary_type: 'identity',
            answer: {
              ...publicAnswer,
              created_at: new Date(publicAnswer.created_at).getTime(),
              // Parse answer_data JSON string if present
              answer_data: publicAnswer.answer_data && typeof publicAnswer.answer_data === 'string' 
                ? JSON.parse(publicAnswer.answer_data as string) 
                : publicAnswer.answer_data,
            }
          });
        }

        // Check D1 for Private/Allowlist answers (now stored in D1 + Q Storage)
        try {
          const privateAnswer = await env.DB.prepare(
            `SELECT a.* FROM Answers a WHERE a.q_id = ? AND a.user_id = ? AND a.audience IN ('Private', 'Allowlist')`
          ).bind(qId, userId).first();

          if (privateAnswer) {
            // Fetch actual value from Q Storage if storage_ref exists
            let value = privateAnswer.value as string;
            let answerData = privateAnswer.answer_data && typeof privateAnswer.answer_data === 'string'
              ? JSON.parse(privateAnswer.answer_data as string)
              : privateAnswer.answer_data;

            if (privateAnswer.storage_ref && typeof privateAnswer.storage_ref === 'string') {
              try {
                const qstorage = QStorageService.fromEnv(env);
                const storageKey = (privateAnswer.storage_ref as string).replace('qstorage:', '');
                const stored = await qstorage.get(storageKey);
                if (stored) {
                  const payload = JSON.parse(new TextDecoder().decode(stored.data));
                  value = payload.value || value;
                  answerData = payload.answer_data || answerData;
                }
              } catch (qsErr) {
                console.error('[QStorage] Error fetching private answer:', qsErr);
              }
            }

            return Response.json({
              primary_type: 'identity',
              answer: {
                id: privateAnswer.id,
                q_id: privateAnswer.q_id,
                user_id: userId,
                value,
                answer_type_id: privateAnswer.answer_type_id,
                answer_data: answerData,
                audience: privateAnswer.audience,
                created_at: new Date(privateAnswer.created_at as string).getTime(),
              }
            });
          }
        } catch (error) {
          console.error('Error fetching Private/Allowlist from D1:', error);
        }

        // Check for user's own Anon answers via attribution in D1
        try {
          const { AnonAttributionService } = await import('../../worker/services/AnonAttributionService');
          const userAnonContent = await AnonAttributionService.getUserAnonymousContent(env, userId);
          const anonAnswerAttrs = userAnonContent.filter((attr) => attr.type === 'answer');

          for (const attr of anonAnswerAttrs) {
            // Check if this anon answer is for the target question
            const anonAnswer = await env.DB.prepare(
              'SELECT * FROM Answers WHERE id = ? AND q_id = ?'
            ).bind(attr.public_id, qId).first();

            if (anonAnswer) {
              return Response.json({
                primary_type: 'identity',
                answer: {
                  id: anonAnswer.id,
                  q_id: anonAnswer.q_id,
                  user_id: userId,
                  value: anonAnswer.value,
                  answer_type_id: anonAnswer.answer_type_id,
                  answer_data: anonAnswer.answer_data && typeof anonAnswer.answer_data === 'string'
                    ? JSON.parse(anonAnswer.answer_data as string)
                    : anonAnswer.answer_data,
                  audience: anonAnswer.audience,
                  created_at: new Date(anonAnswer.created_at as string).getTime(),
                  is_own_anon: true,
                }
              });
            }
          }
        } catch (error) {
          console.error('[User Answers] Error fetching Anon attributions:', error);
        }

        // No answer found
        return Response.json({
          primary_type: 'identity',
          answer: null
        });

      } else if (primaryType === 'knowledge') {
        // For knowledge questions, return user's own answer + ALL community answers

        // Get user's own public answer (if any)
        const myPublicAnswer = await env.DB.prepare(`
          SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash
          FROM Answers a
          LEFT JOIN users u ON a.user_id = u.fid
          LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
          WHERE a.q_id = ? AND a.user_id = ? AND a.audience = 'Public'
        `).bind(qId, userId).first();

        let myAnswer: Record<string, unknown> | null = null;
        if (myPublicAnswer) {
          myAnswer = {
            ...myPublicAnswer,
            created_at: new Date(myPublicAnswer.created_at).getTime(),
            // Parse answer_data JSON string if present
            answer_data: myPublicAnswer.answer_data && typeof myPublicAnswer.answer_data === 'string' 
              ? JSON.parse(myPublicAnswer.answer_data as string) 
              : myPublicAnswer.answer_data,
          };
        }

        // Check D1 for user's Private/Allowlist answer (now stored in D1 + Q Storage)
        if (!myAnswer) {
          try {
            const privateAnswer = await env.DB.prepare(
              `SELECT * FROM Answers WHERE q_id = ? AND user_id = ? AND audience IN ('Private', 'Allowlist')`
            ).bind(qId, userId).first();

            if (privateAnswer) {
              let value = privateAnswer.value as string;
              let answerData = privateAnswer.answer_data && typeof privateAnswer.answer_data === 'string'
                ? JSON.parse(privateAnswer.answer_data as string)
                : privateAnswer.answer_data;

              if (privateAnswer.storage_ref && typeof privateAnswer.storage_ref === 'string') {
                try {
                  const qstorage = QStorageService.fromEnv(env);
                  const storageKey = (privateAnswer.storage_ref as string).replace('qstorage:', '');
                  const stored = await qstorage.get(storageKey);
                  if (stored) {
                    const payload = JSON.parse(new TextDecoder().decode(stored.data));
                    value = payload.value || value;
                    answerData = payload.answer_data || answerData;
                  }
                } catch (qsErr) {
                  console.error('[QStorage] Error fetching private answer:', qsErr);
                }
              }

              myAnswer = {
                id: privateAnswer.id,
                q_id: privateAnswer.q_id,
                user_id: userId,
                value,
                answer_type_id: privateAnswer.answer_type_id,
                answer_data: answerData,
                audience: privateAnswer.audience,
                created_at: new Date(privateAnswer.created_at as string).getTime(),
              };
            }

            // Check Anon via attribution (anon answers are in D1)
            if (!myAnswer) {
              const { AnonAttributionService } = await import('../../worker/services/AnonAttributionService');
              const userAnonContent = await AnonAttributionService.getUserAnonymousContent(env, userId);
              for (const attr of userAnonContent.filter(a => a.type === 'answer')) {
                const anonAnswer = await env.DB.prepare(
                  'SELECT * FROM Answers WHERE id = ? AND q_id = ?'
                ).bind(attr.public_id, qId).first();
                if (anonAnswer) {
                  myAnswer = {
                    id: anonAnswer.id,
                    q_id: anonAnswer.q_id,
                    user_id: userId,
                    value: anonAnswer.value,
                    answer_type_id: anonAnswer.answer_type_id,
                    answer_data: anonAnswer.answer_data && typeof anonAnswer.answer_data === 'string'
                      ? JSON.parse(anonAnswer.answer_data as string)
                      : anonAnswer.answer_data,
                    audience: anonAnswer.audience,
                    created_at: new Date(anonAnswer.created_at as string).getTime(),
                    is_own_anon: true,
                  };
                  break;
                }
              }
            }
          } catch (error) {
            console.error('Error fetching user knowledge answer:', error);
          }
        }

        // Get ALL community answers (public + anon)
        const communityAnswers: Array<Record<string, unknown>> = [];

        // Fetch public answers
        const publicAnswers = await env.DB.prepare(`
          SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash
          FROM Answers a
          LEFT JOIN users u ON a.user_id = u.fid
          LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
          WHERE a.q_id = ? AND a.audience = 'Public'
          ORDER BY a.created_at DESC
          LIMIT 50
        `).bind(qId).all();

        communityAnswers.push(...publicAnswers.results.map((a: Record<string, unknown>) => ({
          ...a,
          created_at: new Date(a.created_at as string).getTime(),
          is_mine: a.user_id === userId,
          // Parse answer_data JSON string if present
          answer_data: a.answer_data && typeof a.answer_data === 'string' 
            ? JSON.parse(a.answer_data as string) 
            : a.answer_data,
        })));

        // Fetch anonymous answers from D1 (anon answers stored in D1 with anon_id)
        const anonAnswers = await env.DB.prepare(`
          SELECT a.* FROM Answers a
          WHERE a.q_id = ? AND a.audience = 'Anon'
          ORDER BY a.created_at DESC
          LIMIT 50
        `).bind(qId).all();

        communityAnswers.push(...anonAnswers.results.map((a: Record<string, unknown>) => ({
          id: a.id,
          q_id: a.q_id,
          user_id: null,
          user_fname: 'Anonymous',
          user_fid: null,
          value: a.value,
          answer_type_id: a.answer_type_id,
          answer_data: a.answer_data && typeof a.answer_data === 'string'
            ? JSON.parse(a.answer_data as string)
            : a.answer_data,
          audience: a.audience,
          created_at: new Date(a.created_at as string).getTime(),
          is_mine: false,
        })));

        // Sort by created_at descending
        communityAnswers.sort((a, b) => (b.created_at as number) - (a.created_at as number));

        return Response.json({
          primary_type: 'knowledge',
          my_answer: myAnswer,
          community_answers: communityAnswers,
          total: communityAnswers.length,
          has_answered: myAnswer !== null
        });

      } else {
        // For temporal questions (recurring/prospective), get all answers
        const publicAnswers = await env.DB.prepare(`
          SELECT a.*, fc.cast_hash as casthash
          FROM Answers a
          LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
          WHERE a.q_id = ? AND a.user_id = ?
          ORDER BY a.created_at DESC
        `).bind(qId, userId).all();

        const answers: Array<Record<string, unknown>> = publicAnswers.results.map((a: any) => ({
          ...a,
          created_at: new Date(a.created_at).getTime(),
          // Parse answer_data JSON string if present
          answer_data: a.answer_data && typeof a.answer_data === 'string' 
            ? JSON.parse(a.answer_data as string) 
            : a.answer_data,
        }));

        // Also fetch user's anon answers for this question via attribution
        try {
          const { AnonAttributionService } = await import('../../worker/services/AnonAttributionService');
          const userAnonContent = await AnonAttributionService.getUserAnonymousContent(env, userId);
          for (const attr of userAnonContent.filter(a => a.type === 'answer')) {
            const anonAnswer = await env.DB.prepare(
              'SELECT * FROM Answers WHERE id = ? AND q_id = ?'
            ).bind(attr.public_id, qId).first();
            if (anonAnswer) {
              answers.push({
                id: anonAnswer.id,
                q_id: anonAnswer.q_id,
                user_id: userId,
                value: anonAnswer.value,
                answer_type_id: anonAnswer.answer_type_id,
                answer_data: anonAnswer.answer_data && typeof anonAnswer.answer_data === 'string'
                  ? JSON.parse(anonAnswer.answer_data as string)
                  : anonAnswer.answer_data,
                audience: anonAnswer.audience,
                created_at: new Date(anonAnswer.created_at as string).getTime(),
                is_own_anon: true,
              });
            }
          }
        } catch (error) {
          console.error('Error fetching Anon attributions for temporal question:', error);
        }

        // Sort by created_at descending
        answers.sort((a, b) => (b.created_at as number) - (a.created_at as number));

        return Response.json({
          primary_type: primaryType,
          answers,
          count: answers.length
        });
      }
    }

    // CASE 2: List all public answers by this user
    else {

      // Get all public answers joined with query info
      const publicAnswers = await env.DB.prepare(`
        SELECT 
          a.*, 
          q.stem as query_stem,
          q.type as query_type, 
          q.scale_config,
          q.a_options,
          fc.cast_hash as casthash
        FROM Answers a
        JOIN queries q ON a.q_id = q.id
        LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
        WHERE a.user_id = ? AND a.audience = 'Public'
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?
      `).bind(userId, limit, offset).all();

      const results = publicAnswers.results.map((a: any) => ({
        ...a,
        a_options: a.a_options ? JSON.parse(a.a_options) : undefined,
        scale_config: a.scale_config ? JSON.parse(a.scale_config) : undefined,
        created_at: new Date(a.created_at).getTime(),
        // Parse answer_data JSON string if present
        answer_data: a.answer_data && typeof a.answer_data === 'string' 
          ? JSON.parse(a.answer_data as string) 
          : a.answer_data,
      }));

      return Response.json({
        results,
        limit,
        offset,
        fid: fidNum
      });
    }

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error getting user answers:', e);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }

}

/**
 * PUT /api/answers/:id - Update an existing identity answer
 * Auth: Required - can only update your own answers
 */
export async function handleUpdateAnswer(
  request: Request,
  env: Env,
  answerId: string
): Promise<Response> {
  try {
    // Verify authentication
    const authService = AuthService.fromEnv(env, request.url);
    const auth = await authService.verifyAuthHeader(request.headers.get('Authorization'));

    if (!auth.valid || !auth.fid) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Get requester's internal user ID
    const userRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
      .bind(auth.fid)
      .first() as { fid: number } | null;

    if (!userRow) {
      return new Response('User not found', { status: 404 });
    }

    const userId = userRow.fid;

    const body = await request.json() as {
      value: string;   // JSON string: {"text":...}, {"index":...}, {"indices":...}, {"value":...}
      audience: 'Public' | 'Private' | 'Anon' | 'Allowlist';
      answer_type_id: number; // FK to answer_types table: 1=text, 2=mc, 3=scale, 4=checkbox
      allowlist_id?: string;
      allowlist?: number[];
      // Knowledge question fields (optional)
      reasoning?: string;
      topics?: string[];
    };

    // Validate required fields
    if (!body.value || !body.audience || !body.answer_type_id) {
      return new Response('Missing required fields', { status: 400 });
    }

    // Check if answer exists in D1 (Public answers)
    const existingAnswer = await env.DB.prepare(
      'SELECT * FROM Answers WHERE id = ?'
    ).bind(answerId).first();

    if (existingAnswer) {
      // Verify ownership
      if (existingAnswer.user_id !== userId) {
        return new Response('Forbidden: You can only update your own answers', { status: 403 });
      }

      // Check if this is a predictive answer (immutable)
      const question = await env.DB.prepare(
        'SELECT json_extract(taxonomy, \'$.primary_type\') as primary_type FROM queries WHERE id = ?'
      ).bind(existingAnswer.q_id).first() as { primary_type?: string } | null;

      if (question?.primary_type === 'predictive') {
        return new Response('Predictive answers cannot be edited after submission', { status: 403 });
      }

      const now = new Date().toISOString();

      // If staying public, update in D1
      if (body.audience === 'Public') {
        await env.DB.prepare(`
          UPDATE Answers 
          SET value = ?, answer_type_id = ?, updated_at = ?, reasoning = ?, topics = ?
          WHERE id = ?
        `).bind(
          body.value,
          body.answer_type_id,
          now,
          body.reasoning || null,
          body.topics ? JSON.stringify(body.topics) : null,
          answerId
        ).run();

        return Response.json({
          success: true,
          answerId,
          message: 'Answer updated successfully'
        });
      } else {
        // Moving from Public to Private/Anon/Allowlist
        // Moving from Public to Private/Anon/Allowlist
        const now2 = new Date().toISOString();

        if (body.audience === 'Anon') {
          // Moving to Anon: update in D1 with anon user_id
          await env.DB.prepare(`
            UPDATE Answers SET value = ?, answer_type_id = ?, audience = 'Anon', user_id = ?, updated_at = ?
            WHERE id = ?
          `).bind(body.value, body.answer_type_id, anon_id, now2, answerId).run();
        } else {
          // Moving to Private/Allowlist: store value in Q Storage, update D1
          const storageKey = `answers/${body.audience.toLowerCase()}/${answerId}`;
          const qstorage = QStorageService.fromEnv(env);
          await qstorage.put(storageKey, JSON.stringify({
            value: body.value,
            answer_data: null,
            reasoning: body.reasoning,
          }), { 'audience': body.audience }, 'application/json');

          await env.DB.prepare(`
            UPDATE Answers SET value = '[encrypted]', answer_type_id = ?, audience = ?, updated_at = ?, storage_ref = ?
            WHERE id = ?
          `).bind(body.answer_type_id, body.audience, now2, `qstorage:${storageKey}`, answerId).run();

          // Decrement pub, increment priv
          await env.DB.prepare(
            'UPDATE queries SET pub_answers = pub_answers - 1, priv_answers = priv_answers + 1 WHERE id = ?'
          ).bind(existingAnswer.q_id).run();
        }

        return Response.json({
          success: true,
          answerId,
          storage: 'qstorage',
          message: 'Answer audience changed successfully'
        });
      }
    }

    // Answer not found in D1 — doesn't exist
    return new Response('Answer not found', { status: 404 });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error updating answer:', e);
    return new Response(`Error updating answer: ${err.message}`, { status: 500 });
  }
}

/**
 * GET /api/answers - List recent answers (Public-only for now global feed)
 * Query params:
 *   - limit: Results per page (default: 20, max: 100)
 *   - offset: Pagination offset (default: 0)
 *   - audience: Filter by audience type (default: Public,Anon)
 */
export async function handleListAllAnswers(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const audienceParam = url.searchParams.get('audience') || 'Public,Anon';
    const audiences = audienceParam.split(',').map(a => a.trim());

    // Only allow Public and Anon answers for the global feed
    // (Private/Allowlist require context/auth we don't handle efficiently here yet)
    const allowedAudiences = audiences.filter(a => ['Public', 'Anon'].includes(a));

    if (allowedAudiences.length === 0) {
      return Response.json({
        results: [],
        limit,
        offset,
        total: 0
      });
    }

    const placeholders = allowedAudiences.map(() => '?').join(',');

    // Check for optional authentication to include user-specific data (likes)
    let requesterId: number | null = null;
    let requesterFid: number | null = null;

    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const authService = AuthService.fromEnv(env, request.url);
      const auth = await authService.verifyAuthHeader(authHeader);

      if (auth.valid && auth.fid) {
        const userRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
          .bind(auth.fid)
          .first() as { fid: number } | null;

        if (userRow) {
          requesterId = userRow.fid;
          requesterFid = userRow.fid;
        }
      }
    }

    // Fetch Public and Anon answers from D1 with question context
    // We join with queries to get the question stem (context)
    const d1Answers = await env.DB.prepare(`
      SELECT a.*, u.fname as user_fname, u.fid as user_fid, 
             q.stem as question_stem,
             fc.cast_hash as casthash,
             COALESCE(lc.like_count, 0) as like_count
      FROM Answers a
      JOIN queries q ON a.q_id = q.id
      LEFT JOIN users u ON a.user_id = u.fid
      LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
      LEFT JOIN (
        SELECT answer_id, COUNT(*) as like_count 
        FROM answer_likes 
        GROUP BY answer_id
      ) lc ON lc.answer_id = a.id
      WHERE a.audience IN (${placeholders})
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...allowedAudiences, limit, offset).all();

    // If user is authenticated, check which answers they've liked
    let userLikedAnswerIds = new Set<string>();
    if (requesterFid && d1Answers.results.length > 0) {
      const answerIds = d1Answers.results.map((a: Record<string, unknown>) => a.id as string);
      const likePlaceholders = answerIds.map(() => '?').join(',');
      const userLikes = await env.DB.prepare(`
        SELECT answer_id FROM answer_likes 
        WHERE user_fid = ? AND answer_id IN (${likePlaceholders})
      `).bind(requesterFid, ...answerIds).all();
      userLikedAnswerIds = new Set(userLikes.results.map((l: Record<string, unknown>) => l.answer_id as string));
    }

    const results = d1Answers.results.map((a: Record<string, unknown>) => ({
      ...a,
      created_at: new Date(a.created_at as string).getTime(),
      like_count: a.like_count as number,
      user_has_liked: userLikedAnswerIds.has(a.id as string),
      // Parse answer_data JSON string if present
      answer_data: a.answer_data && typeof a.answer_data === 'string' 
        ? JSON.parse(a.answer_data as string) 
        : a.answer_data,
    }));

    // Check anon answer attributions to mark user's own anon answers
    if (requesterId && allowedAudiences.includes('Anon')) {
      try {
        const { AnonAttributionService } = await import('../../worker/services/AnonAttributionService');
        const userAnonContent = await AnonAttributionService.getUserAnonymousContent(env, requesterId);

        // Filter for answers only and create a set of answer IDs
        const ownAnonAnswerIds = new Set(
          userAnonContent
            .filter((attr) => attr.type === 'answer')
            .map((attr) => attr.public_id)
        );

        // Mark the user's own anon answers in the results
        results.forEach((result: any) => {
          if (result.audience === 'Anon' && ownAnonAnswerIds.has(result.id as string)) {
            result.is_own_anon = true;
          }
        });
      } catch (error) {
        console.error('Error checking anon answer attributions:', error);
      }
    }

    return Response.json({
      results,
      limit,
      offset,
      total: results.length // Approximate for infinite scroll
    });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error listing all answers:', e);
    return new Response(`Error listing all answers: ${err.message}`, { status: 500 });
  }
}

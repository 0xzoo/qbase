/**
 * Answers API - Using Nillion for encrypted answers via proxy
 * 
 * - Public answers: Stored in D1 (no encryption needed)
 * - Private answers: Stored in Nillion (encrypted)
 * - Anon answers: Stored in Nillion (user_id encrypted, value plain)
 * - Allowlist answers: Stored in Nillion (value encrypted)
 */

import { AllowlistService } from '../../worker/services/AllowlistService';
import { AuthService } from '../../worker/services/AuthService';
import { NillionProxyClient } from '../../worker/services/NillionProxyClient';
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

    // Validate required fields (user_id is injected by worker from auth)
    if (!body.q_id || !body.user_id || !body.value || !body.audience) {
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

    // Determine primary_type from the query's taxonomy JSON field and get question owner
    const query = await env.DB.prepare(
      'SELECT json_extract(taxonomy, \'$.primary_type\') as primary_type, coiner_fid, owner_id FROM queries WHERE id = ?'
    ).bind(body.q_id).first() as { primary_type?: string; coiner_fid?: number; owner_id?: number } | null;

    if (!query) {
      return new Response('Question not found', { status: 404 });
    }

    const primary_type = query.primary_type || 'recurring';
    const questionOwnerFid = query.coiner_fid; // FID of the question creator

    // Get answerer's FID from user_id
    const answererRow = await env.DB.prepare(
      'SELECT fid FROM users WHERE id = ?'
    ).bind(body.user_id).first() as { fid: number } | null;

    if (!answererRow) {
      return new Response('User not found', { status: 404 });
    }

    const answererFid = answererRow.fid;

    // Handle points: Deduct from answerer, award to question owner
    const pointsService = PointsService.fromEnv(env);

    // Deduct answer_cost from answerer (deducts from allowance first, then balance)
    const updatedPoints = await pointsService.deductPoints(
      answererFid,
      answer_cost,
      `answer to question: ${body.q_id.substring(0, 8)}`
    );

    if (!updatedPoints) {
      // Get current points for error message
      const currentPoints = await pointsService.getPoints(answererFid);
      const totalSpendable = (currentPoints?.allowance || 0) + (currentPoints?.balance || 0);

      return new Response(
        `Insufficient QP. Required: ${answer_cost}, Available: ${totalSpendable}`,
        { status: 402 } // 402 Payment Required
      );
    }

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

    const answerId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Route based on audience
    try {
      if (body.audience === 'Public') {
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

        // Update public answer count
        await env.DB.prepare(
          `UPDATE queries SET pub_answers = pub_answers + 1 WHERE id = ?`
        ).bind(body.q_id).run();

        // Create attribution record in Nillion (non-blocking for speed)
        const { AnonAttributionService } = await import('../../worker/services/AnonAttributionService');
        AnonAttributionService.createAttribution(env, {
          public_id: answerId,
          author_id: body.user_id,
          type: 'answer',
        }).catch(attributionError => {
          console.error('Failed to create attribution for anonymous answer:', attributionError);
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
        // Store Private and Allowlist answers in Nillion via proxy
        const proxyClient = new NillionProxyClient(env);

        const result = await proxyClient.storeAnswer({
          q_id: body.q_id,
          user_id: body.user_id,
          value: body.value,
          answer_type_id: body.answer_type_id,
          answer_data: body.answer_data,
          audience: body.audience as 'Private' | 'Allowlist',
          primary_type: primary_type as 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive',
          allowlist_id: body.allowlist_id,
          allowlist: body.allowlist,
        });

        // Update private answer count
        await env.DB.prepare(
          `UPDATE queries SET priv_answers = priv_answers + 1 WHERE id = ?`
        ).bind(body.q_id).run();

        return Response.json({
          success: true,
          storage: 'nillion',
          answerId: result.answer_id,
        });
      }
    } catch (storageError) {
      // Refund points if answer creation fails
      console.error('[Answer Creation] Failed to store answer, refunding points:', storageError);
      await pointsService.addBalancePoints(answererFid, answer_cost, 'refund: answer creation failed');

      // Also remove the earned points from question owner if they were awarded
      if (questionOwnerFid && questionOwnerFid !== answererFid) {
        const ownerPoints = await pointsService.getPoints(questionOwnerFid);
        ownerPoints.earned = Math.max(0, ownerPoints.earned - answer_cost);
        await env.KV_USER_POINTS.put(
          questionOwnerFid.toString(),
          JSON.stringify(ownerPoints)
        );
        console.log(`[Answer Creation] Removed ${answer_cost} earned QP from question owner FID ${questionOwnerFid}`);
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
    // Try D1 first (for Public and Anon answers)
    const answer = await env.DB.prepare(
      `SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash
       FROM Answers a
       LEFT JOIN users u ON a.user_id = u.id
       LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
       WHERE a.id = ?`
    ).bind(answerId).first();

    if (answer) {
      // Public and Anon answers - return immediately
      if (answer.audience === 'Public' || answer.audience === 'Anon') {
        return Response.json({
          ...answer,
          created_at: new Date(answer.created_at).getTime()
        });
      }
    }

    // Try Nillion for Private, Anon, Allowlist answers
    try {
      const proxyClient = new NillionProxyClient(env);
      const nillionAnswer = await proxyClient.getAnswer(answerId);

      if (!nillionAnswer) {
        return new Response('Answer not found', { status: 404 });
      }

      // Decrypt fields marked with %allot
      const userId = typeof nillionAnswer.user_id === 'object' && '%allot' in nillionAnswer.user_id
        ? nillionAnswer.user_id['%allot']
        : nillionAnswer.user_id;

      const value = typeof nillionAnswer.value === 'object' && '%allot' in nillionAnswer.value
        ? nillionAnswer.value['%allot']
        : nillionAnswer.value;

      // Anon answers - hide user info but return the answer
      if (nillionAnswer.audience === 'Anon') {
        return Response.json({
          id: nillionAnswer._id,
          q_id: nillionAnswer.q_id,
          user_id: null,
          user_fname: 'Anonymous',
          user_fid: null,
          value,
          answer_type_id: nillionAnswer.answer_type_id,
          audience: nillionAnswer.audience,
          created_at: new Date(nillionAnswer.created_at).getTime(),
        });
      }

      // Private and Allowlist answers require authentication
      const authService = AuthService.fromEnv(env, request.url);
      const auth = await authService.verifyAuthHeader(request.headers.get('Authorization'));

      if (!auth.valid || !auth.fid) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get requester's internal user ID
      const userRow = await env.DB.prepare('SELECT id FROM users WHERE fid = ?')
        .bind(auth.fid)
        .first() as { id: number } | null;

      if (!userRow) {
        return new Response('User not found', { status: 404 });
      }

      const requesterId = userRow.id;

      // Private answers - only the author can view
      if (nillionAnswer.audience === 'Private') {
        if (userId !== requesterId) {
          return new Response('Forbidden', { status: 403 });
        }

        // Get user info
        const userInfo = await env.DB.prepare(
          'SELECT fname, fid FROM users WHERE id = ?'
        ).bind(userId).first() as { fname: string; fid: number } | null;

        return Response.json({
          id: nillionAnswer._id,
          q_id: nillionAnswer.q_id,
          user_id: userId,
          user_fname: userInfo?.fname || null,
          user_fid: userInfo?.fid || null,
          value,
          answer_type_id: nillionAnswer.answer_type_id,
          audience: nillionAnswer.audience,
          created_at: new Date(nillionAnswer.created_at).getTime(),
        });
      }

      // Allowlist answers - check if requester is author or in allowlist
      if (nillionAnswer.audience === 'Allowlist') {
        const isAuthor = userId === requesterId;

        if (!isAuthor) {
          // Check allowlist membership
          if (nillionAnswer.allowlist_id) {
            const members = await AllowlistService.getMembers(env, nillionAnswer.allowlist_id);
            if (!members.includes(requesterId)) {
              return new Response('Forbidden', { status: 403 });
            }
          } else if (nillionAnswer.allowlist) {
            // One-off allowlist - check if requester's FID is in the list
            const allowlistFids = nillionAnswer.allowlist.map(fid => parseInt(fid));
            if (!allowlistFids.includes(auth.fid)) {
              return new Response('Forbidden', { status: 403 });
            }
          } else {
            return new Response('Forbidden', { status: 403 });
          }
        }

        // Get user info
        const userInfo = await env.DB.prepare(
          'SELECT fname, fid FROM users WHERE id = ?'
        ).bind(userId).first() as { fname: string; fid: number } | null;

        return Response.json({
          id: nillionAnswer._id,
          q_id: nillionAnswer.q_id,
          user_id: userId,
          user_fname: userInfo?.fname || null,
          user_fid: userInfo?.fid || null,
          value,
          answer_type_id: nillionAnswer.answer_type_id,
          audience: nillionAnswer.audience,
          created_at: new Date(nillionAnswer.created_at).getTime(),
        });
      }
    } catch (error) {
      console.error('Error fetching from Nillion:', error);
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
        const userRow = await env.DB.prepare('SELECT id FROM users WHERE fid = ?')
          .bind(auth.fid)
          .first() as { id: number } | null;

        if (userRow) {
          requesterId = userRow.id;
        }
      }
    }

    const results: Array<Record<string, unknown>> = [];

    // Fetch Public and Anon answers from D1
    const d1Audiences = audiences.filter(a => ['Public', 'Anon'].includes(a));
    if (d1Audiences.length > 0) {
      const placeholders = d1Audiences.map(() => '?').join(',');
      const d1Answers = await env.DB.prepare(`
        SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash
        FROM Answers a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
        WHERE a.q_id = ? AND a.audience IN (${placeholders})
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?
      `).bind(queryId, ...d1Audiences, limit, offset).all();

      results.push(...d1Answers.results.map((a: Record<string, unknown>) => ({
        ...a,
        created_at: new Date(a.created_at as string).getTime()
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

    // Fetch Private and Allowlist answers from Nillion via proxy (Anon is in D1)
    const needsNillion = audiences.some(a => ['Private', 'Allowlist'].includes(a));

    if (needsNillion) {
      try {
        const proxyClient = new NillionProxyClient(env);
        const nillionAudiences = audiences.filter(a => ['Private', 'Allowlist'].includes(a));

        const nillionResult = await proxyClient.listAnswers(
          queryId,
          requesterId || undefined,
          nillionAudiences.join(',')
        );

        // Transform Nillion results to match our API format
        for (const nillionAnswer of nillionResult.results) {
          // Decrypt fields marked with %allot
          const userId = typeof nillionAnswer.user_id === 'object' && '%allot' in nillionAnswer.user_id
            ? nillionAnswer.user_id['%allot']
            : nillionAnswer.user_id;

          const value = typeof nillionAnswer.value === 'object' && '%allot' in nillionAnswer.value
            ? nillionAnswer.value['%allot']
            : nillionAnswer.value;

          // Get user info if not Anon
          let user_fname = null;
          let user_fid = null;

          if (nillionAnswer.audience !== 'Anon' && userId) {
            const userInfo = await env.DB.prepare(
              'SELECT fname, fid FROM users WHERE id = ?'
            ).bind(userId).first() as { fname: string; fid: number } | null;

            if (userInfo) {
              user_fname = userInfo.fname;
              user_fid = userInfo.fid;
            }
          }

          // For Anon answers, hide user info
          if (nillionAnswer.audience === 'Anon') {
            results.push({
              id: nillionAnswer._id,
              q_id: nillionAnswer.q_id,
              user_id: null,
              user_fname: 'Anonymous',
              user_fid: null,
              value,
              answer_type_id: nillionAnswer.answer_type_id,
              audience: nillionAnswer.audience,
              created_at: new Date(nillionAnswer.created_at).getTime(),
            });
          } else {
            // Private or Allowlist - include user info
            results.push({
              id: nillionAnswer._id,
              q_id: nillionAnswer.q_id,
              user_id: userId,
              user_fname,
              user_fid,
              value,
              answer_type_id: nillionAnswer.answer_type_id,
              audience: nillionAnswer.audience,
              created_at: new Date(nillionAnswer.created_at).getTime(),
            });
          }
        }
      } catch (error) {
        console.error('Error fetching from Nillion proxy:', error);
        // Don't fail the whole request if Nillion is down
        // Just log and continue with D1 results
      }
    }

    // Sort by created_at descending
    results.sort((a, b) => {
      const aTime = typeof a.created_at === 'number' ? a.created_at : 0;
      const bTime = typeof b.created_at === 'number' ? b.created_at : 0;
      return bTime - aTime;
    });

    return Response.json({
      results: results.slice(0, limit),
      query_id: queryId,
      limit,
      offset,
      total: results.length
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

    const userRow = await env.DB.prepare('SELECT id FROM users WHERE fid = ?')
      .bind(fidNum)
      .first() as { id: number } | null;

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

    const userId = userRow.id;

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
        `).bind(qId, userId).first();

        if (publicAnswer) {
          return Response.json({
            primary_type: 'identity',
            answer: {
              ...publicAnswer,
              created_at: new Date(publicAnswer.created_at).getTime()
            }
          });
        }

        // Check Nillion for Private/Allowlist answers
        try {
          const proxyClient = new NillionProxyClient(env);
          const nillionResult = await proxyClient.listAnswers(qId, userId, 'Private,Allowlist');

          if (nillionResult.results && nillionResult.results.length > 0) {
            const nillionAnswer = nillionResult.results[0];

            // Decrypt fields marked with %allot
            const value = typeof nillionAnswer.value === 'object' && '%allot' in nillionAnswer.value
              ? nillionAnswer.value['%allot']
              : nillionAnswer.value;

            return Response.json({
              primary_type: 'identity',
              answer: {
                id: nillionAnswer._id,
                q_id: nillionAnswer.q_id,
                user_id: userId,
                value,
                answer_type_id: nillionAnswer.answer_type_id,
                audience: nillionAnswer.audience,
                created_at: new Date(nillionAnswer.created_at).getTime(),
              }
            });
          }
        } catch (error) {
          console.error('Error fetching Private/Allowlist from Nillion:', error);
        }

        // Check for user's own Anon answers via attribution lookup
        try {
          const proxyClient = new NillionProxyClient(env);
          
          // Find attributions for this user's anonymous answers
          const attributions = await proxyClient.listAttributions(userId, 'answer');
          
          if (attributions.results && attributions.results.length > 0) {
            // Filter attributions to find ones for this specific question
            for (const attr of attributions.results) {
              // Fetch the answer to check if it's for this question
              const anonAnswer = await proxyClient.getAnswer(attr.public_id);
              
              if (anonAnswer && anonAnswer.q_id === qId) {
                // Found user's anon answer for this question
                const value = typeof anonAnswer.value === 'object' && '%allot' in anonAnswer.value
                  ? anonAnswer.value['%allot']
                  : anonAnswer.value;

                return Response.json({
                  primary_type: 'identity',
                  answer: {
                    id: anonAnswer._id,
                    q_id: anonAnswer.q_id,
                    user_id: userId,
                    value,
                    answer_type_id: anonAnswer.answer_type_id,
                    audience: anonAnswer.audience,
                    created_at: new Date(anonAnswer.created_at).getTime(),
                    is_own_anon: true, // Flag to indicate this is user's own anon answer
                  }
                });
              }
            }
          }
        } catch (error) {
          console.error('Error fetching Anon attributions from Nillion:', error);
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
          LEFT JOIN users u ON a.user_id = u.id
          LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
          WHERE a.q_id = ? AND a.user_id = ? AND a.audience = 'Public'
        `).bind(qId, userId).first();

        let myAnswer: Record<string, unknown> | null = null;
        if (myPublicAnswer) {
          myAnswer = {
            ...myPublicAnswer,
            created_at: new Date(myPublicAnswer.created_at).getTime()
          };
        }

        // Check Nillion for user's Private/Anon/Allowlist answer
        if (!myAnswer) {
          try {
            const proxyClient = new NillionProxyClient(env);
            
            // Check Private/Allowlist
            const nillionResult = await proxyClient.listAnswers(qId, userId, 'Private,Allowlist');
            if (nillionResult.results && nillionResult.results.length > 0) {
              const nillionAnswer = nillionResult.results[0];
              const value = typeof nillionAnswer.value === 'object' && '%allot' in nillionAnswer.value
                ? nillionAnswer.value['%allot']
                : nillionAnswer.value;

              myAnswer = {
                id: nillionAnswer._id,
                q_id: nillionAnswer.q_id,
                user_id: userId,
                value,
                answer_type_id: nillionAnswer.answer_type_id,
                audience: nillionAnswer.audience,
                created_at: new Date(nillionAnswer.created_at).getTime(),
              };
            }

            // Check Anon via attribution
            if (!myAnswer) {
              const attributions = await proxyClient.listAttributions(userId, 'answer');
              if (attributions.results && attributions.results.length > 0) {
                for (const attr of attributions.results) {
                  const anonAnswer = await proxyClient.getAnswer(attr.public_id);
                  if (anonAnswer && anonAnswer.q_id === qId) {
                    const value = typeof anonAnswer.value === 'object' && '%allot' in anonAnswer.value
                      ? anonAnswer.value['%allot']
                      : anonAnswer.value;

                    myAnswer = {
                      id: anonAnswer._id,
                      q_id: anonAnswer.q_id,
                      user_id: userId,
                      value,
                      answer_type_id: anonAnswer.answer_type_id,
                      audience: anonAnswer.audience,
                      created_at: new Date(anonAnswer.created_at).getTime(),
                      is_own_anon: true,
                    };
                    break;
                  }
                }
              }
            }
          } catch (error) {
            console.error('Error fetching user knowledge answer from Nillion:', error);
          }
        }

        // Get ALL community answers (public + anon)
        const communityAnswers: Array<Record<string, unknown>> = [];

        // Fetch public answers
        const publicAnswers = await env.DB.prepare(`
          SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash
          FROM Answers a
          LEFT JOIN users u ON a.user_id = u.id
          LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
          WHERE a.q_id = ? AND a.audience = 'Public'
          ORDER BY a.created_at DESC
          LIMIT 50
        `).bind(qId).all();

        communityAnswers.push(...publicAnswers.results.map((a: Record<string, unknown>) => ({
          ...a,
          created_at: new Date(a.created_at as string).getTime(),
          is_mine: a.user_id === userId
        })));

        // Fetch anonymous answers from Nillion
        try {
          const proxyClient = new NillionProxyClient(env);
          const nillionResult = await proxyClient.listAnswers(qId, undefined, 'Anon');

          for (const nillionAnswer of nillionResult.results) {
            const value = typeof nillionAnswer.value === 'object' && '%allot' in nillionAnswer.value
              ? nillionAnswer.value['%allot']
              : nillionAnswer.value;

            communityAnswers.push({
              id: nillionAnswer._id,
              q_id: nillionAnswer.q_id,
              user_id: null,
              user_fname: 'Anonymous',
              user_fid: null,
              value,
              answer_type_id: nillionAnswer.answer_type_id,
              audience: nillionAnswer.audience,
              created_at: new Date(nillionAnswer.created_at).getTime(),
              is_mine: false // Can't tell for anon
            });
          }
        } catch (error) {
          console.error('Error fetching Anon answers for knowledge question:', error);
        }

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
          created_at: new Date(a.created_at).getTime()
        }));

        // Also fetch user's anon answers for this question via attribution
        try {
          const proxyClient = new NillionProxyClient(env);
          const attributions = await proxyClient.listAttributions(userId, 'answer');
          
          if (attributions.results && attributions.results.length > 0) {
            for (const attr of attributions.results) {
              const anonAnswer = await proxyClient.getAnswer(attr.public_id);
              
              if (anonAnswer && anonAnswer.q_id === qId) {
                const value = typeof anonAnswer.value === 'object' && '%allot' in anonAnswer.value
                  ? anonAnswer.value['%allot']
                  : anonAnswer.value;

                answers.push({
                  id: anonAnswer._id,
                  q_id: anonAnswer.q_id,
                  user_id: userId,
                  value,
                  answer_type_id: anonAnswer.answer_type_id,
                  audience: anonAnswer.audience,
                  created_at: new Date(anonAnswer.created_at).getTime(),
                  is_own_anon: true,
                });
              }
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
        created_at: new Date(a.created_at).getTime()
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
    const userRow = await env.DB.prepare('SELECT id FROM users WHERE fid = ?')
      .bind(auth.fid)
      .first() as { id: number } | null;

    if (!userRow) {
      return new Response('User not found', { status: 404 });
    }

    const userId = userRow.id;

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
        // Delete from D1, create in Nillion
        await env.DB.prepare('DELETE FROM Answers WHERE id = ?').bind(answerId).run();

        // Get question info for primary_type
        const question = await env.DB.prepare(
          'SELECT json_extract(taxonomy, \'$.primary_type\') as primary_type FROM queries WHERE id = ?'
        ).bind(existingAnswer.q_id).first() as { primary_type?: string } | null;

        const primary_type = question?.primary_type || 'recurring';

        // Store in Nillion
        const proxyClient = new NillionProxyClient(env);
        const result = await proxyClient.storeAnswer({
          q_id: existingAnswer.q_id,
          user_id: userId,
          value: body.value,
          answer_type_id: body.answer_type_id,
          audience: body.audience as 'Private' | 'Anon' | 'Allowlist',
          primary_type: primary_type as 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive',
          allowlist_id: body.allowlist_id,
          allowlist: body.allowlist,
        });

        // Update answer counts
        // Anon answers count as public (visible to all, just with hidden user identity)
        if (body.audience === 'Anon') {
          // Moving from Public to Anon - both count as public, no change needed
        } else {
          // Moving from Public to Private/Allowlist - decrement pub, increment priv
          await env.DB.prepare(
            'UPDATE queries SET pub_answers = pub_answers - 1, priv_answers = priv_answers + 1 WHERE id = ?'
          ).bind(existingAnswer.q_id).run();
        }

        return Response.json({
          success: true,
          answerId: result.answer_id,
          storage: 'nillion',
          message: 'Answer moved to Nillion and updated successfully'
        });
      }
    }

    // Check if answer exists in Nillion (Private/Anon/Allowlist answers)
    try {
      const proxyClient = new NillionProxyClient(env);
      const nillionAnswer = await proxyClient.getAnswer(answerId);

      if (nillionAnswer) {
        // Verify ownership
        const actualUserId = typeof nillionAnswer.user_id === 'object' && '%allot' in nillionAnswer.user_id
          ? nillionAnswer.user_id['%allot']
          : nillionAnswer.user_id;

        if (actualUserId !== userId) {
          return new Response('Forbidden: You can only update your own answers', { status: 403 });
        }

        // Check if this is a predictive answer (immutable)
        const question = await env.DB.prepare(
          'SELECT json_extract(taxonomy, \'$.primary_type\') as primary_type FROM queries WHERE id = ?'
        ).bind(nillionAnswer.q_id).first() as { primary_type?: string } | null;
        
        if (question?.primary_type === 'predictive') {
          return new Response('Predictive answers cannot be edited after submission', { status: 403 });
        }

        // If moving to Public, create in D1 and delete from Nillion
        if (body.audience === 'Public') {
          const now = new Date().toISOString();
          const primary_type = question?.primary_type || 'identity';

          await env.DB.prepare(`
            INSERT INTO Answers (id, q_id, user_id, value, answer_type_id, audience, created_at, primary_type, reasoning, topics)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            answerId,
            nillionAnswer.q_id,
            userId,
            body.value,
            body.answer_type_id,
            'Public',
            now,
            primary_type,
            body.reasoning || null,
            body.topics ? JSON.stringify(body.topics) : null
          ).run();

          // TODO: Delete from Nillion (proxy client doesn't have delete method yet)

          // Update answer counts
          // Anon answers count as public (visible to all, just with hidden user identity)
          if (nillionAnswer.audience === 'Anon') {
            // Moving from Anon to Public - both count as public, no change needed
          } else {
            // Moving from Private/Allowlist to Public - increment pub, decrement priv
            await env.DB.prepare(
              'UPDATE queries SET pub_answers = pub_answers + 1, priv_answers = priv_answers - 1 WHERE id = ?'
            ).bind(nillionAnswer.q_id).run();
          }

          return Response.json({
            success: true,
            answerId,
            storage: 'd1',
            message: 'Answer moved to public and updated successfully'
          });
        } else {
          // Staying in Nillion - update via proxy
          // TODO: Implement update method in proxy client
          // For now, we'll delete and recreate

          const primary_type = question?.primary_type || 'recurring';

          const result = await proxyClient.storeAnswer({
            q_id: nillionAnswer.q_id,
            user_id: userId,
            value: body.value,
            answer_type_id: body.answer_type_id,
            audience: body.audience as 'Private' | 'Anon' | 'Allowlist',
            primary_type: primary_type as 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive',
            allowlist_id: body.allowlist_id,
            allowlist: body.allowlist,
          });

          return Response.json({
            success: true,
            answerId: result.answer_id,
            storage: 'nillion',
            message: 'Answer updated successfully in Nillion'
          });
        }
      }
    } catch (error) {
      console.error('Error checking Nillion:', error);
    }

    return new Response('Answer not found', { status: 404 });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error updating answer:', e);
    return new Response(`Error updating answer: ${err.message}`, { status: 500 });
  }
}

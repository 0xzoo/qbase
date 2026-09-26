/**
 * Read handlers for the answers API.
 *
 *  - GET /api/answers/:id                    — handleGetAnswer
 *  - GET /api/queries/:q_id/answers          — handleListAnswers
 *  - GET /api/users/:fid/answers/by-query    — handleListUserAnswersForQuery
 *  - GET /api/users/:fid/answers             — handleGetUserAnswers
 *  - GET /api/answers                        — handleListAllAnswers
 *
 * Private/Allowlist payloads are gated by author / allowlist-membership
 * checks (see audit batch S3); QStorage is consulted only after the
 * authz check passes.
 */

import { AllowlistService } from '../../services/AllowlistService';
import { openSealedAnswer, parseAnswerData, personKeyForPathId } from './shared';
import { requireFlexibleAuth, type AuthResult } from '../../middleware/auth';
import { maskAnonAuthor, type Env } from './shared';
import { ownAnonAnswerIds as ownAnonAnswerIdsOn } from '../../services/AnonAttributionService';

// Mirror of the write path in worker/routes/answers.ts: a like row's user_id is
// String(person key) since the account-root refactor. Older rows carry
// `quilAddress || String(fid)` (legacy fid-string from before passkey link,
// plus quilAddress after), so we match against every identity they could
// have written under.
export function likeIdentitiesForAuth(auth: Pick<AuthResult, 'userKey' | 'fid' | 'quilAddress'>): string[] {
  const ids: string[] = [];
  if (auth.userKey !== undefined) ids.push(String(auth.userKey));
  if (auth.quilAddress) ids.push(auth.quilAddress);
  if (auth.fid !== undefined) ids.push(String(auth.fid));
  return [...new Set(ids)];
}

/** The requester's person key when signed in and their profile row exists. */
async function requesterKeyFor(env: Env, auth: AuthResult): Promise<number | null> {
  if (!auth.authenticated || auth.userKey === undefined) return null;
  const userRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
    .bind(auth.userKey)
    .first() as { fid: number } | null;
  return userRow ? userRow.fid : null;
}

/**
 * GET /api/answers/:id - Retrieve a single answer
 * Auth: Required for Private/Allowlist answers, optional for Public/Anon
 */
export async function handleGetAnswer(request: Request, env: Env, answerId: string): Promise<Response> {
  try {
    // Check for optional authentication to include user-specific data
    let requesterLikeIds: string[] = [];
    let auth: AuthResult = { authenticated: false };
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      auth = await requireFlexibleAuth(request, env);
      if (auth.authenticated) {
        requesterLikeIds = likeIdentitiesForAuth(auth);
      }
    }

    // Try D1 first (for Public and Anon answers)
    const answer = await env.DB.prepare(
      `SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash,
              COALESCE(lc.like_count, 0) as like_count,
              COALESCE(fc.cached_likes_count, 0) as farcaster_likes,
              COALESCE(fc.cached_recasts_count, 0) as farcaster_recasts
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
        if (requesterLikeIds.length > 0) {
          const placeholders = requesterLikeIds.map(() => '?').join(',');
          const userLike = await env.DB.prepare(
            `SELECT 1 FROM answer_likes WHERE answer_id = ? AND user_id IN (${placeholders})`
          ).bind(answerId, ...requesterLikeIds).first();
          userHasLiked = !!userLike;
        }

        return Response.json(maskAnonAuthor({
          ...answer,
          created_at: new Date(answer.created_at).getTime(),
          like_count: answer.like_count as number,
          user_has_liked: userHasLiked,
          // Parse answer_data JSON string if present
          answer_data: answer.answer_data && typeof answer.answer_data === 'string' 
            ? JSON.parse(answer.answer_data as string) 
            : answer.answer_data,
        }));
      }
    }

    // If answer is in D1 but has a storage_ref, fetch value from Q Storage
    if (answer && answer.storage_ref && typeof answer.storage_ref === 'string') {
      // Private/Allowlist answer - requires authentication (any sign-in: the
      // person key decides; a Farcaster fid is not needed)
      if (!auth.authenticated || auth.userKey === undefined) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get requester's person key (their profile row)
      const requesterId = await requesterKeyFor(env, auth);

      if (requesterId === null) {
        return new Response('User not found', { status: 404 });
      }

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
            // Named allowlist members are user ids (person keys; AllowlistService.resolveFidsToUserIds)
            const members = await AllowlistService.getMembers(env, allowlistRef.allowlist_id);
            if (!members.includes(requesterId)) {
              return new Response('Forbidden', { status: 403 });
            }
          } else {
            // Check one-off allowlist from answer_data
            const answerData = answer.answer_data && typeof answer.answer_data === 'string'
              ? JSON.parse(answer.answer_data as string)
              : answer.answer_data;
            // One-off allowlists are Farcaster fids picked from the graph: a Farcaster gate
            const allowlistFids = answerData?.allowlist || [];
            if (auth.fid === undefined || !allowlistFids.includes(auth.fid)) {
              return new Response('Forbidden', { status: 403 });
            }
          }
        }
      }

      // Open the sealed content (SecretStore is the only decrypt path)
      try {
        const payload = await openSealedAnswer(env, answer);

        if (payload) {
          return Response.json({
            ...answer,
            value: payload.value,
            answer_data: payload.answer_data || parseAnswerData(answer.answer_data),
            reasoning: payload.reasoning,
            created_at: new Date(answer.created_at as string).getTime(),
            like_count: answer.like_count as number || 0,
            user_has_liked: false,
            storage_ref: undefined, // don't expose internal ref
          });
        }
      } catch (qsError) {
        console.error('[SecretStore] Error opening answer value:', qsError);
      }

      // Sealed content unavailable - return metadata without value
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
 * The person behind an answer row, for the question's answer list: a named
 * row's user_id; an Anon row's sealed attribution tag (every Anon row carries
 * the placeholder user_id); an Anon row with no attribution belongs to nobody
 * and counts as its own. Used for both the latest-per-person list and its count.
 */
function listPersonSql(alias: string): string {
  return `CASE WHEN ${alias}.audience = 'Anon'
    THEN COALESCE((SELECT t.author_tag FROM anon_attributions t WHERE t.public_id = ${alias}.id AND t.type = 'answer'), 'row:' || ${alias}.id)
    ELSE 'u:' || ${alias}.user_id END`;
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
    const uniqueUsers = url.searchParams.get('unique_users') === 'true';

    // Verify the query exists
    const query = await env.DB.prepare('SELECT id FROM queries WHERE id = ?')
      .bind(queryId)
      .first();

    if (!query) {
      return new Response('Query not found', { status: 404 });
    }

    let requesterId: number | null = null;
    let requesterLikeIds: string[] = [];

    // Check authentication (optional)
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const auth = await requireFlexibleAuth(request, env);
      if (auth.authenticated) {
        requesterId = await requesterKeyFor(env, auth);
        requesterLikeIds = likeIdentitiesForAuth(auth);
      }
    }

    const results: Array<Record<string, unknown>> = [];

    // Fetch Public and Anon answers from D1
    const d1Audiences = audiences.filter(a => ['Public', 'Anon'].includes(a));
    let publicAnonTotal = 0;
    let publicAnonRowCount = 0;
    if (d1Audiences.length > 0) {
      const placeholders = d1Audiences.map(() => '?').join(',');

      // Count total unique responders (for display)
      const distinctResult = await env.DB.prepare(
        `SELECT COUNT(DISTINCT ${listPersonSql('a')}) as count FROM Answers a WHERE a.q_id = ? AND a.audience IN (${placeholders})`
      ).bind(queryId, ...d1Audiences).first() as { count: number } | null;
      publicAnonTotal = distinctResult?.count ?? 0;

      // Count total rows for pagination
      // When unique_users=true, pagination counts the rows the list returns: one per person per scope
      if (uniqueUsers) {
        // One row per person per scope (each poll, and the question outside any poll)
        const scopedResult = await env.DB.prepare(
          `SELECT COUNT(DISTINCT ${listPersonSql('a')} || '|' || COALESCE(a.poll_id, '')) as count FROM Answers a WHERE a.q_id = ? AND a.audience IN (${placeholders})`
        ).bind(queryId, ...d1Audiences).first() as { count: number } | null;
        publicAnonRowCount = scopedResult?.count ?? 0;
      } else {
        const rowCountResult = await env.DB.prepare(
          `SELECT COUNT(*) as count FROM Answers WHERE q_id = ? AND audience IN (${placeholders})`
        ).bind(queryId, ...d1Audiences).first() as { count: number } | null;
        publicAnonRowCount = rowCountResult?.count ?? 0;
      }

      let d1Answers: { results: Record<string, unknown>[] };
      
      if (uniqueUsers) {
        // Deduplicate: keep only the latest answer per person per scope (each
        // poll the question ran as, and the question itself). A named row's
        // person is its user_id; an Anon row's is its sealed attribution tag
        // (all Anon rows share the placeholder user_id). An Anon row with no
        // attribution belongs to nobody and stays its own partition.
        d1Answers = await env.DB.prepare(`
          WITH ranked AS (
            SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash,
                   COALESCE(lc.like_count, 0) as like_count,
                   COALESCE(fc.cached_likes_count, 0) as farcaster_likes,
                   COALESCE(fc.cached_recasts_count, 0) as farcaster_recasts,
                   ROW_NUMBER() OVER (
                     PARTITION BY ${listPersonSql('a')}, COALESCE(a.poll_id, '')
                     ORDER BY a.created_at DESC
                   ) as rn
            FROM Answers a
            LEFT JOIN users u ON a.user_id = u.fid
            LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
            LEFT JOIN (
              SELECT answer_id, COUNT(*) as like_count
              FROM answer_likes
              GROUP BY answer_id
            ) lc ON lc.answer_id = a.id
            WHERE a.q_id = ? AND a.audience IN (${placeholders})
          )
          SELECT * FROM ranked WHERE rn = 1
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `).bind(queryId, ...d1Audiences, limit, offset).all();
      } else {
        d1Answers = await env.DB.prepare(`
          SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash,
                 COALESCE(lc.like_count, 0) as like_count,
                 COALESCE(fc.cached_likes_count, 0) as farcaster_likes,
                 COALESCE(fc.cached_recasts_count, 0) as farcaster_recasts
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
      }

      // If user is authenticated, check which answers they've liked
      let userLikedAnswerIds = new Set<string>();
      if (requesterLikeIds.length > 0 && d1Answers.results.length > 0) {
        const answerIds = d1Answers.results.map((a: Record<string, unknown>) => a.id as string);
        const likePlaceholders = answerIds.map(() => '?').join(',');
        const idPlaceholders = requesterLikeIds.map(() => '?').join(',');
        const userLikes = await env.DB.prepare(`
          SELECT answer_id FROM answer_likes
          WHERE user_id IN (${idPlaceholders}) AND answer_id IN (${likePlaceholders})
        `).bind(...requesterLikeIds, ...answerIds).all();
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
        const ownAnonAnswerIds = await ownAnonAnswerIdsOn(env, requesterId, [queryId]);

        // Mark the user's own anon answers in the results. In-feed anon rows
        // carry the responder's FID in user_id (no attribution row), so that
        // match counts too — only for the requester themselves.
        results.forEach((result) => {
          if (result.audience === 'Anon' && (ownAnonAnswerIds.has(result.id as string) || result.user_id === requesterId)) {
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

        for (const pa of privateAnswers.results as Record<string, unknown>[]) {

          // Open the sealed content if storage_ref exists
          let value = pa.value as string;
          let answerData = parseAnswerData(pa.answer_data);

          if (pa.storage_ref && typeof pa.storage_ref === 'string') {
            try {
              const payload = await openSealedAnswer(env, pa);
              if (payload) {
                value = payload.value || value;
                answerData = payload.answer_data || answerData;
              }
            } catch (fetchErr) {
              console.error(`[SecretStore] Failed to open answer ${pa.id}:`, fetchErr);
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
    // Anon rows never name their author — the audience tag is the mask.
    return Response.json({
      results: results.slice(0, limit).map(maskAnonAuthor),
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
 * GET /api/queries/:q_id/users/:fid/answers - List a user's public answers for a question
 * Public endpoint, no auth required. Returns Public answers only, in reverse chron.
 * Anon answers are excluded by design (their user_id is the anon bot, not the author's fid).
 */
export async function handleListUserAnswersForQuery(
  request: Request,
  env: Env,
  queryId: string,
  fid: string
): Promise<Response> {
  try {
    const fidNum = parseInt(fid);
    if (isNaN(fidNum)) {
      return new Response('Invalid FID', { status: 400 });
    }

    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);

    // The path names a fid: read the rows of the person it belongs to.
    const userKey = await personKeyForPathId(env, fidNum);
    if (userKey === undefined) {
      return Response.json({ results: [], query_id: queryId, fid: fidNum });
    }

    let requesterLikeIds: string[] = [];
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const auth = await requireFlexibleAuth(request, env);
      if (auth.authenticated) {
        requesterLikeIds = likeIdentitiesForAuth(auth);
      }
    }

    const answers = await env.DB.prepare(`
      SELECT a.*, u.fname as user_fname, u.fid as user_fid, fc.cast_hash as casthash,
             COALESCE(lc.like_count, 0) as like_count,
             COALESCE(fc.cached_likes_count, 0) as farcaster_likes,
             COALESCE(fc.cached_recasts_count, 0) as farcaster_recasts
      FROM Answers a
      LEFT JOIN users u ON a.user_id = u.fid
      LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
      LEFT JOIN (
        SELECT answer_id, COUNT(*) as like_count
        FROM answer_likes
        GROUP BY answer_id
      ) lc ON lc.answer_id = a.id
      WHERE a.q_id = ? AND a.user_id = ? AND a.audience = 'Public'
      ORDER BY a.created_at DESC
      LIMIT ?
    `).bind(queryId, userKey, limit).all();

    let userLikedAnswerIds = new Set<string>();
    if (requesterLikeIds.length > 0 && answers.results.length > 0) {
      const answerIds = answers.results.map((a: Record<string, unknown>) => a.id as string);
      const likePlaceholders = answerIds.map(() => '?').join(',');
      const idPlaceholders = requesterLikeIds.map(() => '?').join(',');
      const userLikes = await env.DB.prepare(
        `SELECT answer_id FROM answer_likes WHERE user_id IN (${idPlaceholders}) AND answer_id IN (${likePlaceholders})`
      ).bind(...requesterLikeIds, ...answerIds).all();
      userLikedAnswerIds = new Set(userLikes.results.map((l: Record<string, unknown>) => l.answer_id as string));
    }

    const results = answers.results.map((a: Record<string, unknown>) => ({
      ...a,
      created_at: new Date(a.created_at as string).getTime(),
      like_count: a.like_count as number,
      user_has_liked: userLikedAnswerIds.has(a.id as string),
      answer_data: a.answer_data && typeof a.answer_data === 'string'
        ? JSON.parse(a.answer_data as string)
        : a.answer_data,
    }));

    return Response.json({ results, query_id: queryId, fid: fidNum });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error listing user answers for query:', e);
    return new Response(`Error: ${err.message}`, { status: 500 });
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
  fid: string,
  /** The requester's person key (auth.userKey), when signed in. */
  requesterKey?: number
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

    // The path names a fid (or an account id): the person key it maps to.
    // Undefined after the cutover for a fid with no account: nothing to show.
    const pathKey = await personKeyForPathId(env, fidNum);

    // Identity privacy: only the user themselves (or, for Allowlist, an
    // explicit member) can see Private/Allowlist payloads or the
    // is_own_anon flag on their Anon attributions. Others get a sanitized
    // view (Public answers only).
    const isSelf = requesterKey !== undefined && pathKey !== undefined && requesterKey === pathKey;

    const userRow = pathKey === undefined ? null : await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
      .bind(pathKey)
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
            answer: maskAnonAuthor({
              ...publicAnswer,
              created_at: new Date(publicAnswer.created_at).getTime(),
              // Parse answer_data JSON string if present
              answer_data: publicAnswer.answer_data && typeof publicAnswer.answer_data === 'string'
                ? JSON.parse(publicAnswer.answer_data as string)
                : publicAnswer.answer_data,
            })
          });
        }

        // Check D1 for Private/Allowlist answers (now stored in D1 + Q Storage)
        // Only the author can read Private. Allowlist is readable by author or
        // an authenticated allowlist member. All other callers see "no answer".
        if (isSelf) {
          try {
            const privateAnswer = await env.DB.prepare(
              `SELECT a.* FROM Answers a WHERE a.q_id = ? AND a.user_id = ? AND a.audience IN ('Private', 'Allowlist')`
            ).bind(qId, userId).first();

            if (privateAnswer) {
              // Open the sealed content if storage_ref exists
              let value = privateAnswer.value as string;
              let answerData = parseAnswerData(privateAnswer.answer_data);

              if (privateAnswer.storage_ref && typeof privateAnswer.storage_ref === 'string') {
                try {
                  const payload = await openSealedAnswer(env, privateAnswer);
                  if (payload) {
                    value = payload.value || value;
                    answerData = payload.answer_data || answerData;
                  }
                } catch (qsErr) {
                  console.error('[SecretStore] Error opening private answer:', qsErr);
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
        }

        // Check for user's own Anon answers via attribution in D1.
        // Setting `is_own_anon: true` would de-anonymize the responder, so
        // only run this branch when the caller is the responder themselves.
        if (isSelf) {
          try {
            for (const attrId of await ownAnonAnswerIdsOn(env, userId, [qId])) {
              // Check if this anon answer is for the target question
              const anonAnswer = await env.DB.prepare(
                'SELECT * FROM Answers WHERE id = ? AND q_id = ?'
              ).bind(attrId, qId).first();

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
          myAnswer = maskAnonAuthor({
            ...myPublicAnswer,
            created_at: new Date(myPublicAnswer.created_at).getTime(),
            // Parse answer_data JSON string if present
            answer_data: myPublicAnswer.answer_data && typeof myPublicAnswer.answer_data === 'string'
              ? JSON.parse(myPublicAnswer.answer_data as string)
              : myPublicAnswer.answer_data,
          });
        }

        // Check D1 for user's Private/Allowlist answer (now stored in D1 + Q Storage)
        // Only fetch when the caller is the answerer — these are private payloads.
        if (!myAnswer && isSelf) {
          try {
            const privateAnswer = await env.DB.prepare(
              `SELECT * FROM Answers WHERE q_id = ? AND user_id = ? AND audience IN ('Private', 'Allowlist')`
            ).bind(qId, userId).first();

            if (privateAnswer) {
              let value = privateAnswer.value as string;
              let answerData = parseAnswerData(privateAnswer.answer_data);

              if (privateAnswer.storage_ref && typeof privateAnswer.storage_ref === 'string') {
                try {
                  const payload = await openSealedAnswer(env, privateAnswer);
                  if (payload) {
                    value = payload.value || value;
                    answerData = payload.answer_data || answerData;
                  }
                } catch (qsErr) {
                  console.error('[SecretStore] Error opening private answer:', qsErr);
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

            // Check Anon via attribution (anon answers are in D1).
            // De-anonymizing flag → only return when caller is the responder.
            if (!myAnswer && isSelf) {
              for (const attrId of await ownAnonAnswerIdsOn(env, userId, [qId])) {
                const anonAnswer = await env.DB.prepare(
                  'SELECT * FROM Answers WHERE id = ? AND q_id = ?'
                ).bind(attrId, qId).first();
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
        // For temporal questions (recurring/prospective), get the user's
        // answers. Non-self callers only see Public rows; self also sees
        // Private/Allowlist (stored in D1 with audience tag) plus their own
        // Anon attributions.
        const sql = isSelf
          ? `SELECT a.*, fc.cast_hash as casthash
             FROM Answers a
             LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
             WHERE a.q_id = ? AND a.user_id = ?
             ORDER BY a.created_at DESC`
          : `SELECT a.*, fc.cast_hash as casthash
             FROM Answers a
             LEFT JOIN farcaster_casts fc ON fc.entity_type = 'answer' AND fc.entity_id = a.id
             WHERE a.q_id = ? AND a.user_id = ? AND a.audience = 'Public'
             ORDER BY a.created_at DESC`;
        const publicAnswers = await env.DB.prepare(sql).bind(qId, userId).all();

        const answers: Array<Record<string, unknown>> = publicAnswers.results.map((a: any) => ({
          ...a,
          created_at: new Date(a.created_at).getTime(),
          // Parse answer_data JSON string if present
          answer_data: a.answer_data && typeof a.answer_data === 'string'
            ? JSON.parse(a.answer_data as string)
            : a.answer_data,
        }));

        // Also fetch user's anon answers for this question via attribution.
        // De-anonymizing flag → only when caller is the responder themselves.
        if (isSelf) {
          try {
            for (const attrId of await ownAnonAnswerIdsOn(env, userId, [qId])) {
              const anonAnswer = await env.DB.prepare(
                'SELECT * FROM Answers WHERE id = ? AND q_id = ?'
              ).bind(attrId, qId).first();
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

      const results = publicAnswers.results.map((a: any) => maskAnonAuthor({
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
    let requesterLikeIds: string[] = [];

    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const auth = await requireFlexibleAuth(request, env);
      if (auth.authenticated) {
        requesterId = await requesterKeyFor(env, auth);
        requesterLikeIds = likeIdentitiesForAuth(auth);
      }
    }

    // Fetch Public and Anon answers from D1 with question context
    // We join with queries to get the question stem (context)
    const d1Answers = await env.DB.prepare(`
      SELECT a.*, u.fname as user_fname, u.fid as user_fid,
             q.stem as question_stem,
             q.type as question_type,
             q.scale_config as question_scale_config,
             fc.cast_hash as casthash,
             COALESCE(lc.like_count, 0) as like_count,
             COALESCE(fc.cached_likes_count, 0) as farcaster_likes,
             COALESCE(fc.cached_recasts_count, 0) as farcaster_recasts
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
    if (requesterLikeIds.length > 0 && d1Answers.results.length > 0) {
      const answerIds = d1Answers.results.map((a: Record<string, unknown>) => a.id as string);
      const likePlaceholders = answerIds.map(() => '?').join(',');
      const idPlaceholders = requesterLikeIds.map(() => '?').join(',');
      const userLikes = await env.DB.prepare(`
        SELECT answer_id FROM answer_likes
        WHERE user_id IN (${idPlaceholders}) AND answer_id IN (${likePlaceholders})
      `).bind(...requesterLikeIds, ...answerIds).all();
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
      // Parse question_scale_config JSON string if present
      question_scale_config: a.question_scale_config && typeof a.question_scale_config === 'string'
        ? JSON.parse(a.question_scale_config as string)
        : a.question_scale_config,
    }));

    // Check anon answer attributions to mark user's own anon answers
    if (requesterId && allowedAudiences.includes('Anon')) {
      try {
        const ownAnonAnswerIds = await ownAnonAnswerIdsOn(env, requesterId, results.map((r: any) => r.q_id as string));

        // Mark the user's own anon answers in the results (attribution row,
        // or in-feed anon rows carrying the requester's own FID).
        results.forEach((result: any) => {
          if (result.audience === 'Anon' && (ownAnonAnswerIds.has(result.id as string) || result.user_id === requesterId)) {
            result.is_own_anon = true;
          }
        });
      } catch (error) {
        console.error('Error checking anon answer attributions:', error);
      }
    }

    // Anon rows never name their author — the audience tag is the mask.
    return Response.json({
      results: results.map(maskAnonAuthor),
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



/**
 * GET /api/queries/:id/answers/mine — every answer the signed-in person has
 * given on this question, newest first: named rows, their own Anon rows
 * (found through the sealed attribution tag) and Private / Allowlist rows
 * (opened for their owner). Answers are append-only, so this is the person's
 * history on the question. Owner-only; nobody else can ask for it.
 */
export async function handleListMyAnswersForQuery(request: Request, env: Env, queryId: string): Promise<Response> {
  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated || auth.userKey === undefined) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  // The person key (fid before the account cutover, account id after), so
  // every login sees the same history.
  const key = auth.userKey;
  const cols = 'id, q_id, user_id, value, answer_type_id, audience, created_at, poll_id, storage_ref';
  try {
    const named = await env.DB.prepare(`SELECT ${cols} FROM Answers WHERE q_id = ? AND user_id = ?`)
      .bind(queryId, key).all();
    const rows = [...((named.results ?? []) as Array<Record<string, unknown>>)];

    let anonIds: string[] = [];
    try {
      anonIds = [...await ownAnonAnswerIdsOn(env, key, [queryId])];
    } catch (e) {
      console.warn('[answers/mine] anon lookup unavailable:', e);
    }
    for (let i = 0; i < anonIds.length; i += 80) {
      const chunk = anonIds.slice(i, i + 80);
      const anon = await env.DB.prepare(`SELECT ${cols} FROM Answers WHERE q_id = ? AND id IN (${chunk.map(() => '?').join(',')})`)
        .bind(queryId, ...chunk).all();
      rows.push(...((anon.results ?? []) as Array<Record<string, unknown>>));
    }

    const results = [];
    for (const r of rows) {
      let value = r.value;
      if ((r.audience === 'Private' || r.audience === 'Allowlist') && r.storage_ref) {
        try {
          const payload = await openSealedAnswer(env, r);
          if (payload && payload.value !== undefined) value = payload.value;
        } catch (e) {
          console.warn(`[answers/mine] could not open ${String(r.id)}:`, e);
        }
      }
      results.push({ id: r.id, value, answer_type_id: r.answer_type_id, audience: r.audience, created_at: r.created_at, poll_id: r.poll_id ?? null });
    }
    results.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
    return Response.json({ results });
  } catch (error) {
    console.error('[answers/mine] failed:', error);
    return Response.json({ error: 'Failed to load your answers' }, { status: 500 });
  }
}

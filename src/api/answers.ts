import { getNillionClient, storePrivateAnswer, getPrivateAnswers } from '../lib/nillion/client';
import { AllowlistService } from '../../worker/services/AllowlistService';
import { AuthService } from '../../worker/services/AuthService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

interface AnswerRequest {
  q_id: string;
  user_id: number; // Internal user ID
  value: string;
  answer_type_id: string; // 'text', 'number', etc.
  audience: 'Public' | 'Private' | 'Anon' | 'Allowlist';
  allowlist_id?: string; // Reference to named allowlist
  allowlist?: number[]; // One-off FID array
  // ... other fields ...
}

export async function handleCreateAnswer(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as AnswerRequest;

    // Validate required fields
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
    if (body.value.length > 1000) {
      return new Response('Answer value too long (max 1000 chars)', { status: 400 });
    }

    // 3. Validate answer_type_id
    const allowedTypes = ['text', 'number', 'multiple_choice', 'boolean', 'scale'];
    if (body.answer_type_id && !allowedTypes.includes(body.answer_type_id)) {
      return new Response('Invalid answer_type_id', { status: 400 });
    }

    // 4. Validate audience
    const allowedAudiences = ['Public', 'Private', 'Anon', 'Allowlist'];
    if (!allowedAudiences.includes(body.audience)) {
      return new Response('Invalid audience', { status: 400 });
    }

    if (body.audience === 'Private' || body.audience === 'Anon' || body.audience === 'Allowlist') {
      // Validate Allowlist-specific fields
      if (body.audience === 'Allowlist') {
        if (!body.allowlist_id && !body.allowlist) {
          return new Response('Allowlist audience requires either allowlist_id or allowlist field', { status: 400 });
        }

        // Validate allowlist array size
        if (body.allowlist && body.allowlist.length > 100) {
          return new Response('One-off allowlists cannot exceed 100 members', { status: 400 });
        }
      }

      // Store in Nillion
      const client = await getNillionClient(env);

      // Prepare data for Nillion
      // Wrap sensitive fields in %allot based on audience type
      let user_id: number | { '%allot': number } = body.user_id;
      let value: string | { '%allot': string } = body.value;

      if (body.audience === 'Private') {
        user_id = { '%allot': body.user_id };
        value = { '%allot': body.value };
      } else if (body.audience === 'Anon') {
        user_id = { '%allot': body.user_id };
        // value remains plain
      } else if (body.audience === 'Allowlist') {
        // user_id remains plain for allowlist answers
        value = { '%allot': body.value };
      }

      // Build Nillion data object
      const nillionData: {
        _id: string;
        q_id: string;
        user_id: number | { '%allot': number };
        value: string | { '%allot': string };
        answer_type_id: string;
        audience: string;
        created_at: string;
        allowlist_id?: string;
        allowlist?: string[];
      } = {
        _id: crypto.randomUUID(),
        q_id: body.q_id,
        user_id,
        value,
        answer_type_id: body.answer_type_id,
        audience: body.audience,
        created_at: new Date().toISOString(),
      };

      // Add allowlist fields for Allowlist audience
      if (body.audience === 'Allowlist') {
        if (body.allowlist_id) {
          // Named allowlist - store reference for dynamic membership
          nillionData.allowlist_id = body.allowlist_id;
        } else if (body.allowlist) {
          // One-off allowlist - translate FIDs to internal user IDs and store snapshot
          const userIds = await AllowlistService.resolveFidsToUserIds(env, body.allowlist);
          nillionData.allowlist = userIds.map(id => id.toString()); // Schema expects string array
        }
      }

      // Determine the correct schema ID based on audience
      let schemaId: string;
      if (body.audience === 'Private') {
        schemaId = env.NILLION_PRIVATE_ANSWER_SCHEMA_ID;
      } else if (body.audience === 'Anon') {
        schemaId = env.NILLION_ANON_ANSWER_SCHEMA_ID;
      } else if (body.audience === 'Allowlist') {
        schemaId = env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID;
      } else {
        // Fallback or error - though validation should catch this
        throw new Error(`Unsupported audience for Nillion storage: ${body.audience}`);
      }

      // Store the answer in Nillion
      // Note: The SDK handles encryption based on the schema definition.
      // We explicitly wrap fields in { '%allot': value } to signal encryption where required by the schema.
      const result = await storePrivateAnswer(client, nillionData, schemaId);

      return Response.json({
        success: true,
        storage: 'nillion',
        result,
      });

    } else {
      // Store in D1 (Public)
      const stmt = env.DB.prepare(
        `INSERT INTO Answers (q_id, user_id, value, answer_type_id, audience, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        body.q_id,
        body.user_id,
        body.value,
        body.answer_type_id,
        body.audience,
        new Date().toISOString()
      );

      const result = await stmt.run();

      return Response.json({
        success: true,
        storage: 'd1',
        result,
      });
    }

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error creating answer:', e);
    return new Response(`Error creating answer: ${err.message}`, { status: 500 });
  }
}

/**
 * GET /api/answers/:id - Retrieve a single answer
 * Auth: Optional - required for Private/Allowlist answers
 */
export async function handleGetAnswer(request: Request, env: Env, answerId: string): Promise<Response> {
  try {
    // Check D1 first (Public answers only)
    const publicAnswer = await env.DB.prepare(
      'SELECT * FROM Answers WHERE id = ?'
    ).bind(answerId).first();

    if (publicAnswer && publicAnswer.audience === 'Public') {
      // Public answer found - return immediately (no auth needed)
      return Response.json({
        ...publicAnswer,
        created_at: new Date(publicAnswer.created_at).getTime()
      });
    }

    // Not in D1 as Public, so check Nillion for Private/Anon/Allowlist answers
    // These require authentication to access
    const authService = AuthService.fromEnv(env, request.url);
    const auth = await authService.verifyAuthHeader(request.headers.get('Authorization'));

    if (!auth.valid || !auth.fid) {
      // No valid auth - we can't check Nillion
      // We don't know if the answer exists or not, so return 401
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get internal user ID from FID
    const userRow = await env.DB.prepare('SELECT id FROM users WHERE fid = ?')
      .bind(auth.fid)
      .first() as { id: number } | null;

    if (!userRow) {
      return new Response('User not found', { status: 404 });
    }

    const requesterId = userRow.id;

    // Query Nillion for the answer
    const client = await getNillionClient(env);
    
    // Try each schema type
    const schemas = [
      env.NILLION_PRIVATE_ANSWER_SCHEMA_ID,
      env.NILLION_ANON_ANSWER_SCHEMA_ID,
      env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID
    ];

    for (const schemaId of schemas) {
      try {
        const response = await getPrivateAnswers(client, schemaId, { _id: answerId });
        
        if (response && response.data && response.data.length > 0) {
          const answer = response.data[0];
          
          // Check permissions based on audience
          if (answer.audience === 'Private') {
            // Only the author can view
            const answerUserId = typeof answer.user_id === 'number' ? answer.user_id : parseInt(answer.user_id as string);
            if (answerUserId !== requesterId) {
              return new Response('Forbidden', { status: 403 });
            }
          } else if (answer.audience === 'Allowlist') {
            // Check if requester is the author or in the allowlist
            const answerUserId = typeof answer.user_id === 'number' ? answer.user_id : parseInt(answer.user_id as string);
            const isAuthor = answerUserId === requesterId;
            
            if (!isAuthor) {
              // Check allowlist membership
              if (answer.allowlist_id) {
                // Named allowlist - check membership
                const allowlist = await AllowlistService.get(env, answer.allowlist_id as string, answerUserId);
                if (!allowlist) {
                  return new Response('Forbidden', { status: 403 });
                }
                
                const members = await AllowlistService.getMembers(env, answer.allowlist_id as string);
                if (!members.includes(requesterId)) {
                  return new Response('Forbidden', { status: 403 });
                }
              } else if (answer.allowlist && Array.isArray(answer.allowlist)) {
                // One-off allowlist - check if requester is in the list
                const allowlistUserIds = (answer.allowlist as (string | number)[]).map((id) => 
                  typeof id === 'number' ? id : parseInt(id)
                );
                if (!allowlistUserIds.includes(requesterId)) {
                  return new Response('Forbidden', { status: 403 });
                }
              } else {
                return new Response('Forbidden', { status: 403 });
              }
            }
          }
          // Anon answers are visible to authenticated users, but user_id is already encrypted
          
          return Response.json(answer);
        }
      } catch {
        // Schema might not contain this answer, continue to next
        continue;
      }
    }

    return new Response('Answer not found', { status: 404 });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error fetching answer:', e);
    return new Response(`Error fetching answer: ${err.message}`, { status: 500 });
  }
}

/**
 * GET /api/queries/:q_id/answers - List all answers for a query
 * Auth: Optional - only required for Private/Allowlist answers
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
    let isAuthenticated = false;

    // Check authentication (optional for public answers)
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      const authService = AuthService.fromEnv(env, request.url);
      const auth = await authService.verifyAuthHeader(authHeader);
      
      if (auth.valid && auth.fid) {
        isAuthenticated = true;
        const userRow = await env.DB.prepare('SELECT id FROM users WHERE fid = ?')
          .bind(auth.fid)
          .first() as { id: number } | null;
        
        if (userRow) {
          requesterId = userRow.id;
        }
      }
    }

    const results: Array<Record<string, unknown>> = [];

    // Fetch Public answers from D1
    if (audiences.includes('Public')) {
      const publicAnswers = await env.DB.prepare(`
        SELECT a.*, u.fname as user_fname, u.fid as user_fid
        FROM Answers a
        LEFT JOIN users u ON a.user_id = u.id
        WHERE a.q_id = ? AND a.audience = 'Public'
        ORDER BY a.created_at DESC
        LIMIT ? OFFSET ?
      `).bind(queryId, limit, offset).all();

      results.push(...publicAnswers.results.map((a: Record<string, unknown>) => ({
        ...a,
        created_at: new Date(a.created_at as string).getTime()
      })));
    }

    // Fetch authenticated user's own Private answers from Nillion (if authenticated)
    // Private answers are ONLY stored in Nillion, never in D1
    // Users should see their own private answers when viewing a question
    if (isAuthenticated && requesterId && env.NILLION_PRIVATE_ANSWER_SCHEMA_ID) {
      try {
        const client = await getNillionClient(env);
        const myPrivateResponse = await getPrivateAnswers(
          client,
          env.NILLION_PRIVATE_ANSWER_SCHEMA_ID,
          { q_id: queryId, user_id: requesterId }
        );
        
        const myPrivateNillionAnswers = myPrivateResponse?.data || [];
        results.push(...myPrivateNillionAnswers);
      } catch (e) {
        console.error('Error fetching private answers from Nillion:', e);
        // Continue without Nillion private answers
      }
    }

    // Fetch Anon answers from Nillion (if authenticated or public anon viewing is allowed)
    if (audiences.includes('Anon') && env.NILLION_ANON_ANSWER_SCHEMA_ID) {
      try {
        const client = await getNillionClient(env);
        const anonResponse = await getPrivateAnswers(
          client,
          env.NILLION_ANON_ANSWER_SCHEMA_ID,
          { q_id: queryId }
        );

        // Anon answers: user_id is encrypted, value is visible
        const anonAnswers = anonResponse?.data || [];
        results.push(...anonAnswers.map((a: Record<string, unknown>) => ({
          ...a,
          user_id: '[anonymous]', // Hide the encrypted user_id
          user_fname: 'Anonymous',
          user_fid: null
        })));
      } catch (e) {
        console.error('Error fetching anon answers:', e);
        // Continue without anon answers
      }
    }

    // Fetch Allowlist answers from Nillion (only if authenticated and in allowlist)
    if (audiences.includes('Allowlist') && isAuthenticated && requesterId && env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID) {
      try {
        const client = await getNillionClient(env);
        const allowlistResponse = await getPrivateAnswers(
          client,
          env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID,
          { q_id: queryId }
        );

        const allowlistAnswers = allowlistResponse?.data || [];

        // Filter to only answers the requester can see
        const visibleAllowlistAnswers = await Promise.all(
          allowlistAnswers.map(async (answer: Record<string, unknown>) => {
            // Author can always see their own answer
            const answerUserId = typeof answer.user_id === 'number' ? answer.user_id : parseInt(answer.user_id as string);
            if (answerUserId === requesterId) {
              return answer;
            }

            // Check allowlist membership
            if (answer.allowlist_id) {
              const allowlist = await AllowlistService.get(env, answer.allowlist_id as string, answerUserId);
              if (!allowlist) return null;
              
              const members = await AllowlistService.getMembers(env, answer.allowlist_id as string);
              if (members.includes(requesterId)) {
                return answer;
              }
            } else if (answer.allowlist && Array.isArray(answer.allowlist)) {
              const allowlistUserIds = (answer.allowlist as (string | number)[]).map((id) => 
                typeof id === 'number' ? id : parseInt(id as string)
              );
              if (allowlistUserIds.includes(requesterId)) {
                return answer;
              }
            }

            return null;
          })
        );

        results.push(...visibleAllowlistAnswers.filter(a => a !== null) as Record<string, unknown>[]);
      } catch (e) {
        console.error('Error fetching allowlist answers:', e);
        // Continue without allowlist answers
      }
    }

    // Note: Private answers are included only for the authenticated user (their own answers)
    // This allows users to see their private answers in context when viewing a question

    // Sort by created_at descending
    results.sort((a, b) => {
      const aTime = typeof a.created_at === 'number' ? a.created_at : new Date(a.created_at as string).getTime();
      const bTime = typeof b.created_at === 'number' ? b.created_at : new Date(b.created_at as string).getTime();
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

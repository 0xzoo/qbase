/**
 * Nillion API Endpoints
 * 
 * Handles:
 * - Delegation token generation for E2E encrypted answers
 * - Private answer notifications (bookkeeping without data)
 * - Collection config for client-side reads
 */

import { requireFlexibleAuth } from '../../worker/middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * GET /api/nillion/config
 * 
 * Returns Nillion configuration for client-side E2E operations.
 * This is public config (collection IDs), not secrets.
 */
export async function handleGetNillionConfig(
  _request: Request,
  env: Env
): Promise<Response> {
  return new Response(JSON.stringify({
    // Separate collections for private vs allowlist answers
    // Private: user_id encrypted, value encrypted (owner only)
    // Allowlist: user_id plain, value encrypted (owner + allowlist members)
    privateCollectionId: env.NILLION_PRIVATE_ANSWER_SCHEMA_ID,
    allowlistCollectionId: env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * POST /api/nillion/delegation-token
 * 
 * Issues a delegation token that allows the client to write to the
 * private answers collection in Nillion. The token is scoped to the
 * authenticated user's DID.
 * 
 * Request body:
 * - userDid: The user's Nillion DID (derived from their wallet keypair)
 * 
 * Response:
 * - delegationToken: Token for writing to Nillion
 * - collectionId: The private answers collection ID
 */
export async function handleGetDelegationToken(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Authenticate user
    const authResult = await requireFlexibleAuth(request, env);
    if (!authResult.authenticated || !authResult.fid) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Parse request body
    const body = await request.json() as { 
      userDid?: string; 
      collectionType?: 'private' | 'allowlist';
    };
    const { userDid, collectionType = 'private' } = body;

    if (!userDid) {
      return new Response(JSON.stringify({ error: 'userDid is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate userDid format (should be a DID string)
    if (!userDid.startsWith('did:')) {
      return new Response(JSON.stringify({ error: 'Invalid userDid format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Use the Nillion proxy to generate delegation token
    // The proxy has the org key and can create delegation tokens
    const proxyUrl = env.NILLION_PROXY_URL;
    const proxySecret = env.NILLION_PROXY_SECRET;

    if (!proxyUrl || !proxySecret) {
      console.error('[NILLION] Proxy URL or secret not configured');
      return new Response(JSON.stringify({ error: 'Nillion not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Request delegation token from proxy
    // Use 'private' or 'allowlist' collection type based on request
    const response = await fetch(`${proxyUrl}/v1/delegation-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Secret': proxySecret,
      },
      body: JSON.stringify({
        userDid,
        userId: authResult.fid,
        collectionType, // 'private' or 'allowlist'
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[NILLION] Failed to get delegation token from proxy:', errorText);
      return new Response(JSON.stringify({ 
        error: 'Failed to generate delegation token',
        details: errorText,
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await response.json() as {
      delegationToken: string;
      collectionId: string;
    };

    return new Response(JSON.stringify({
      delegationToken: result.delegationToken,
      collectionId: result.collectionId,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[NILLION] Error getting delegation token:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * POST /api/answers/notify-private
 * 
 * Notifies the server that a private/allowlist answer was stored via E2E encryption.
 * 
 * PRIVACY-PRESERVING: The server does NOT store which user answered which question.
 * We only:
 * - Deduct points from the user (generic deduction, not tied to specific question in logs)
 * - Award points to question owner
 * - Increment anonymous answer count
 * 
 * The user's vault fetches their answers directly from Nillion (client-side).
 * Question pages query Nillion client-side to show "you answered privately".
 * 
 * Request body:
 * - q_id: The question ID (for count increment and owner lookup)
 * - audience: 'Private' or 'Allowlist' (for count column selection)
 */
export async function handleNotifyPrivateAnswer(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Authenticate user
    const authResult = await requireFlexibleAuth(request, env);
    if (!authResult.authenticated || !authResult.fid) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Parse request body - minimal data for privacy
    const body = await request.json() as {
      q_id?: string;
      audience?: 'Private' | 'Allowlist';
    };

    const { q_id, audience } = body;

    if (!q_id) {
      return new Response(JSON.stringify({ error: 'q_id is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get question owner for point award (we need this, but don't log user-question association)
    const query = await env.DB.prepare(
      `SELECT coiner_fid FROM queries WHERE id = ?`
    ).bind(q_id).first() as { coiner_fid?: number } | null;

    if (!query) {
      return new Response(JSON.stringify({ error: 'Question not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const answererFid = authResult.fid;
    const questionOwnerFid = query.coiner_fid;
    const finalAudience = audience || 'Private';

    // Import PointsService dynamically to avoid circular deps
    const { PointsService } = await import('../../worker/services/PointsService');
    const { answer_cost } = await import('../lib/consts');
    const pointsService = PointsService.fromEnv(env);

    // Deduct points from answerer (generic description - no question ID for privacy)
    const updatedPoints = await pointsService.deductPoints(
      answererFid,
      answer_cost,
      'private answer submitted'  // Generic - doesn't reveal which question
    );

    if (!updatedPoints) {
      const currentPoints = await pointsService.getPoints(answererFid);
      const totalSpendable = (currentPoints?.allowance || 0) + (currentPoints?.balance || 0);
      return new Response(JSON.stringify({ 
        error: `Insufficient QP. Required: ${answer_cost}, Available: ${totalSpendable}` 
      }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Award points to question owner (if different from answerer)
    // Note: This does create a link (owner knows someone answered their question)
    // but doesn't reveal WHO answered
    if (questionOwnerFid && questionOwnerFid !== answererFid) {
      await pointsService.addEarnedPoints(
        questionOwnerFid,
        answer_cost,
        'earned from private answer'  // Generic - doesn't reveal who answered
      );
    }

    // Update answer count for the question (anonymous increment)
    // NO D1 record linking user to question - preserves privacy
    const countColumn = finalAudience === 'Allowlist' ? 'allowlist_answers' : 'priv_answers';
    await env.DB.prepare(
      `UPDATE queries SET ${countColumn} = ${countColumn} + 1 WHERE id = ?`
    ).bind(q_id).run();

    // Minimal logging - no user-question association
    console.log(`[E2E] Private answer recorded (count incremented, points processed)`);

    return new Response(JSON.stringify({
      success: true,
      message: 'E2E answer recorded (privacy-preserving)',
      points: updatedPoints,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[E2E] Error handling E2E answer notification:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}


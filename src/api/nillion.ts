/**
 * Nillion API Endpoints
 * 
 * Handles:
 * - Delegation token generation for E2E encrypted answers
 * - Private answer notifications (bookkeeping without data)
 */

import { requireFlexibleAuth } from '../../worker/middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

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
    const body = await request.json() as { userDid?: string };
    const { userDid } = body;

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
    // Use 'e2e' collection type for the owned collection (E2E encrypted)
    const response = await fetch(`${proxyUrl}/v1/delegation-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Secret': proxySecret,
      },
      body: JSON.stringify({
        userDid,
        userId: authResult.fid,
        collectionType: 'e2e', // User-owned collection for E2E encryption
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[NILLION] Failed to get delegation token:', errorText);
      return new Response(JSON.stringify({ error: 'Failed to generate delegation token' }), {
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
 * Notifies the server that a private answer was stored via E2E encryption.
 * The server doesn't receive the actual answer data, just metadata for
 * bookkeeping (counts, indexing, etc.).
 * 
 * Request body:
 * - q_id: The question ID
 * - answer_id: The answer ID (generated client-side)
 * - primary_type: The answer's primary type
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

    // Parse request body
    const body = await request.json() as {
      q_id?: string;
      answer_id?: string;
      primary_type?: string;
    };

    const { q_id, answer_id, primary_type } = body;

    if (!q_id || !answer_id) {
      return new Response(JSON.stringify({ error: 'q_id and answer_id are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update answer count for the question
    await env.DB.prepare(
      `UPDATE queries SET priv_answers = priv_answers + 1 WHERE id = ?`
    ).bind(q_id).run();

    // Log for analytics (no sensitive data)
    console.log(`[NILLION] E2E private answer stored: q_id=${q_id}, answer_id=${answer_id}, fid=${authResult.fid}, type=${primary_type}`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Private answer notification recorded',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[NILLION] Error handling private answer notification:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}


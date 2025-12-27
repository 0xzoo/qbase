import { AllowlistService } from '../../worker/services/AllowlistService';
import { NeynarAllowlistHelper } from '../../worker/services/NeynarAllowlistHelper';
import { AuthService } from '../../worker/services/AuthService';
import type { Env } from '../../worker-configuration';

/**
 * Handle allowlist CRUD operations
 * Routes:
 * - POST /api/allowlists - Create new allowlist
 * - GET /api/allowlists - List user's allowlists
 * - GET /api/allowlists/:id - Get specific allowlist
 * - PUT /api/allowlists/:id - Update allowlist (manual only)
 * - DELETE /api/allowlists/:id - Delete allowlist
 * - POST /api/allowlists/:id/refresh - Refresh besties list
 * - POST /api/allowlists/import/besties - Import besties from Neynar
 */
export async function handleAllowlistRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/').filter(p => p);

  // Verify authentication
  const authService = AuthService.fromEnv(env);
  const auth = await authService.verifyAuthHeader(request.headers.get('Authorization'));

  if (!auth.valid || !auth.fid) {
    return new Response(JSON.stringify({ error: auth.error || 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Get internal user ID from FID
  const userRow = await env.DB.prepare('SELECT id FROM users WHERE fid = ?')
    .bind(auth.fid)
    .first() as { id: number } | null;

  if (!userRow) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const userId = userRow.id;

  try {
    // POST /api/allowlists - Create new allowlist
    if (pathParts.length === 2 && request.method === 'POST') {
      const body = await request.json() as {
        name: string;
        description?: string;
        list_type: string;
        source_params?: { fid?: number; limit?: number };
        members?: number[];
      };

      const allowlist = await AllowlistService.create(env, userId, body as { name: string; description?: string; list_type: string; source_params?: Record<string, unknown>; members?: number[] });
      return Response.json(allowlist);
    }

    // GET /api/allowlists - List all allowlists for user
    if (pathParts.length === 2 && request.method === 'GET') {
      const allowlists = await AllowlistService.list(env, userId);
      return Response.json(allowlists);
    }

    // GET /api/allowlists/:id - Get specific allowlist
    if (pathParts.length === 3 && request.method === 'GET') {
      const allowlistId = pathParts[2];
      const allowlist = await AllowlistService.get(env, allowlistId, userId);

      if (!allowlist) {
        return new Response(JSON.stringify({ error: 'Allowlist not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return Response.json(allowlist);
    }

    // PUT /api/allowlists/:id - Update allowlist
    if (pathParts.length === 3 && request.method === 'PUT') {
      const allowlistId = pathParts[2];
      const body = await request.json() as {
        name?: string;
        description?: string;
        members?: number[];
      };

      const allowlist = await AllowlistService.update(env, allowlistId, userId, body);
      return Response.json(allowlist);
    }

    // DELETE /api/allowlists/:id - Delete allowlist
    if (pathParts.length === 3 && request.method === 'DELETE') {
      const allowlistId = pathParts[2];
      await AllowlistService.delete(env, allowlistId, userId);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // POST /api/allowlists/:id/refresh - Refresh besties list
    if (pathParts.length === 4 && pathParts[3] === 'refresh' && request.method === 'POST') {
      const allowlistId = pathParts[2];
      const neynarApiKey = env.NEYNAR_API_KEY;

      if (!neynarApiKey) {
        return new Response(JSON.stringify({ error: 'Neynar API key not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const importBestiesFn = async (fid: number, limit: number) => {
        return NeynarAllowlistHelper.importBesties(fid, neynarApiKey, limit);
      };

      const allowlist = await AllowlistService.refreshFromNeynar(
        env,
        allowlistId,
        userId,
        importBestiesFn
      );

      return Response.json(allowlist);
    }

    // POST /api/allowlists/import/besties - Import besties from Neynar
    if (pathParts.length === 4 && pathParts[2] === 'import' && pathParts[3] === 'besties' && request.method === 'POST') {
      const body = await request.json() as {
        fid: number;
        name: string;
        description?: string;
        limit?: number;
      };

      const neynarApiKey = env.NEYNAR_API_KEY;
      if (!neynarApiKey) {
        return new Response(JSON.stringify({ error: 'Neynar API key not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Import besties from Neynar
      const fids = await NeynarAllowlistHelper.importBesties(body.fid, neynarApiKey, body.limit || 50);
      const userIds = await AllowlistService.resolveFidsToUserIds(env, fids);

      // Create allowlist
      const allowlist = await AllowlistService.create(env, userId, {
        name: body.name,
        description: body.description,
        list_type: 'besties',
        source_params: { fid: body.fid, limit: body.limit || 50 },
        members: userIds,
      });

      return Response.json(allowlist);
    }

    return new Response(JSON.stringify({ error: 'Invalid route' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('Allowlist API error:', error);
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

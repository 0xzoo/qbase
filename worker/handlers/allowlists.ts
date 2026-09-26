import { AllowlistService } from '../services/AllowlistService';
import { AllowlistGraphHelper } from '../services/AllowlistGraphHelper';
import { requireFlexibleAuth } from '../middleware/auth';
import type { AllowlistType } from '../../src/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

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

  // Verify authentication. The allowlist owner (allowlists.user_id) is the
  // person key (fid before the account cutover, account id after); the
  // besties import below is a Farcaster graph operation on a fid.
  const auth = await requireFlexibleAuth(request, env);

  if (!auth.authenticated || auth.userKey === undefined) {
    return new Response(JSON.stringify({ error: auth.error || 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // The caller's profile row. `Users` has no `id` column (the old
  // `SELECT id FROM users` could never succeed); the row is keyed by the
  // person key in `fid`.
  const userRow = await env.DB.prepare('SELECT fid FROM users WHERE fid = ?')
    .bind(auth.userKey)
    .first() as { fid: number } | null;

  if (!userRow) {
    return new Response(JSON.stringify({ error: 'User not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const userId = userRow.fid;

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

      const allowlist = await AllowlistService.create(env, userId, body as { name: string; description?: string; list_type: AllowlistType; source_params?: { fid?: number; limit?: number }; members?: number[] });
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

      const importBestiesFn = async (fid: number, limit: number) => {
        return AllowlistGraphHelper.importBesties(env, fid, limit);
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

      // Import besties through the data router (Haatz first, Neynar fallback).
      // A Farcaster graph op: body.fid is a Farcaster fid (not a person key).
      // TODO(account-root): resolveFidsToUserIds (AllowlistService) still
      // selects a nonexistent `users.id`; after the cutover members should be
      // mapped fid → person key through lookupUserKeyForFid.
      const fids = await AllowlistGraphHelper.importBesties(env, body.fid, body.limit || 50);
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

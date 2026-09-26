/**
 * Follow API Routes
 * 
 * Handles:
 * - POST /api/follows - Follow a user
 * - DELETE /api/follows/:fid - Unfollow a user
 * - GET /api/follows/:fid/followers - Get user's followers
 * - GET /api/follows/:fid/following - Get user's following
 * - GET /api/follows/check?target=FID - Check if following a user
 *
 * Identity resolution: after the account cutover, the stringified account id
 * (the cutover rewrites both legacy forms — numeric fids and passkey
 * addresses — to it). Before: quil_address (passkey) or the stringified fid.
 * Route params and `target_fid` are Farcaster fids, mapped to person keys.
 * FollowService now uses TEXT-based identity (migration 0033).
 */

import { requireFlexibleAuth } from '../middleware/auth';
import { FollowService } from '../services/FollowService';
import { UserService } from '../services/UserService';
import { lookupUserKeyForFid, userKeyForFid } from '../services/accounts/AccountService';

import type { AuthResult } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle follow-related API routes
 */
export async function handleFollowRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // POST /api/follows - Follow a user
  if (pathname === '/api/follows' && request.method === 'POST') {
    return handleFollow(request, env);
  }

  // DELETE /api/follows/:fid - Unfollow a user
  const deleteMatch = pathname.match(/^\/api\/follows\/(\d+)$/);
  if (deleteMatch && request.method === 'DELETE') {
    const targetFid = parseInt(deleteMatch[1], 10);
    return handleUnfollow(request, env, targetFid);
  }

  // GET /api/follows/:fid/followers - Get user's followers
  // TODO(account-root): results' user_id values are person keys (account ids after
  // the cutover) or passkey addresses, not fids; the client must not treat them as fids.
  const followersMatch = pathname.match(/^\/api\/follows\/(\d+)\/followers$/);
  if (followersMatch && request.method === 'GET') {
    const fid = parseInt(followersMatch[1], 10);
    const key = await lookupUserKeyForFid(env, fid);
    if (key === undefined) return emptyList(request, 'results');
    return handleGetFollowers(request, env, String(key));
  }

  // GET /api/follows/:fid/following - Get user's following
  const followingMatch = pathname.match(/^\/api\/follows\/(\d+)\/following$/);
  if (followingMatch && request.method === 'GET') {
    const fid = parseInt(followingMatch[1], 10);
    const key = await lookupUserKeyForFid(env, fid);
    if (key === undefined) return emptyList(request, 'results');
    return handleGetFollowing(request, env, String(key));
  }

  // GET /api/follows/check?target=FID - Check if following a user
  if (pathname === '/api/follows/check' && request.method === 'GET') {
    const targetFid = url.searchParams.get('target');
    if (!targetFid) {
      return Response.json({ error: 'target query parameter is required' }, { status: 400 });
    }
    return handleCheckFollowing(request, env, parseInt(targetFid, 10));
  }

  return null;
}

/** The empty page a list route returns for a fid with no account (after the cutover). */
function emptyList(request: Request, field: string): Response {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  return Response.json({ [field]: [], total: 0, limit, offset });
}

/**
 * Resolve an AuthResult to a follow ID string.
 * Uses quil_address if available (passkey users), falls back to the stringified person key.
 */
async function resolveAuthToFollowId(auth: AuthResult, env: Env): Promise<string | null> {
  if (auth.accountId !== undefined) return String(auth.accountId);
  if (auth.quilAddress) return auth.quilAddress;
  if (auth.userKey !== undefined) {
    const user = await UserService.getByFid(env, auth.userKey);
    if (user?.quil_address) return user.quil_address;
    return String(auth.userKey);
  }
  if (auth.passkeyAddress) return auth.passkeyAddress;
  return null;
}

/**
 * POST /api/follows - Follow a user
 * Body: { target_fid: number }
 */
async function handleFollow(request: Request, env: Env): Promise<Response> {
  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated) {
    return new Response(auth.error || 'Unauthorized', { status: 401 });
  }

  const followerId = await resolveAuthToFollowId(auth, env);
  if (!followerId) {
    return new Response('Could not resolve user identity', { status: 401 });
  }

  try {
    const body = await request.json() as { target_fid?: number };
    const { target_fid } = body;

    if (!target_fid || typeof target_fid !== 'number' || target_fid <= 0) {
      return Response.json({ error: 'target_fid is required and must be a positive number' }, { status: 400 });
    }

    // target_fid is a Farcaster fid; the follows row carries the target's person key.
    // TODO(account-root): no way to follow an account without Farcaster (target by account id).
    const targetId = String(await userKeyForFid(env, target_fid));

    // Prevent self-follow
    if (followerId === targetId) {
      return Response.json({ error: 'Cannot follow yourself' }, { status: 400 });
    }

    const followService = FollowService.fromEnv(env);
    const success = await followService.follow(followerId, targetId);

    if (success) {
      return Response.json({ success: true, message: 'Now following user' });
    } else {
      return Response.json({ success: false, message: 'Already following this user' });
    }
  } catch (error) {
    console.error('[FollowRoutes] Error following user:', error);
    return Response.json({ error: 'Failed to follow user' }, { status: 500 });
  }
}

/**
 * DELETE /api/follows/:fid - Unfollow a user
 */
async function handleUnfollow(request: Request, env: Env, targetFid: number): Promise<Response> {
  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated) {
    return new Response(auth.error || 'Unauthorized', { status: 401 });
  }

  const followerId = await resolveAuthToFollowId(auth, env);
  if (!followerId) {
    return new Response('Could not resolve user identity', { status: 401 });
  }
  const targetKey = await lookupUserKeyForFid(env, targetFid);
  if (targetKey === undefined) {
    return Response.json({ success: false, message: 'Not following this user' });
  }
  const targetId = String(targetKey);

  try {
    const followService = FollowService.fromEnv(env);
    const success = await followService.unfollow(followerId, targetId);

    if (success) {
      return Response.json({ success: true, message: 'Unfollowed user' });
    } else {
      return Response.json({ success: false, message: 'Not following this user' });
    }
  } catch (error) {
    console.error('[FollowRoutes] Error unfollowing user:', error);
    return Response.json({ error: 'Failed to unfollow user' }, { status: 500 });
  }
}

/**
 * GET /api/follows/:fid/followers - Get user's followers
 */
async function handleGetFollowers(request: Request, env: Env, userId: string): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  try {
    const followService = FollowService.fromEnv(env);
    const result = await followService.getFollowers(userId, limit, offset);

    return Response.json({
      results: result.followers,
      total: result.total,
      limit,
      offset
    });
  } catch (error) {
    console.error('[FollowRoutes] Error getting followers:', error);
    return Response.json({ error: 'Failed to get followers' }, { status: 500 });
  }
}

/**
 * GET /api/follows/:fid/following - Get user's following
 */
async function handleGetFollowing(request: Request, env: Env, userId: string): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  try {
    const followService = FollowService.fromEnv(env);
    const result = await followService.getFollowing(userId, limit, offset);

    return Response.json({
      results: result.following,
      total: result.total,
      limit,
      offset
    });
  } catch (error) {
    console.error('[FollowRoutes] Error getting following:', error);
    return Response.json({ error: 'Failed to get following' }, { status: 500 });
  }
}

/**
 * GET /api/follows/check?target=FID - Check if following a user
 */
async function handleCheckFollowing(request: Request, env: Env, targetFid: number): Promise<Response> {
  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated) {
    return new Response(auth.error || 'Unauthorized', { status: 401 });
  }

  try {
    const followerId = await resolveAuthToFollowId(auth, env);
    if (!followerId) {
      return new Response('Could not resolve user identity', { status: 401 });
    }
    const targetKey = await lookupUserKeyForFid(env, targetFid);
    if (targetKey === undefined) return Response.json({ is_following: false });
    const targetId = String(targetKey);
    const followService = FollowService.fromEnv(env);
    const isFollowing = await followService.isFollowing(followerId, targetId);

    return Response.json({ is_following: isFollowing });
  } catch (error) {
    console.error('[FollowRoutes] Error checking follow status:', error);
    return Response.json({ error: 'Failed to check follow status' }, { status: 500 });
  }
}

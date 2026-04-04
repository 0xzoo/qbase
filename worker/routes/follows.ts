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
 * Identity resolution: quil_address (passkey) or stringified FID (miniapp-only).
 * FollowService now uses TEXT-based identity (migration 0033).
 */

import { requireFlexibleAuth } from '../middleware/auth';
import { FollowService } from '../services/FollowService';
import { UserService } from '../services/UserService';

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
  const followersMatch = pathname.match(/^\/api\/follows\/(\d+)\/followers$/);
  if (followersMatch && request.method === 'GET') {
    const fid = parseInt(followersMatch[1], 10);
    return handleGetFollowers(request, env, String(fid));
  }

  // GET /api/follows/:fid/following - Get user's following
  const followingMatch = pathname.match(/^\/api\/follows\/(\d+)\/following$/);
  if (followingMatch && request.method === 'GET') {
    const fid = parseInt(followingMatch[1], 10);
    return handleGetFollowing(request, env, String(fid));
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

/**
 * Resolve an AuthResult to a follow ID string.
 * Uses quil_address if available (passkey users), falls back to stringified FID.
 */
async function resolveAuthToFollowId(auth: AuthResult, env: Env): Promise<string | null> {
  if (auth.quilAddress) return auth.quilAddress;
  if (auth.fid) {
    const user = await UserService.getByFid(env, auth.fid);
    if (user?.quil_address) return user.quil_address;
    return String(auth.fid);
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

    const targetId = String(target_fid);

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
  const targetId = String(targetFid);

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
    const targetId = String(targetFid);
    const followService = FollowService.fromEnv(env);
    const isFollowing = await followService.isFollowing(followerId, targetId);

    return Response.json({ is_following: isFollowing });
  } catch (error) {
    console.error('[FollowRoutes] Error checking follow status:', error);
    return Response.json({ error: 'Failed to check follow status' }, { status: 500 });
  }
}

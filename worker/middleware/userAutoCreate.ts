/**
 * User Auto-Creation Middleware
 * 
 * Automatically creates user records when authenticated users don't exist in DB.
 * This is especially useful for web users who authenticate via SIWF but don't
 * have a way to explicitly call the user creation endpoint.
 */

import { UserService } from '../services/UserService';
import { initFarcasterData } from '../services/farcaster';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Ensure user exists in database, creating if necessary
 * Also syncs Pro subscription status from Neynar on each call
 * 
 * @param env - Cloudflare environment
 * @param fid - Farcaster ID from authentication
 * @param username - Optional username (resolved via the Farcaster data providers if not provided)
 * @returns User record with internal ID
 */
export async function ensureUserExists(
  env: Env, 
  fid: number, 
  username?: string
): Promise<{ id: number; fid: number; fname: string } | null> {
  try {
    // Check if user exists
    let user = await UserService.getByFid(env, fid);
    const isNewUser = !user;
    
    if (isNewUser) {
      console.log(`[AUTO-CREATE] User with FID ${fid} not found, fetching profile...`);
    }

    // Fetch the profile (Neynar → hub); pro status is a Neynar-only field.
    // We do this on every login to keep pro status fresh.
    let fname = username;
    let displayName: string | undefined;
    let pfpUrl: string | undefined;
    let proStatus: 'subscribed' | 'unsubscribed' | undefined;
    let proExpiresAt: string | undefined;

    try {
      // `need: ['pro']` — pro status is Neynar-only; the router enriches it when Haatz answered first.
      const fcUser = await initFarcasterData(env).getUser(fid, { need: ['pro'] });
      if (fcUser) {
        fname = fname || fcUser.username;
        displayName = fcUser.display_name;
        pfpUrl = fcUser.pfp_url;
        if (fcUser.pro) {
          proStatus = fcUser.pro.status;
          proExpiresAt = fcUser.pro.expires_at;
        }
        console.log(`[AUTO-CREATE] Fetched profile for ${fname} (pro: ${proStatus || 'none'}, via ${fcUser.provider})`);
      }
    } catch (error) {
      console.error('[AUTO-CREATE] Failed to fetch profile:', error);
    }

    // Fallback to FID-based username if still not available
    if (!fname) {
      fname = `fid-${fid}`;
      console.warn(`[AUTO-CREATE] Using fallback username: ${fname}`);
    }
    
    // Create or update user (upsert always updates pro status)
    user = await UserService.upsert(env, {
      fid,
      fname,
      displayName,
      pfpUrl,
      proStatus,
      proExpiresAt,
    });
    
    if (isNewUser) {
      console.log(`[AUTO-CREATE] ✅ Created user ${fname} (FID: ${fid}, ID: ${user.id})`);
    }
    
    return {
      id: user.id,
      fid: user.fid || 0,
      fname: user.fname,
    };
  } catch (error) {
    console.error('[AUTO-CREATE] Error ensuring user exists:', error);
    return null;
  }
}


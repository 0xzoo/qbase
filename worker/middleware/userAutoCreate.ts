/**
 * User Auto-Creation Middleware
 * 
 * Automatically creates user records when authenticated users don't exist in DB.
 * This is especially useful for web users who authenticate via SIWF but don't
 * have a way to explicitly call the user creation endpoint.
 */

import { UserService } from '../services/UserService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Ensure user exists in database, creating if necessary
 * Also syncs Pro subscription status from Neynar on each call
 * 
 * @param env - Cloudflare environment
 * @param fid - Farcaster ID from authentication
 * @param username - Optional username (fetched from Neynar if not provided)
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

    // Fetch from Neynar to get profile and pro status
    // We do this on every login to keep pro status fresh
    let fname = username;
    let displayName: string | undefined;
    let pfpUrl: string | undefined;
    let proStatus: 'subscribed' | 'unsubscribed' | undefined;
    let proExpiresAt: string | undefined;
    
    if (env.NEYNAR_API_KEY) {
      try {
        const response = await fetch(
          `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
          {
            headers: {
              'x-api-key': env.NEYNAR_API_KEY,
            },
          }
        );
        
        if (response.ok) {
          const data = await response.json() as { 
            users?: Array<{ 
              username: string; 
              display_name?: string;
              pfp_url?: string;
              pro?: {
                status: 'subscribed' | 'unsubscribed';
                subscribed_at: string;
                expires_at: string;
              };
            }> 
          };
          const neynarUser = data.users?.[0];
          if (neynarUser) {
            fname = fname || neynarUser.username;
            displayName = neynarUser.display_name;
            pfpUrl = neynarUser.pfp_url;
            // Extract pro subscription status
            if (neynarUser.pro) {
              proStatus = neynarUser.pro.status;
              proExpiresAt = neynarUser.pro.expires_at;
            }
            console.log(`[AUTO-CREATE] Fetched profile for ${fname} (pro: ${proStatus || 'none'})`);
          }
        }
      } catch (error) {
        console.error('[AUTO-CREATE] Failed to fetch Neynar profile:', error);
      }
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


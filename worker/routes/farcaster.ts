/**
 * FarCaster API Routes
 * 
 * Handles:
 * - POST /api/farcaster/cast - Publish a cast
 * - GET /api/user/:fid/avatar - Get user avatar from KV cache
 * - GET /api/channels/search - Search FarCaster channels
 * - GET /api/farcaster/conversation/:castHash - Fetch cast conversation/replies
 * - POST /api/farcaster/sync-stats - Update cached FarCaster engagement stats
 */

import { RateLimitService } from '../services/RateLimitService';
import { createSignerService } from '../services/NeynarSignerService';
// import removed - inlined below
import { requireFlexibleAuth } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle farcaster-related API routes
 */
export async function handleFarcasterRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // POST /api/farcaster/cast - Publish a cast using an approved signer
  // Body: { signerUuid?, useAnonBot?, text, embeds?, parent?, parentAuthorFid?, entityType?, entityId? }
  // Supports both user casts (requires auth + signerUuid) and anon bot casts (useAnonBot: true)
  if (pathname === "/api/farcaster/cast" && request.method === "POST") {
    try {
      const body = await request.json() as {
        signerUuid?: string;        // User's signer (for regular casts)
        useAnonBot?: boolean;       // Flag to use anon bot
        text: string;
        embeds?: { url: string }[];
        parent?: string;            // Parent cast hash (for replies)
        parentAuthorFid?: number;   // Parent cast author FID (for replies)
        entityType?: 'query' | 'answer';  // Optional: type of entity being casted
        entityId?: string;          // Optional: ID of entity being casted
      };
      const { signerUuid, useAnonBot, text, embeds, parent, parentAuthorFid, entityType, entityId } = body;

      if (!text) {
        return Response.json(
          { error: 'text is required' },
          { status: 400 }
        );
      }

      let effectiveSignerUuid: string;
      let apiKey: string;

      if (useAnonBot) {
        // Use anon bot signer and separate API key (no auth required)
        if (!env.NEYNAR_ANON_BOT_SIGNER_UUID) {
          return Response.json(
            { error: 'Anon bot signer not configured' },
            { status: 500 }
          );
        }
        if (!env.NEYNAR_ANON_BOT_API_KEY) {
          return Response.json(
            { error: 'Anon bot API key not configured' },
            { status: 500 }
          );
        }
        effectiveSignerUuid = env.NEYNAR_ANON_BOT_SIGNER_UUID;
        apiKey = env.NEYNAR_ANON_BOT_API_KEY;
        console.log('Posting cast from anon bot (@4n0n)');
      } else {
        // Regular user cast - requires authentication
        const auth = await requireFlexibleAuth(request, env);
        if (!auth.authenticated) {
          return new Response(auth.error || "Unauthorized", { status: 401 });
        }

        if (!signerUuid) {
          return Response.json(
            { error: 'signerUuid required for user casts' },
            { status: 400 }
          );
        }

        effectiveSignerUuid = signerUuid;
        apiKey = env.NEYNAR_API_KEY;
      }

      const signerService = createSignerService(apiKey);
      const result = await signerService.publishCast(effectiveSignerUuid, text, embeds, parent, parentAuthorFid);

      // Store cast hash in database if entity info provided
      if (entityType && entityId && result.cast?.hash) {
        try {
          const { FarcasterDBService } = await import('../services/FarcasterDBService');
          const { anon_fid } = await import('../../src/lib/consts');

          // Determine caster FID and username
          let casterFid: number;
          let casterUsername: string;

          if (useAnonBot) {
            casterFid = anon_fid;
            casterUsername = '4n0n';
          } else {
            // Get user info from auth
            const auth = await requireFlexibleAuth(request, env);
            casterFid = auth.fid || 0;
            casterUsername = 'user';
          }

          await FarcasterDBService.upsertCast(env.DB, {
            entity_type: entityType,
            entity_id: entityId,
            cast_hash: result.cast.hash,
            cast_url: `https://farcaster.xyz/${casterUsername}/${result.cast.hash}`,
            caster_fid: casterFid,
          });

          console.log(`Stored cast hash for ${entityType} ${entityId} in database`);
        } catch (dbError) {
          // Don't fail the cast if DB storage fails
          console.error('Failed to store cast hash in database:', dbError);
        }
      }

      return Response.json(result);
    } catch (e) {
      console.error("Error publishing cast:", e);
      return Response.json(
        { error: 'Failed to publish cast' },
        { status: 500 }
      );
    }
  }

  // GET /api/user/:fid/avatar - Get user avatar from KV cache
  const avatarMatch = pathname.match(/^\/api\/user\/(\d+)\/avatar$/);
  if (avatarMatch && request.method === "GET") {
    const fid = parseInt(avatarMatch[1], 10);

    if (isNaN(fid)) {
      return Response.json({ error: 'Invalid FID' }, { status: 400 });
    }

    try {
      const cacheKey = `user_pfp:${fid}`;
      let avatarUrl = await env.KV_USER_PROFILES.get(cacheKey);

      // If not in cache, fetch from Neynar and cache it
      if (!avatarUrl) {
        const neynarResponse = await fetch(
          `https://api.neynar.com/v2/farcaster/user/bulk?fids=${fid}`,
          {
            headers: {
              "x-api-key": env.NEYNAR_API_KEY,
              "x-neynar-experimental": "true"
            },
          }
        );

        if (neynarResponse.ok) {
          const data = await neynarResponse.json() as { users?: { pfp_url?: string }[] };
          avatarUrl = data.users?.[0]?.pfp_url || null;

          // Cache for 24 hours
          if (avatarUrl) {
            await env.KV_USER_PROFILES.put(cacheKey, avatarUrl, {
              expirationTtl: 86400
            });
          }
        }
      }

      return Response.json({ avatarUrl });
    } catch (error) {
      console.error(`Error fetching avatar for FID ${fid}:`, error);
      return Response.json({ avatarUrl: null }, { status: 200 }); // Return null on error, don't fail
    }
  }

  // GET /api/channels/search - Search FarCaster channels
  // Query params: q (search query), limit (default 10, max 20)
  if (pathname === "/api/channels/search" && request.method === "GET") {
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 30, 60, 'channels:search'); // 30 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    try {
      const query = url.searchParams.get('q');
      if (!query || query.length < 1) {
        return Response.json({ channels: [] });
      }

      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 20);

      const neynarResponse = await fetch(
        `https://api.neynar.com/v2/farcaster/channel/search?q=${encodeURIComponent(query)}&limit=${limit}`,
        {
          headers: {
            "x-api-key": env.NEYNAR_API_KEY,
          },
        }
      );

      if (!neynarResponse.ok) {
        console.error('[Channels] Neynar search failed:', neynarResponse.status);
        return Response.json({ channels: [] });
      }

      const data = await neynarResponse.json() as {
        channels?: Array<{
          id: string;
          url: string;
          name: string;
          description?: string;
          image_url?: string;
          follower_count?: number;
          lead?: {
            fid: number;
            username: string;
            display_name: string;
            pfp_url?: string;
          };
        }>
      };

      return Response.json({ channels: data.channels || [] });
    } catch (error) {
      console.error("Error searching channels:", error);
      return Response.json({ channels: [] });
    }
  }

  // GET /api/farcaster/conversation/:castHash - Fetch cast conversation/replies
  const conversationMatch = pathname.match(/^\/api\/farcaster\/conversation\/([a-zA-Z0-9]+)$/);
  if (conversationMatch && request.method === "GET") {
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 60, 60, 'farcaster:conversation'); // 60 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    try {
      const castHash = conversationMatch[1];
      const viewerFid = url.searchParams.get('viewer_fid');
      const limit = parseInt(url.searchParams.get('limit') || '25');

      const signerService = createSignerService(env.NEYNAR_API_KEY);
      const conversation = await signerService.getCastConversation(
        castHash,
        viewerFid ? parseInt(viewerFid) : undefined,
        1, // reply depth
        Math.min(limit, 50) // cap at 50
      );

      // If conversation is null, the cast was deleted on FarCaster
      if (conversation === null) {
        // Clear the cast_hash from the queries table
        try {
          await env.DB.prepare(
            "UPDATE Queries SET cast_hash = NULL WHERE cast_hash = ?"
          ).bind(castHash).run();
          console.log(`[Farcaster] Cleared deleted cast_hash ${castHash} from queries table`);
        } catch (dbError) {
          console.error('Error clearing deleted cast_hash from DB:', dbError);
        }

        // Return empty conversation structure
        return Response.json({
          cast: null,
          replies: [],
          deleted: true,
        });
      }

      return Response.json(conversation);
    } catch (error) {
      console.error("Error fetching cast conversation:", error);
      return Response.json(
        { error: 'Failed to fetch conversation' },
        { status: 500 }
      );
    }
  }

  // POST /api/farcaster/sync-stats - Update cached FarCaster engagement stats for a cast
  // Body: { castHash, likes_count, recasts_count, replies_count, pub_answers? }
  if (pathname === "/api/farcaster/sync-stats" && request.method === "POST") {
    const rateLimitService = RateLimitService.fromEnv(env);
    const allowed = await rateLimitService.checkLimit(ip, 30, 60, 'farcaster:sync-stats'); // 30 req/min
    if (!allowed) {
      return new Response("Too Many Requests", { status: 429 });
    }

    try {
      const body = await request.json() as {
        castHash: string;
        likes_count: number;
        recasts_count: number;
        replies_count: number;
        pub_answers?: number;
      };
      const { castHash, likes_count, recasts_count, replies_count, pub_answers } = body;

      if (!castHash) {
        return Response.json(
          { error: 'castHash is required' },
          { status: 400 }
        );
      }

      // Validate counts are non-negative numbers
      if (typeof likes_count !== 'number' || typeof recasts_count !== 'number' || typeof replies_count !== 'number') {
        return Response.json(
          { error: 'likes_count, recasts_count, and replies_count must be numbers' },
          { status: 400 }
        );
      }

      const { FarcasterDBService } = await import('../services/FarcasterDBService');
      const updated = await FarcasterDBService.updateCachedStats(env.DB, castHash, {
        likes_count: Math.max(0, likes_count),
        recasts_count: Math.max(0, recasts_count),
        replies_count: Math.max(0, replies_count),
      });

      // Also update pub_answers on the queries table if provided
      let pubAnswersUpdated = false;
      if (typeof pub_answers === 'number' && pub_answers >= 0) {
        // Look up the query ID from the cast hash
        const cast = await FarcasterDBService.getCastByHash(env.DB, castHash);
        if (cast && cast.entity_type === 'query') {
          await env.DB.prepare(
            'UPDATE queries SET pub_answers = ? WHERE id = ?'
          ).bind(Math.max(0, pub_answers), cast.entity_id).run();
          pubAnswersUpdated = true;
          console.log(`[Farcaster Stats] Updated pub_answers to ${pub_answers} for query ${cast.entity_id}`);
        }
      }

      if (!updated) {
        // Cast not found in our database, that's OK - just log it
        console.log(`[Farcaster Stats] No cast found for hash ${castHash}, skipping stats update`);
      }

      return Response.json({
        success: true,
        updated,
        pubAnswersUpdated,
        castHash,
        stats: { likes_count, recasts_count, replies_count, pub_answers }
      });
    } catch (error) {
      console.error("Error updating FarCaster stats:", error);
      return Response.json(
        { error: 'Failed to update FarCaster stats' },
        { status: 500 }
      );
    }
  }

  return null;
}

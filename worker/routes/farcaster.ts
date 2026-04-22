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
// import removed - inlined below

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle farcaster-related API routes
 */
export async function handleFarcasterRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // POST /api/farcaster/cast - Publish a cast via Hypersnap hub protocol
  // Body: { useAnonBot?, text, embeds?, parent?, parentAuthorFid?, entityType?, entityId? }
  // Anon bot casts use ANON_SIGNER_KEY (no auth required).
  // User casting is disabled — FC is read-only for users.
  if (pathname === "/api/farcaster/cast" && request.method === "POST") {
    try {
      const body = await request.json() as {
        useAnonBot?: boolean;       // Flag to use anon bot
        text: string;
        embeds?: { url: string }[];
        parent?: string;            // Parent cast hash (for replies)
        parentAuthorFid?: number;   // Parent cast author FID (for replies)
        entityType?: 'query' | 'answer';  // Optional: type of entity being casted
        entityId?: string;          // Optional: ID of entity being casted
      };
      const { useAnonBot, text, embeds, parent, parentAuthorFid, entityType, entityId } = body;

      if (!text) {
        return Response.json(
          { error: 'text is required' },
          { status: 400 }
        );
      }

      let signerKey: string;
      let casterFid: number;
      let casterUsername: string;

      if (useAnonBot) {
        // Use anon bot signer (no auth required)
        const anonKey: string | undefined = env.ANON_SIGNER_KEY;
        if (!anonKey) {
          return Response.json(
            { error: 'Anon bot signer not configured' },
            { status: 500 }
          );
        }
        signerKey = anonKey;
        casterFid = Number(env.ANON_FID) || 514282;
        casterUsername = '4n0n';
        console.log('Posting cast from anon bot (@4n0n) via Hypersnap');
      } else {
        return Response.json(
          { error: 'User casting is disabled — FC is read-only' },
          { status: 400 }
        );
      }

      const { createHypersnapService } = await import('../services/HypersnapService');
      const hypersnap = createHypersnapService(env);
      const result = await hypersnap.publishCast({
        signerKey,
        fid: casterFid,
        text,
        embeds: embeds ?? [],
        parentHash: parent,
        parentAuthorFid,
      });

      // Store cast hash in database if entity info provided
      if (entityType && entityId && result.hash) {
        try {
          const { FarcasterDBService } = await import('../services/FarcasterDBService');

          await FarcasterDBService.upsertCast(env.DB, {
            entity_type: entityType,
            entity_id: entityId,
            cast_hash: result.hash,
            cast_url: `https://farcaster.xyz/${casterUsername}/${result.hash}`,
            caster_fid: casterFid,
          });

          console.log(`Stored cast hash for ${entityType} ${entityId} in database`);
        } catch (dbError) {
          // Don't fail the cast if DB storage fails
          console.error('Failed to store cast hash in database:', dbError);
        }
      }

      return Response.json({ cast: { hash: result.hash, author: { fid: result.author_fid }, text: result.text } });
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
      const limit = parseInt(url.searchParams.get('limit') || '25');

      // Fetch cast + replies via Hypersnap (public reads, no API key needed)
      const { createHypersnapService } = await import('../services/HypersnapService');
      const hypersnap = createHypersnapService(env);
      const [cast, replies] = await Promise.all([
        hypersnap.getCastByHash(castHash),
        hypersnap.getCastRepliesByParent(castHash, Math.min(limit, 50)),
      ]);

      // If cast is null, it was deleted on Farcaster
      if (cast === null) {
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
          conversation: {
            cast: null,
            replies: [],
            deleted: true,
            message: "This cast has been deleted on Farcaster"
          }
        });
      }

      // Return conversation data
      const conversation = {
        cast: {
          hash: cast.hash,
          text: cast.text,
          author: {
            fid: cast.author.fid,
            username: cast.author.username || '',
            display_name: cast.author.username || '4n0n',
            pfp_url: undefined,
          },
          timestamp: cast.timestamp,
          reactions: { likes_count: 0, recasts_count: 0 },
          replies: { count: replies.length },
          direct_replies: replies.map(r => ({
            hash: r.hash,
            text: r.text,
            author: {
              fid: r.author.fid,
              username: r.author.username || '',
              display_name: r.author.username || '',
              pfp_url: undefined,
            },
            timestamp: r.timestamp,
            reactions: { likes_count: 0, recasts_count: 0 },
            replies: { count: 0 },
          })),
        },
        replies: replies.map(r => ({
          hash: r.hash,
          text: r.text,
          author: {
            fid: r.author.fid,
            username: r.author.username || '',
            display_name: r.author.username || '',
            pfp_url: undefined,
          },
          timestamp: r.timestamp,
          reactions: { likes_count: 0, recasts_count: 0 },
          replies: { count: 0 },
        })),
      };
      return Response.json({ conversation });
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

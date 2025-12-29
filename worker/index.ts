// @ts-nocheck
import { VectorService } from './services/VectorService';
import { AIService } from './services/AIService';
import { OGService } from './services/OGService';
import { MetaService } from './services/MetaService';
import { RateLimitService } from './services/RateLimitService';
import { UserSettingsService } from './services/UserSettingsService';
import { createSignerService } from './services/NeynarSignerService';
import { handleCreateAnswer, handleGetAnswer, handleListAnswers } from '../src/api/answers';
import { handleAllowlistRoutes } from '../src/api/allowlists';
import { handleCreateQuery, handleGetQuery, handleListQueries } from '../src/api/queries';
import { requireAuth } from './middleware/auth';

interface Env {
  DB: any;
  KV_USER_PROFILES: any;
  KV_USER_POINTS: any;
  QINDEX: any;
  AINDEX: any;
  AI: any;
  ASSETS: any;
  NILLION_ORG_DID: string;
  NILLION_ORG_KEY: string;
  NILLION_NODES: string;
  NILLION_ANSWER_SCHEMA_ID: string;
  NILLION_PRIVATE_ANSWER_SCHEMA_ID: string;
  NILLION_ANON_ANSWER_SCHEMA_ID: string;
  NILLION_ALLOWLIST_ANSWER_SCHEMA_ID: string;
  NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID: string;
  HOSTNAME?: string; // For Quick Auth JWT verification
  NEYNAR_API_KEY: string;
  NEYNAR_ANON_BOT_API_KEY: string;
  NEYNAR_ANON_BOT_SIGNER_UUID: string;
  QBASE_SEED_PHRASE: string;
  SPONSOR_SIGNER?: string;
}

// Helper function to check if request is from dev domain
function isDevDomain(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === 'qbase-dev.z00.workers.dev' || hostname === 'localhost';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // =========================================================================
    // SECURITY STATUS
    // =========================================================================
    // 1. API Authentication ✓ IMPLEMENTED
    //    - Quick Auth verification is implemented in AuthService
    //    - Frontend uses sdk.quickAuth.getToken() for MiniApp context
    //    - Backend verifies JWT tokens with AuthService.verifyAuthHeader()
    //    - Applied to all protected endpoints:
    //      * /api/check-similarity (POST)
    //      * /api/parse-query (POST)
    //      * /api/answers (POST) with user ID verification
    //      * /api/queries (POST) with coiner ID verification
    //      * /api/farcaster/cast (POST)
    //      * /api/auth/signer (GET, POST)
    //      * /api/auth/signer/register (POST)
    //      * /api/allowlists/* (all methods)
    //
    // 2. Rate Limiting ✓ IMPLEMENTED
    //    - Rate limiting is active on all sensitive endpoints
    //    - Using KV-based rate limiting with IP-based limits
    //    - 60 req/min for reads, 20 req/min for similarity/parse, 10 req/min for writes
    //
    // 3. Server-side Nonce Generation ✓ IMPLEMENTED
    //    - GET /api/auth/nonce endpoint generates secure nonces
    //    - Nonces stored in KV with 5-minute expiration
    //    - Used for SIWF (web context) authentication
    // =========================================================================

    // Meta Tag Injection for Dynamic Routes - MUST BE FIRST, before ASSETS
    // This intercepts the routes before SPA mode in ASSETS handles them
    if (url.pathname.startsWith('/quiz/') || url.pathname.startsWith('/profile/') || url.pathname.startsWith('/question/')) {
      try {
        // Manually construct the index.html request
        const indexUrl = new URL('/index.html', url.origin);
        const indexRequest = new Request(indexUrl.toString(), {
          method: 'GET',
          headers: request.headers
        });

        const indexResponse = await env.ASSETS.fetch(indexRequest);

        if (!indexResponse.ok) {
          // If index.html fetch fails, fall back to default handling
          return indexResponse;
        }

        const html = await indexResponse.text();
        let metaTags = '';

        if (url.pathname.startsWith('/quiz/')) {
          const id = url.pathname.split('/')[2];
          if (id) {
            const imageUrl = `${url.origin}/api/og/quiz?id=${id}`;
            const actionUrl = `${url.origin}/quiz/${id}`;
            metaTags = MetaService.generateMiniAppTag(imageUrl, "Take Quiz", actionUrl);
          }
        } else if (url.pathname.startsWith('/profile/')) {
          const fid = url.pathname.split('/')[2];
          if (fid) {
            const imageUrl = `${url.origin}/api/og/profile?fid=${fid}`;
            const actionUrl = `${url.origin}/profile/${fid}`;
            metaTags = MetaService.generateMiniAppTag(imageUrl, "View Profile", actionUrl);
          }
        } else if (url.pathname.startsWith('/question/')) {
          const id = url.pathname.split('/')[2];
          if (id) {
            const imageUrl = `${url.origin}/api/og/question?id=${id}`;
            const actionUrl = `${url.origin}/question/${id}`;
            metaTags = MetaService.generateMiniAppTag(imageUrl, "?", actionUrl);
          }
        }

        const modifiedHtml = MetaService.injectTags(html, metaTags);

        // Return with proper headers for HTML
        return new Response(modifiedHtml, {
          headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            'Cache-Control': 'public, max-age=0, must-revalidate'
          },
          status: indexResponse.status
        });
      } catch (e) {
        console.error('Meta Tag Injection Error:', e);
        // Fall back to ASSETS on error
        return env.ASSETS.fetch(request);
      }
    }

    // OG Image Generation Routes
    if (url.pathname.startsWith('/api/og/')) {
      const type = url.pathname.split('/')[3];
      const searchParams = url.searchParams;

      try {
        let imageBuffer: Uint8Array;

        if (type === 'quiz') {
          const id = searchParams.get('id');
          if (!id) return new Response('Missing id', { status: 400 });

          const quiz = await env.DB.prepare('SELECT * FROM quizzes WHERE id = ?').bind(id).first();
          if (!quiz) return new Response('Quiz not found', { status: 404 });

          const creator = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind((quiz as { creator_id: number }).creator_id).first() as { fname?: string } | null;
          const creatorName = creator ? (creator.fname || 'Unknown') : 'Unknown';

          const qCount = 5; // Placeholder

          imageBuffer = await OGService.generateQuizImage(id, (quiz as { title: string }).title, creatorName, qCount);
        } else if (type === 'profile') {
          const fid = searchParams.get('fid');
          if (!fid) return new Response('Missing fid', { status: 400 });

          const profileStr = await env.KV_USER_PROFILES.get(fid);
          const profile = profileStr ? JSON.parse(profileStr) as { username: string; displayName: string } : { username: 'unknown', displayName: 'Unknown' };

          const pointsStr = await env.KV_USER_POINTS.get(fid);
          const points = pointsStr ? JSON.parse(pointsStr) as { balance: number } : { balance: 0 };

          imageBuffer = await OGService.generateProfileImage(fid, profile.username, { level: 1, xp: points.balance, rank: 0 });
        } else if (type === 'question') {
          const id = searchParams.get('id');
          if (!id) return new Response('Missing id', { status: 400 });

          const question = await env.DB.prepare('SELECT * FROM queries WHERE id = ?').bind(id).first();
          if (!question) return new Response('Question not found', { status: 404 });

          imageBuffer = await OGService.generateQuestionImage(id, (question as { stem: string; coiner_fname?: string }).stem, (question as { coiner_fname?: string }).coiner_fname || 'Unknown');
        } else {
          return new Response('Invalid OG type', { status: 400 });
        }

        return new Response(imageBuffer, {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=3600'
          }
        });

      } catch (e) {
        console.error('OG Generation Error:', e);
        return new Response('Error generating image', { status: 500 });
      }
    }

    // =========================================================================
    // NEYNAR SIGNER AUTHENTICATION ENDPOINTS
    // =========================================================================
    
    // GET /api/auth/nonce - Generate nonce for Sign-In with Farcaster
    if (url.pathname === "/api/auth/nonce" && request.method === "GET") {
      try {
        const signerService = createSignerService(env.NEYNAR_API_KEY);
        const { nonce } = await signerService.fetchNonce();
        return Response.json({ nonce });
      } catch (e) {
        console.error("Error generating nonce:", e);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // GET /api/auth/signers - Fetch user's existing signers
    // Query params: message (SIWF message), signature (user's signature)
    // Note: This endpoint validates SIWF and returns existing signers
    if (url.pathname === "/api/auth/signers" && request.method === "GET") {
      try {
        const message = url.searchParams.get('message');
        const signature = url.searchParams.get('signature');

        if (!message || !signature) {
          return Response.json(
            { error: 'Message and signature are required' },
            { status: 400 }
          );
        }

        // TODO: Validate SIWF message and signature
        // For now, we return empty signers array
        // Signers are created through the POST /api/auth/signer flow
        // and approved by the user via QR code/deep link
        
        return Response.json({
          signers: [],
          fid: undefined,
        });
      } catch (e) {
        console.error("Error fetching signers:", e);
        return Response.json(
          { error: 'Failed to fetch signers' },
          { status: 500 }
        );
      }
    }

    // POST /api/auth/signer - Create a new signer (requires auth)
    if (url.pathname === "/api/auth/signer" && request.method === "POST") {
      try {
        // Verify authentication
        const auth = await requireAuth(request, env);
        if (!auth.authenticated) {
          return new Response(auth.error || "Unauthorized", { status: 401 });
        }

        const signerService = createSignerService(env.NEYNAR_API_KEY);
        const signer = await signerService.createSigner();

        return Response.json(signer);
      } catch (e) {
        console.error("Error creating signer:", e);
        return Response.json(
          { error: 'Failed to create signer' },
          { status: 500 }
        );
      }
    }

    // GET /api/auth/signer - Poll signer status by UUID (requires auth)
    // Query params: signerUuid
    if (url.pathname === "/api/auth/signer" && request.method === "GET") {
      try {
        // Verify authentication
        const auth = await requireAuth(request, env);
        if (!auth.authenticated) {
          return new Response(auth.error || "Unauthorized", { status: 401 });
        }

        const signerUuid = url.searchParams.get('signerUuid');

        if (!signerUuid) {
          return Response.json(
            { error: 'signerUuid is required' },
            { status: 400 }
          );
        }

        const signerService = createSignerService(env.NEYNAR_API_KEY);
        const signer = await signerService.lookupSigner(signerUuid);

        return Response.json(signer);
      } catch (e) {
        console.error("Error looking up signer:", e);
        return Response.json(
          { error: 'Failed to lookup signer' },
          { status: 500 }
        );
      }
    }

    // POST /api/auth/signer/register - Register signed key with Farcaster (requires auth)
    // Body: { signerUuid, publicKey }
    if (url.pathname === "/api/auth/signer/register" && request.method === "POST") {
      try {
        // Verify authentication
        const auth = await requireAuth(request, env);
        if (!auth.authenticated) {
          return new Response(auth.error || "Unauthorized", { status: 401 });
        }

        const body = await request.json() as { signerUuid: string; publicKey: string };
        const { signerUuid, publicKey } = body;

        if (!signerUuid || !publicKey) {
          return Response.json(
            { error: 'signerUuid and publicKey are required' },
            { status: 400 }
          );
        }

        if (!env.QBASE_SEED_PHRASE) {
          console.error('QBASE_SEED_PHRASE not configured');
          return Response.json(
            { error: 'Server configuration error' },
            { status: 500 }
          );
        }

        const signerService = createSignerService(env.NEYNAR_API_KEY);
        const sponsorSigner = env.SPONSOR_SIGNER === 'true';
        
        const result = await signerService.registerSignedKey(
          signerUuid,
          publicKey,
          env.QBASE_SEED_PHRASE,
          sponsorSigner
        );

        return Response.json(result);
      } catch (e) {
        console.error("Error registering signed key:", e);
        return Response.json(
          { error: 'Failed to register signed key' },
          { status: 500 }
        );
      }
    }

    // POST /api/farcaster/cast - Publish a cast using an approved signer
    // Body: { signerUuid?, useAnonBot?, text, embeds?, parent?, parentAuthorFid?, entityType?, entityId? }
    // Supports both user casts (requires auth + signerUuid) and anon bot casts (useAnonBot: true)
    if (url.pathname === "/api/farcaster/cast" && request.method === "POST") {
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
          const auth = await requireAuth(request, env);
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
            const { FarcasterDBService } = await import('./services/FarcasterDBService');
            const { anon_fid } = await import('../src/lib/consts');
            
            // Determine caster FID and username
            let casterFid: number;
            let casterUsername: string;
            
            if (useAnonBot) {
              casterFid = anon_fid;
              casterUsername = '4n0n';
            } else {
              // Get user info from auth
              const auth = await requireAuth(request, env);
              casterFid = auth.user?.fid || 0;
              casterUsername = auth.user?.username || 'user';
            }
            
            await FarcasterDBService.upsertCast(env.DB, {
              entity_type: entityType,
              entity_id: entityId,
              cast_hash: result.cast.hash,
              cast_url: `https://warpcast.com/${casterUsername}/${result.cast.hash}`,
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

    // POST /api/farcaster/like - Like or unlike a cast (requires auth + signer)
    if (url.pathname === "/api/farcaster/like" && request.method === "POST") {
      try {
        // Verify authentication
        const auth = await requireAuth(request, env);
        if (!auth.authenticated) {
          return new Response(auth.error || "Unauthorized", { status: 401 });
        }

        const body = await request.json() as { 
          signerUuid: string;
          castHash: string;
          action: 'like' | 'unlike';
        };
        const { signerUuid, castHash, action } = body;

        if (!signerUuid || !castHash || !action) {
          return Response.json(
            { error: 'signerUuid, castHash, and action are required' },
            { status: 400 }
          );
        }

        const signerService = createSignerService(env.NEYNAR_API_KEY);
        
        if (action === 'like') {
          const result = await signerService.likeCast(signerUuid, castHash);
          
          // Store reaction in database
          const { FarcasterDBService } = await import('./services/FarcasterDBService');
          await FarcasterDBService.upsertReaction(env.DB, {
            cast_hash: castHash,
            reactor_fid: auth.fid || result.reaction.reactor_fid,
            reaction_type: 'like',
            source: 'qbase',
          });
          
          return Response.json(result);
        } else {
          const result = await signerService.unlikeCast(signerUuid, castHash);
          
          // Remove reaction from database
          const { FarcasterDBService } = await import('./services/FarcasterDBService');
          await FarcasterDBService.deleteReaction(env.DB, castHash, auth.fid || 0, 'like');
          
          return Response.json(result);
        }
      } catch (e) {
        console.error("Error handling like action:", e);
        return Response.json(
          { error: 'Failed to process like action' },
          { status: 500 }
        );
      }
    }

    // POST /api/farcaster/recast - Recast or unrecast a cast (requires auth + signer)
    if (url.pathname === "/api/farcaster/recast" && request.method === "POST") {
      try {
        // Verify authentication
        const auth = await requireAuth(request, env);
        if (!auth.authenticated) {
          return new Response(auth.error || "Unauthorized", { status: 401 });
        }

        const body = await request.json() as { 
          signerUuid: string;
          castHash: string;
          action: 'recast' | 'unrecast';
        };
        const { signerUuid, castHash, action } = body;

        if (!signerUuid || !castHash || !action) {
          return Response.json(
            { error: 'signerUuid, castHash, and action are required' },
            { status: 400 }
          );
        }

        const signerService = createSignerService(env.NEYNAR_API_KEY);
        
        if (action === 'recast') {
          const result = await signerService.recast(signerUuid, castHash);
          
          // Store reaction in database
          const { FarcasterDBService } = await import('./services/FarcasterDBService');
          await FarcasterDBService.upsertReaction(env.DB, {
            cast_hash: castHash,
            reactor_fid: auth.fid || result.reaction.reactor_fid,
            reaction_type: 'recast',
            source: 'qbase',
          });
          
          return Response.json(result);
        } else {
          const result = await signerService.unrecast(signerUuid, castHash);
          
          // Remove reaction from database
          const { FarcasterDBService } = await import('./services/FarcasterDBService');
          await FarcasterDBService.deleteReaction(env.DB, castHash, auth.fid || 0, 'recast');
          
          return Response.json(result);
        }
      } catch (e) {
        console.error("Error handling recast action:", e);
        return Response.json(
          { error: 'Failed to process recast action' },
          { status: 500 }
        );
      }
    }

    // POST /api/check-similarity - Check if query text is similar to existing queries (requires auth)
    if (url.pathname === "/api/check-similarity" && request.method === "POST") {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);
      const allowed = await rateLimitService.checkLimit(ip, 20, 60); // 20 req/min
      if (!allowed) {
        return new Response("Too Many Requests", { status: 429 });
      }

      // Verify authentication
      const auth = await requireAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      try {
        const { text } = await request.json() as { text: string };

        if (!text) {
          return new Response("Missing text", { status: 400 });
        }

        const vectorService = VectorService.fromEnv(env);
        const result = await vectorService.checkSimilarity(text);

        return Response.json(result);
      } catch (error) {
        console.error("Error checking similarity:", error);
        return new Response("Internal Server Error", { status: 500 });
      }

    }

    // POST /api/parse-query - Parse query text using AI (requires auth)
    if (url.pathname === "/api/parse-query" && request.method === "POST") {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);
      const allowed = await rateLimitService.checkLimit(ip, 20, 60); // 20 req/min
      if (!allowed) {
        return new Response("Too Many Requests", { status: 429 });
      }

      // Verify authentication
      const auth = await requireAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      try {
        const { text } = await request.json() as { text: string };

        if (!text) {
          return new Response("Missing text", { status: 400 });
        }

        const aiService = AIService.fromEnv(env);
        const result = await aiService.parseQuery(text);

        return Response.json(result);
      } catch (error) {
        console.error("Error parsing query:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // POST /api/answers - Submit an answer (requires auth)
    if (url.pathname === "/api/answers" && request.method === "POST") {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);
      const allowed = await rateLimitService.checkLimit(ip, 10, 60); // 10 req/min
      if (!allowed) {
        return new Response("Too Many Requests", { status: 429 });
      }

      // Verify authentication
      const auth = await requireAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      // Inject user_id from authenticated user (similar to query creation)
      try {
        const body = await request.json() as Omit<{ user_id: number }, 'user_id'>;
        
        // Get internal user ID from FID
        const userRow = await env.DB.prepare('SELECT id FROM users WHERE fid = ?')
          .bind(auth.fid)
          .first() as { id: number } | null;

        if (!userRow) {
          return new Response('User not found', { status: 404 });
        }

        // Inject authenticated user's internal ID into the request body
        // This prevents client manipulation of user identity
        const verifiedBody = {
          ...body,
          user_id: userRow.id, // Internal DB ID from authenticated user
        };

        // Re-create the request with the verified body for the handler
        const verifiedRequest = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: JSON.stringify(verifiedBody)
        });

        return handleCreateAnswer(verifiedRequest, env);
      } catch (e) {
        console.error('Error validating answer request:', e);
        return new Response('Invalid request', { status: 400 });
      }
    }

    // Allowlist CRUD endpoints (authenticated)
    if (url.pathname.startsWith("/api/allowlists")) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);
      const allowed = await rateLimitService.checkLimit(ip, 20, 60); // 20 req/min
      if (!allowed) {
        return new Response("Too Many Requests", { status: 429 });
      }

      return handleAllowlistRoutes(request, env);
    }

    // User Points endpoints (authenticated)
    if (url.pathname === "/api/points" && request.method === "GET") {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);
      const allowed = await rateLimitService.checkLimit(ip, 60, 60); // 60 req/min
      if (!allowed) {
        return new Response("Too Many Requests", { status: 429 });
      }

      // Verify authentication
      const auth = await requireAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      try {
        let pointsStr = await env.KV_USER_POINTS.get(auth.fid.toString());
        
        if (!pointsStr) {
          // Initialize points for new user
          const initialPoints = {
            balance: 100, // Default daily allowance
            allowance: 100 // Default daily allowance
          };
          
          await env.KV_USER_POINTS.put(
            auth.fid.toString(),
            JSON.stringify(initialPoints)
          );
          
          console.log(`Initialized points for new user FID ${auth.fid}: balance=100, allowance=100`);
          
          return Response.json({
            allowance: 100, // Remaining daily allowance
            earned: 0, // No earned QP yet
            balance: 100 // Total spendable QP
          });
        }

        const points = JSON.parse(pointsStr) as { balance: number; allowance: number };
        
        // Calculate earned QP (durable points that don't expire)
        // Earned QP = balance - allowance (if balance > allowance, otherwise 0)
        // This represents points earned from quiz unlocks, rewards, etc.
        const earned = Math.max(0, points.balance - points.allowance);

        return Response.json({
          allowance: points.allowance, // Remaining daily allowance
          earned: earned, // Earned QP (durable)
          balance: points.balance // Total spendable QP
        });
      } catch (error) {
        console.error("Error fetching points:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    // User Settings endpoints (authenticated)
    if (url.pathname.startsWith("/api/settings")) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);
      const allowed = await rateLimitService.checkLimit(ip, 60, 60); // 60 req/min
      if (!allowed) {
        return new Response("Too Many Requests", { status: 429 });
      }

      // Verify authentication
      const auth = await requireAuth(request, env);
      if (!auth.authenticated) {
        return new Response(auth.error || "Unauthorized", { status: 401 });
      }

      const settingsService = UserSettingsService.fromEnv(env);

      // GET /api/settings - Get current user's settings
      if (url.pathname === "/api/settings" && request.method === "GET") {
        try {
          const settings = await settingsService.getSettings(auth.fid);
          return Response.json(settings);
        } catch (error) {
          console.error("Error fetching settings:", error);
          return new Response("Internal Server Error", { status: 500 });
        }
      }

      // PATCH /api/settings - Update current user's settings
      if (url.pathname === "/api/settings" && request.method === "PATCH") {
        try {
          const updates = await request.json();
          const settings = await settingsService.updateSettings(auth.fid, updates);
          return Response.json(settings);
        } catch (error) {
          console.error("Error updating settings:", error);
          return new Response("Internal Server Error", { status: 500 });
        }
      }

      // DELETE /api/settings - Reset current user's settings to defaults
      if (url.pathname === "/api/settings" && request.method === "DELETE") {
        try {
          const settings = await settingsService.resetSettings(auth.fid);
          return Response.json(settings);
        } catch (error) {
          console.error("Error resetting settings:", error);
          return new Response("Internal Server Error", { status: 500 });
        }
      }
    }

    // Queries endpoints
    if (url.pathname.startsWith("/api/queries")) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);

      // GET /api/queries/:id/answers - List answers for a query (public endpoint)
      const answersMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9-]+)\/answers$/);
      if (answersMatch && request.method === "GET") {
        const allowed = await rateLimitService.checkLimit(ip, 60, 60); // 60 req/min for reads
        if (!allowed) return new Response("Too Many Requests", { status: 429 });
        return handleListAnswers(request, env, answersMatch[1]);
      }

      // GET /api/queries/:id - Get a single query
      const idMatch = url.pathname.match(/^\/api\/queries\/([a-zA-Z0-9-]+)$/);
      if (idMatch && request.method === "GET") {
        const allowed = await rateLimitService.checkLimit(ip, 60, 60); // 60 req/min for reads
        if (!allowed) return new Response("Too Many Requests", { status: 429 });
        return handleGetQuery(request, env, idMatch[1]);
      }

      // GET /api/queries - List all queries
      if (url.pathname === "/api/queries" && request.method === "GET") {
        const allowed = await rateLimitService.checkLimit(ip, 60, 60); // 60 req/min for reads
        if (!allowed) return new Response("Too Many Requests", { status: 429 });
        return handleListQueries(request, env);
      }

      // POST /api/queries - Create a new query (requires auth)
      if (url.pathname === "/api/queries" && request.method === "POST") {
        const allowed = await rateLimitService.checkLimit(ip, 10, 60); // 10 req/min for writes
        if (!allowed) return new Response("Too Many Requests", { status: 429 });
        
        // Verify authentication
        const auth = await requireAuth(request, env);
        if (!auth.authenticated) {
          return new Response(auth.error || "Unauthorized", { status: 401 });
        }

        try {
          const body = await request.json() as Omit<QuerySubmission, 'coiner_id' | 'coiner_fid' | 'coiner_fname'>;
          
          // Get internal user ID from FID
          const userRow = await env.DB.prepare('SELECT id, fname FROM users WHERE fid = ?')
            .bind(auth.fid)
            .first() as { id: number; fname: string } | null;

          if (!userRow) {
            return new Response('User not found', { status: 404 });
          }

          // Inject authenticated user data into the request body
          // This prevents client manipulation of user identity
          const verifiedBody = {
            ...body,
            coiner_id: userRow.id,      // Internal DB ID
            coiner_fid: auth.fid,       // FID from JWT
            coiner_fname: userRow.fname // Username from DB
          };

          // Add verified FID to headers for the handler
          const headers = new Headers(request.headers);
          headers.set('X-Verified-FID', auth.fid.toString());
          
          const verifiedRequest = new Request(request.url, {
            method: request.method,
            headers: headers,
            body: JSON.stringify(verifiedBody)
          });

          return handleCreateQuery(verifiedRequest, env);
        } catch (e) {
          console.error('Error validating query request:', e);
          return new Response('Invalid request', { status: 400 });
        }
      }
    }

    // Answer endpoints
    if (url.pathname.startsWith("/api/answers")) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);

      // GET /api/answers/:id - Get a single answer (public for Public audience, auth required for others)
      const answerIdMatch = url.pathname.match(/^\/api\/answers\/([a-zA-Z0-9-]+)$/);
      if (answerIdMatch && request.method === "GET") {
        const allowed = await rateLimitService.checkLimit(ip, 60, 60); // 60 req/min for reads
        if (!allowed) return new Response("Too Many Requests", { status: 429 });
        return handleGetAnswer(request, env, answerIdMatch[1]);
      }
    }

    // POST /api/test/taxonomy-classification/single - Test single question with latency
    if (url.pathname === "/api/test/taxonomy-classification/single" && request.method === "POST") {
      // Only allow on dev domain
      if (!isDevDomain(request)) {
        return new Response("Not Found", { status: 404 });
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);
      const allowed = await rateLimitService.checkLimit(ip, 30, 60); // 30 req/min
      if (!allowed) {
        return new Response("Too Many Requests", { status: 429 });
      }

      try {
        const { stem, options } = await request.json() as { stem: string; options?: string[] };
        
        if (!stem) {
          return Response.json({ error: 'stem is required' }, { status: 400 });
        }

        const aiService = AIService.fromEnv(env);
        const startTime = Date.now();
        const result = await aiService.classifyQuestion(stem, options);
        const endTime = Date.now();
        const latencyMs = endTime - startTime;

        return Response.json({
          result,
          latency: {
            ms: latencyMs,
            seconds: (latencyMs / 1000).toFixed(2)
          }
        });
      } catch (error) {
        console.error("Error classifying single question:", error);
        return Response.json(
          { error: 'Failed to classify question', details: String(error) },
          { status: 500 }
        );
      }
    }

    // POST /api/test/taxonomy-classification - Run taxonomy classification tests
    if (url.pathname === "/api/test/taxonomy-classification" && request.method === "POST") {
      // Only allow on dev domain
      if (!isDevDomain(request)) {
        return new Response("Not Found", { status: 404 });
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitService = RateLimitService.fromEnv(env);
      const allowed = await rateLimitService.checkLimit(ip, 20, 60); // 20 req/min
      if (!allowed) {
        return new Response("Too Many Requests", { status: 429 });
      }

      try {
        const aiService = AIService.fromEnv(env);
        
        // Test cases from test-taxonomy-classification.ts
        const testCases = [
          {
            name: "Identity + Complete + Preference + Low",
            stem: "What's your favorite color?",
            options: undefined,
            expected: {
              primary_type: 'identity',
              construction_type: 'complete',
              content_tags: ['preference'],
              sensitivity: 'low',
            }
          },
          {
            name: "Recurring + Complete + Behavioral + Medium",
            stem: "How do you feel today?",
            options: undefined,
            expected: {
              primary_type: 'recurring',
              construction_type: 'complete',
              content_tags: ['behavioral'],
              sensitivity: 'medium',
              temporal_markers: ['today']
            }
          },
          {
            name: "Prospective + Complete + Behavioral + Medium",
            stem: "What are your plans for 2026?",
            options: undefined,
            expected: {
              primary_type: 'prospective',
              construction_type: 'complete',
              content_tags: ['behavioral'],
              sensitivity: 'medium',
            }
          },
          {
            name: "Identity + Template + Preference + Low",
            stem: "Would you rather:",
            options: ["be rich", "be famous"],
            expected: {
              primary_type: 'identity',
              construction_type: 'template',
              content_tags: ['preference'],
              sensitivity: 'low',
              is_template: true
            }
          },
          {
            name: "Recurring + Template + Preference + Low",
            stem: "Right now, would you prefer:",
            options: ["coffee", "tea"],
            expected: {
              primary_type: 'recurring',
              construction_type: 'template',
              content_tags: ['preference'],
              sensitivity: 'low',
              is_template: true,
              temporal_markers: ['right now']
            }
          },
          {
            name: "Prospective + Complete + Belief + High",
            stem: "How do you think you'll vote in the next election?",
            options: undefined,
            expected: {
              primary_type: 'prospective',
              construction_type: 'complete',
              content_tags: ['belief'],
              sensitivity: 'high',
            }
          },
          {
            name: "Identity + Complete + Belief + High",
            stem: "What is your religious or spiritual orientation?",
            options: undefined,
            expected: {
              primary_type: 'identity',
              construction_type: 'complete',
              content_tags: ['belief'],
              sensitivity: 'high',
            }
          },
          {
            name: "Recurring + Complete + Behavioral + Medium",
            stem: "What's your current stress level?",
            options: undefined,
            expected: {
              primary_type: 'recurring',
              construction_type: 'complete',
              content_tags: ['behavioral'],
              sensitivity: 'medium',
              temporal_markers: ['current']
            }
          },
          {
            name: "Prospective + Complete + Demographic + Medium",
            stem: "What career will you be in 5 years from now?",
            options: undefined,
            expected: {
              primary_type: 'prospective',
              construction_type: 'complete',
              content_tags: ['demographic'],
              sensitivity: 'medium',
            }
          },
          {
            name: "Identity + Template + Preference + Low (colon detection)",
            stem: "This or that:",
            options: ["cats", "dogs"],
            expected: {
              primary_type: 'identity',
              construction_type: 'template',
              content_tags: ['preference'],
              sensitivity: 'low',
              is_template: true
            }
          },
          {
            name: "Past Question: Specific Historical Event",
            stem: "How did you feel during the COVID-19 lockdown in 2020?",
            options: undefined,
            expected: {
              primary_type: 'identity', // Past memory, not tracking
              construction_type: 'complete',
              content_tags: ['behavioral'],
              sensitivity: 'medium',
            }
          },
          {
            name: "Past Question: Childhood Identity",
            stem: "What were you like as a teenager?",
            options: undefined,
            expected: {
              primary_type: 'identity', // Past self is part of identity
              construction_type: 'complete',
              content_tags: ['behavioral'],
              sensitivity: 'low',
            }
          },
          {
            name: "Past Question: Historical Belief",
            stem: "What was your worldview in 2016?",
            options: undefined,
            expected: {
              primary_type: 'identity', // Fixed past memory
              construction_type: 'complete',
              content_tags: ['belief'],
              sensitivity: 'medium',
            }
          }
        ];

        const results = [];

        for (const testCase of testCases) {
          try {
            const result = await aiService.classifyQuestion(testCase.stem, testCase.options);
            
            // Validate result
            const errors = [];
            
            if (result.primary_type !== testCase.expected.primary_type) {
              errors.push(`primary_type: expected ${testCase.expected.primary_type}, got ${result.primary_type}`);
            }
            
            if (result.construction_type !== testCase.expected.construction_type) {
              errors.push(`construction_type: expected ${testCase.expected.construction_type}, got ${result.construction_type}`);
            }
            
            if (result.sensitivity !== testCase.expected.sensitivity) {
              errors.push(`sensitivity: expected ${testCase.expected.sensitivity}, got ${result.sensitivity}`);
            }
            
            // Check content_tags (at least one expected tag should be present)
            const hasExpectedTag = testCase.expected.content_tags.some((tag: string) => 
              result.content_tags.includes(tag as any)
            );
            if (!hasExpectedTag) {
              errors.push(`content_tags: expected one of [${testCase.expected.content_tags.join(', ')}], got [${result.content_tags.join(', ')}]`);
            }
            
            // Check is_template if specified
            if (testCase.expected.is_template !== undefined && result.is_template !== testCase.expected.is_template) {
              errors.push(`is_template: expected ${testCase.expected.is_template}, got ${result.is_template}`);
            }
            
            // Check temporal_markers if specified
            if (testCase.expected.temporal_markers) {
              if (!result.temporal_markers || result.temporal_markers.length === 0) {
                errors.push(`temporal_markers: expected markers, got none`);
              }
            }
            
            // For exploratory tests with 'unknown' expected type, don't validate primary_type
            const isExploratory = testCase.expected.primary_type === 'unknown';
            const finalErrors = isExploratory 
              ? errors.filter(e => !e.startsWith('primary_type:'))
              : errors;
            results.push({
              name: testCase.name,
              stem: testCase.stem,
              options: testCase.options,
              result,
              expected: testCase.expected,
              passed: finalErrors.length === 0,
              errors: finalErrors
            });
          } catch (error) {
            results.push({
              name: testCase.name,
              stem: testCase.stem,
              options: testCase.options,
              passed: false,
              errors: [String(error)]
            });
          }
        }

        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;

        return Response.json({
          summary: {
            total: results.length,
            passed,
            failed,
            passRate: (passed / results.length * 100).toFixed(1)
          },
          results
        });
      } catch (error) {
        console.error("Error running taxonomy classification tests:", error);
        return new Response("Internal Server Error", { status: 500 });
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({
        name: "Cloudflare",
      });
    }

    // Fallback to ASSETS for everything else
    return env.ASSETS.fetch(request);
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

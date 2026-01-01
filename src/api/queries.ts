import { QueryType } from '../lib/types';
import type { QuerySubmission } from '../lib/types';
import { VectorService } from '../../worker/services/VectorService';
import { AIService } from '../../worker/services/AIService';
import { AnonAttributionService } from '../../worker/services/AnonAttributionService';
import { PointsService } from '../../worker/services/PointsService';
import { anon_fid } from '../lib/consts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

// Helper function to post to Farcaster in background (non-blocking)
async function postQueryToFarcaster(
  env: Env,
  queryId: string,
  stem: string,
  signerUuid: string | undefined,
  isAnonymous: boolean,
  realCoinerFid: number | undefined,
  displayCoinerFname: string | null
) {
  try {
    if (isAnonymous) {
      // Cast from anon bot
      if (env.NEYNAR_ANON_BOT_SIGNER_UUID && env.NEYNAR_ANON_BOT_API_KEY) {
        const { NeynarAPIClient } = await import('@neynar/nodejs-sdk');
        const anonBotClient = new NeynarAPIClient({ apiKey: env.NEYNAR_ANON_BOT_API_KEY });
        
        const castText = `${stem}\n\nAsked anonymously via @qbase`;
        const hostname = env.HOSTNAME || 'qbase.tech';
        
        const result = await anonBotClient.publishCast({
          signerUuid: env.NEYNAR_ANON_BOT_SIGNER_UUID,
          text: castText,
          embeds: [{ url: `https://${hostname}/question/${queryId}` }],
        });
        
        console.log(`Anonymous query ${queryId} casted from @4n0n bot, cast hash: ${result.cast.hash}`);
        
        // Store cast hash in database
        const { FarcasterDBService } = await import('../../worker/services/FarcasterDBService');
        await FarcasterDBService.upsertCast(env.DB, {
          entity_type: 'query',
          entity_id: queryId,
          cast_hash: result.cast.hash,
          cast_url: `https://farcaster.xyz/4n0n/${result.cast.hash}`,
          caster_fid: anon_fid,
        });
        
        console.log(`Stored cast hash for anonymous query ${queryId} in database`);
      }
    } else {
      // Regular query - cast from user's account
      if (signerUuid) {
        const { NeynarAPIClient } = await import('@neynar/nodejs-sdk');
        const client = new NeynarAPIClient({ apiKey: env.NEYNAR_API_KEY });
        
        const hostname = env.HOSTNAME || 'qbase.tech';
        
        const result = await client.publishCast({
          signerUuid: signerUuid,
          text: stem,
          embeds: [{ url: `https://${hostname}/question/${queryId}` }],
        });
        
        console.log(`Query ${queryId} casted from user FID ${realCoinerFid}, cast hash: ${result.cast.hash}`);
        
        // Store cast hash in database
        const { FarcasterDBService } = await import('../../worker/services/FarcasterDBService');
        await FarcasterDBService.upsertCast(env.DB, {
          entity_type: 'query',
          entity_id: queryId,
          cast_hash: result.cast.hash,
          cast_url: `https://farcaster.xyz/${displayCoinerFname}/${result.cast.hash}`,
          caster_fid: realCoinerFid || 0,
        });
        
        console.log(`Stored cast hash for query ${queryId} in database`);
      } else {
        console.warn(`Query ${queryId} created without signer UUID - not posting to Farcaster`);
      }
    }
  } catch (castError) {
    console.error(`Failed to cast query ${queryId} to Farcaster:`, castError);
  }
}

export async function handleCreateQuery(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as QuerySubmission;

    // Validate required fields
    if (!body.stem || !body.type || !body.coiner_id) {
      return new Response('Missing required fields: stem, type, coiner_id', { status: 400 });
    }

    // Validate type
    const validTypes = Object.values(QueryType);
    if (!validTypes.includes(body.type)) {
      return new Response(`Invalid type. Must be one of: ${validTypes.join(', ')}`, { status: 400 });
    }

    // Initialize AI service for LLM-based validation and taxonomy classification
    const aiService = AIService.fromEnv(env);

    // Classify question using multi-dimensional taxonomy
    let taxonomy;
    try {
      taxonomy = await aiService.classifyQuestion(body.stem, body.a_options);
      console.log('Question taxonomy classification:', taxonomy);
    } catch (taxonomyError: unknown) {
      console.error('Taxonomy classification failed:', taxonomyError);
      return new Response(
        'Unable to classify question. AI service temporarily unavailable. Please try again.',
        { status: 503 }
      );
    }

    // Check if stem is incomplete (template) - now using taxonomy result
    const isIncomplete = taxonomy.is_template;
    
    // Reject incomplete stems without options
    if (isIncomplete && (!body.a_options || body.a_options.length < 2)) {
      return new Response(
        'This question stem is incomplete. ' +
        'Please provide at least 2 specific options to complete the question.',
        { status: 400 }
      );
    }
    
    // If options provided, validate them
    if (body.a_options && body.a_options.length > 0) {
      // Require at least 2 options if any provided
      if (body.a_options.length < 2) {
        return new Response('Please provide at least 2 options for multiple choice questions.', { status: 400 });
      }
      
      // Validate options are not empty
      if (body.a_options.some(o => !o.trim())) {
        return new Response('Question options cannot be empty.', { status: 400 });
      }
    }

    // Generate and check vector embedding BEFORE creating query (prevents duplicates)
    let vector: number[];
    let embeddingText: string;
    
    try {
      const vectorService = VectorService.fromEnv(env);
      
      // Generate embedding text with selective strategy using taxonomy
      // Template questions include options in embedding for semantic matching
      embeddingText = vectorService.generateEmbeddingText(
        body.stem,
        body.a_options,
        taxonomy.is_template
      );
      
      console.log(`Generated embedding text: "${embeddingText.substring(0, 100)}..."`);
      
      // Generate embedding vector
      vector = await vectorService.vectorize(embeddingText);
      
      // Check for duplicates using the two-threshold system
      const vectorService2 = VectorService.fromEnv(env);
      const similarResults = await vectorService2.searchSimilar(vector, 'q', 5);
      
      if (similarResults.length > 0 && similarResults[0].score >= 0.98) {
        return new Response(
          JSON.stringify({
            error: 'A nearly identical question already exists',
            existing_id: similarResults[0].id,
            similarity: similarResults[0].score
          }),
          { 
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }
      
    } catch (vectorError: unknown) {
      console.error('Vector generation/search failed:', vectorError);
      return new Response(
        'Unable to process question for duplicate detection. Vector service temporarily unavailable. Please try again.',
        { status: 503 }
      );
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Store real author info for anonymous queries before masking
    const realCoinerId = body.coiner_id;
    const realCoinerFid = body.coiner_fid;
    const isAnonymous = body.isAnon === true;

    // If anonymous, mask the author info with anon bot account
    let displayCoinerId = body.coiner_id;
    let displayCoinerFname = body.coiner_fname || null;
    let displayCoinerFid = body.coiner_fid || null;

    if (isAnonymous) {
      displayCoinerId = anon_fid; // Use anonymous FID constant (514282)
      displayCoinerFname = '4n0n';
      displayCoinerFid = anon_fid;
      console.log(`Creating anonymous query ${id} for real author FID ${realCoinerFid}`);
    }

    // Check and deduct QP cost
    const queryCost = body.cost || 0;
    if (queryCost > 0) {
      // SECURITY: Use verified FID from auth header (set by worker after authentication)
      // This is the source of truth, not body.coiner_fid which could be manipulated
      const verifiedFidHeader = request.headers.get('X-Verified-FID');
      
      if (!verifiedFidHeader) {
        console.error('Missing X-Verified-FID header - authentication bypass attempt?');
        return new Response('Authentication error', { status: 401 });
      }
      
      const userFid = parseInt(verifiedFidHeader, 10);
      
      // Use PointsService to handle deduction
      const pointsService = PointsService.fromEnv(env);
      const updatedPoints = await pointsService.deductPoints(
        userFid, 
        queryCost, 
        `query creation: ${body.stem.substring(0, 50)}`
      );

      if (!updatedPoints) {
        const currentPoints = await pointsService.getPoints(userFid);
        const totalSpendable = pointsService.getTotalSpendable(currentPoints);
        return new Response(
          `Insufficient QP. Required: ${queryCost}, Available: ${totalSpendable}`,
          { status: 402 } // 402 Payment Required
        );
      }

      console.log(`[Query Creation] Deducted ${queryCost} QP from user FID ${userFid}. New state: allowance=${updatedPoints.allowance}, earned=${updatedPoints.earned}, balance=${updatedPoints.balance}`);
    }

    // Prepare values for insertion
    const a_options = body.a_options ? JSON.stringify(body.a_options) : null;
    const scale_config = body.scale_config ? JSON.stringify(body.scale_config) : null;
    const tags = body.tags ? JSON.stringify(body.tags) : null;
    const reqs = body.reqs ? JSON.stringify(body.reqs) : null;
    const assets = body.assets ? JSON.stringify(body.assets) : null;
    const taxonomyJson = JSON.stringify(taxonomy);

    // Insert into D1 database
    // For anonymous queries, coiner_id/owner_id/coiner_fid are masked with anon_fid
    const stmt = env.DB.prepare(`
      INSERT INTO queries (
        id, stem, type, a_options, scale_config, cost, created_at,
        coiner_id, owner_id, coiner_fname, coiner_fid,
        token_id, casthash, tags, parent, reqs, assets, template, taxonomy,
        pub_answers, priv_answers, comments
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        0, 0, 0
      )
    `).bind(
      id,
      body.stem,
      body.type,
      a_options,
      scale_config,
      body.cost || 0,
      now,
      displayCoinerId,      // Masked if anonymous
      displayCoinerId,      // owner_id defaults to coiner_id (masked if anonymous)
      displayCoinerFname,   // '4n0n' if anonymous
      displayCoinerFid,     // anon_fid if anonymous
      body.token_id || null,
      body.casthash || null,
      tags,
      body.parent || null,
      reqs,
      assets,
      isIncomplete ? 1 : 0,  // Store LLM classification result for NFT minting
      taxonomyJson
    );

    await stmt.run();

    // Store the pre-generated vector in Vectorize
    try {
      const vectorService = VectorService.fromEnv(env);
      
      await vectorService.addVectors([{
        id,
        values: vector,
        metadata: {
          stem: body.stem,
          type: body.type,
          created_at: now,
          coiner_id: body.coiner_id,
          options_count: body.a_options?.length || 0
        }
      }], 'q');

      console.log(`Vector stored for query ${id}`);
    } catch (vectorError) {
      // This should be very rare since we already generated the vector successfully
      // But if storage fails, we need to clean up the query AND refund QP
      console.error('CRITICAL: Vector storage failed after query creation:', vectorError);
      
      // Delete the query we just created
      await env.DB.prepare('DELETE FROM queries WHERE id = ?').bind(id).run();
      
      // Refund QP if any was deducted
      if (queryCost > 0) {
        const verifiedFidHeader = request.headers.get('X-Verified-FID');
        if (verifiedFidHeader) {
          const userFid = parseInt(verifiedFidHeader, 10);
          const pointsService = PointsService.fromEnv(env);
          await pointsService.addPoints(userFid, queryCost, 'refund: vector storage failed');
          console.log(`Refunded ${queryCost} QP to user FID ${userFid}`);
        }
      }
      
      return new Response(
        'Failed to store query. Please try again.',
        { status: 503 }
      );
    }

    // Post to Farcaster in background (non-blocking)
    // Don't await - let it complete async to speed up response
    postQueryToFarcaster(
      env,
      id,
      body.stem,
      body.signerUuid,
      isAnonymous,
      realCoinerFid,
      displayCoinerFname
    ).catch(err => {
      console.error(`Background Farcaster posting failed for query ${id}:`, err);
    });

    // If anonymous, create attribution record (also non-blocking for speed)
    if (isAnonymous) {
      AnonAttributionService.createAttribution(env, {
        public_id: id,
        author_id: realCoinerId,
        type: 'question',
      }).catch(attributionError => {
        console.error('Failed to create attribution for anonymous query:', attributionError);
      });
    }

    return Response.json({
      success: true,
      id,
      message: 'Query created successfully',
      isAnonymous,  // Let frontend know this was anonymous
    });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error creating query:', e);
    return new Response(`Error creating query: ${err.message}`, { status: 500 });
  }
}

export async function handleGetQuery(_request: Request, env: Env, id: string): Promise<Response> {
  try {
    // Get query with engagement data
    const queryStr = `
      SELECT 
        q.*,
        fc.cast_hash,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'like' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as farcaster_likes,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'recast' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as farcaster_recasts,
        COALESCE(COUNT(DISTINCT frep.id), 0) as farcaster_replies
      FROM queries q
      LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
      LEFT JOIN farcaster_reactions fr ON fr.cast_hash = fc.cast_hash
      LEFT JOIN farcaster_replies frep ON frep.parent_cast_hash = fc.cast_hash AND frep.is_active = 1
      WHERE q.id = ?
      GROUP BY q.id
    `;
    
    const query = await env.DB.prepare(queryStr).bind(id).first();

    if (!query) {
      return new Response('Query not found', { status: 404 });
    }

    // Parse JSON fields
    const parsedQuery = {
      ...query,
      a_options: query.a_options ? JSON.parse(query.a_options) : undefined,
      scale_config: query.scale_config ? JSON.parse(query.scale_config) : undefined,
      tags: query.tags ? JSON.parse(query.tags) : undefined,
      reqs: query.reqs ? JSON.parse(query.reqs) : undefined,
      assets: query.assets ? JSON.parse(query.assets) : undefined,
      template: Boolean(query.template),
      created_at: new Date(query.created_at).getTime(), // Convert to unix epoch for frontend
      // Map cast_hash to casthash for frontend compatibility
      casthash: query.cast_hash || undefined,
      // Add engagement data
      farcaster_likes: Number(query.farcaster_likes) || 0,
      farcaster_recasts: Number(query.farcaster_recasts) || 0,
      farcaster_replies: Number(query.farcaster_replies) || 0,
    };

    return Response.json(parsedQuery);
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error fetching query:', e);
    return new Response(`Error fetching query: ${err.message}`, { status: 500 });
  }
}

export async function handleListQueries(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const offset = parseInt(url.searchParams.get('offset') || '0');
    const search = url.searchParams.get('search');

    // Build query with engagement data from Farcaster tables
    let query = `
      SELECT 
        q.*,
        fc.cast_hash,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'like' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as farcaster_likes,
        COALESCE(SUM(CASE WHEN fr.reaction_type = 'recast' AND fr.is_deleted = 0 THEN 1 ELSE 0 END), 0) as farcaster_recasts,
        COALESCE(COUNT(DISTINCT frep.id), 0) as farcaster_replies
      FROM queries q
      LEFT JOIN farcaster_casts fc ON fc.entity_type = 'query' AND fc.entity_id = q.id
      LEFT JOIN farcaster_reactions fr ON fr.cast_hash = fc.cast_hash
      LEFT JOIN farcaster_replies frep ON frep.parent_cast_hash = fc.cast_hash AND frep.is_active = 1
    `;
    
    const params: (string | number)[] = [];

    if (search) {
      query += ' WHERE q.stem LIKE ?';
      params.push(`%${search}%`);
    }

    query += ' GROUP BY q.id ORDER BY q.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await env.DB.prepare(query).bind(...params).all();

    // Fetch avatar URLs for unique FIDs using Neynar
    const uniqueFids = [...new Set(
      results
        .map((q: Record<string, unknown>) => q.coiner_fid)
        .filter((fid: unknown): fid is number => Boolean(fid))
    )];

    const fidToAvatarMap = new Map<number, string>();
    
    if (uniqueFids.length > 0 && env.NEYNAR_API_KEY) {
      try {
        const { NeynarService } = await import('../services/NeynarService');
        const users = await NeynarService.fetchBulkUsers(
          uniqueFids.map(String),
          env.NEYNAR_API_KEY
        );
        users.forEach(user => {
          fidToAvatarMap.set(Number(user.fid), user.pfp_url);
        });
      } catch (error) {
        console.error('Error fetching avatars from Neynar:', error);
        // Continue without avatars if fetch fails
      }
    }

    const parsedResults = results.map((q: Record<string, unknown>) => ({
      ...q,
      a_options: q.a_options ? JSON.parse(q.a_options as string) : undefined,
      scale_config: q.scale_config ? JSON.parse(q.scale_config as string) : undefined,
      tags: q.tags ? JSON.parse(q.tags as string) : undefined,
      reqs: q.reqs ? JSON.parse(q.reqs as string) : undefined,
      assets: q.assets ? JSON.parse(q.assets as string) : undefined,
      template: Boolean(q.template),
      created_at: new Date(q.created_at as string).getTime(),
      // Map cast_hash to casthash for frontend compatibility
      casthash: q.cast_hash || undefined,
      // Add engagement data
      farcaster_likes: Number(q.farcaster_likes) || 0,
      farcaster_recasts: Number(q.farcaster_recasts) || 0,
      farcaster_replies: Number(q.farcaster_replies) || 0,
      // Add avatar URL
      coiner_avatar_url: q.coiner_fid ? fidToAvatarMap.get(q.coiner_fid as number) : undefined,
    }));

    return Response.json({
      results: parsedResults,
      limit,
      offset
    });
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error listing queries:', e);
    return new Response(`Error listing queries: ${err.message}`, { status: 500 });
  }
}

import { QueryType } from '../lib/types';
import type { QuerySubmission } from '../lib/types';
import { VectorService } from '../../worker/services/VectorService';
import { AIService } from '../../worker/services/AIService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

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
      
      // Get user's current points from KV
      let pointsStr = await env.KV_USER_POINTS.get(userFid.toString());

      if (!pointsStr) {
        // Initialize points for new user
        const initialPoints = {
          balance: 100, // Default daily allowance
          allowance: 100 // Default daily allowance
        };
        
        await env.KV_USER_POINTS.put(
          userFid.toString(),
          JSON.stringify(initialPoints)
        );
        
        console.log(`Initialized points for new user FID ${userFid}: balance=100, allowance=100`);
        pointsStr = JSON.stringify(initialPoints);
      }

      const points = JSON.parse(pointsStr) as { balance: number; allowance: number };

      // Check if user has enough points
      if (points.balance < queryCost) {
        return new Response(
          `Insufficient QP. Required: ${queryCost}, Available: ${points.balance}`,
          { status: 402 } // 402 Payment Required
        );
      }

      // Deduct the cost
      points.balance -= queryCost;

      // Update points in KV
      await env.KV_USER_POINTS.put(
        userFid.toString(),
        JSON.stringify(points)
      );

      console.log(`Deducted ${queryCost} QP from user FID ${userFid}. New balance: ${points.balance}`);
    }

    // Prepare values for insertion
    const a_options = body.a_options ? JSON.stringify(body.a_options) : null;
    const scale_config = body.scale_config ? JSON.stringify(body.scale_config) : null;
    const tags = body.tags ? JSON.stringify(body.tags) : null;
    const reqs = body.reqs ? JSON.stringify(body.reqs) : null;
    const assets = body.assets ? JSON.stringify(body.assets) : null;
    const taxonomyJson = JSON.stringify(taxonomy);

    // Insert into D1 database
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
      body.coiner_id,
      body.coiner_id, // owner_id defaults to coiner_id
      body.coiner_fname || null,
      body.coiner_fid || null,
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
          const pointsStr = await env.KV_USER_POINTS.get(userFid.toString());
          if (pointsStr) {
            const points = JSON.parse(pointsStr) as { balance: number; allowance: number };
            points.balance += queryCost;
            await env.KV_USER_POINTS.put(userFid.toString(), JSON.stringify(points));
            console.log(`Refunded ${queryCost} QP to user FID ${userFid}`);
          }
        }
      }
      
      return new Response(
        'Failed to store query. Please try again.',
        { status: 503 }
      );
    }

    return Response.json({
      success: true,
      id,
      message: 'Query created successfully'
    });

  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error('Error creating query:', e);
    return new Response(`Error creating query: ${err.message}`, { status: 500 });
  }
}

export async function handleGetQuery(_request: Request, env: Env, id: string): Promise<Response> {
  try {
    const query = await env.DB.prepare('SELECT * FROM queries WHERE id = ?').bind(id).first();

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
      created_at: new Date(query.created_at).getTime() // Convert to unix epoch for frontend
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

    let query = 'SELECT * FROM queries';
    const params: (string | number)[] = [];

    if (search) {
      query += ' WHERE stem LIKE ?';
      params.push(`%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await env.DB.prepare(query).bind(...params).all();

    const parsedResults = results.map((q: Record<string, unknown>) => ({
      ...q,
      a_options: q.a_options ? JSON.parse(q.a_options as string) : undefined,
      scale_config: q.scale_config ? JSON.parse(q.scale_config as string) : undefined,
      tags: q.tags ? JSON.parse(q.tags as string) : undefined,
      reqs: q.reqs ? JSON.parse(q.reqs as string) : undefined,
      assets: q.assets ? JSON.parse(q.assets as string) : undefined,
      template: Boolean(q.template),
      created_at: new Date(q.created_at as string).getTime()
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

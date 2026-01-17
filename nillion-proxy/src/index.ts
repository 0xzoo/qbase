/**
 * Nillion Proxy Service
 * 
 * A lightweight Node.js service that handles Nillion SecretVault operations
 * for the Cloudflare Workers main app.
 * 
 * Deployed on Fly.io for full Node.js compatibility.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { SecretVaultBuilderClient } from '@nillion/secretvaults';
import { Signer, NilauthClient } from '@nillion/nuc';
import crypto from 'crypto';

// Types
interface StoreAnswerRequest {
  q_id: string;
  user_id: number;
  value: string;
  answer_type_id: number;  // FK to answer_types table: 1=text, 2=mc, 3=scale, 4=checkbox
  answer_data?: Record<string, unknown>;  // Type-specific structured data (indices, ranges, etc.)
  audience: 'Private' | 'Anon' | 'Allowlist';
  primary_type: 'identity' | 'recurring' | 'prospective' | 'knowledge' | 'predictive';
  allowlist_id?: string;
  allowlist?: number[];
}

interface ListAnswersRequest {
  q_id: string;
  user_id?: number;
  audience?: string;
}

interface AttributionRequest {
  public_id: string;
  author_id: number;
  type: 'question' | 'answer' | 'direct_query';
}

// Environment variables
const PROXY_SECRET = process.env.PROXY_SECRET!;
const NILLION_ORG_KEY = process.env.NILLION_ORG_KEY!;
const NILLION_NODES = process.env.NILLION_NODES!;
const NILAUTH_URL = process.env.NILAUTH_URL || 'https://nilauth.sandbox.app-cluster.sandbox.nilogy.xyz';
const NILLION_PRIVATE_ANSWER_SCHEMA_ID = process.env.NILLION_PRIVATE_ANSWER_SCHEMA_ID!;
const NILLION_ANON_ANSWER_SCHEMA_ID = process.env.NILLION_ANON_ANSWER_SCHEMA_ID!;
const NILLION_ALLOWLIST_ANSWER_SCHEMA_ID = process.env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID!;
const NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID = process.env.NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID!;

// Cached client (refreshed on auth errors)
let cachedClient: SecretVaultBuilderClient | null = null;

async function getNillionClient(): Promise<SecretVaultBuilderClient> {
  if (cachedClient) {
    return cachedClient;
  }

  // Parse nodes
  const nodesData = JSON.parse(NILLION_NODES);
  const nodeUrls = nodesData.map((node: { url: string } | string) => 
    typeof node === 'string' ? node : node.url
  );

  // Create signer
  const signer = Signer.fromPrivateKey(NILLION_ORG_KEY);

  // Create Nilauth client
  const nilauthClient = await NilauthClient.create({
    baseUrl: NILAUTH_URL,
  });

  // Initialize client
  const client = await SecretVaultBuilderClient.from({
    signer,
    nilauthClient,
    dbs: nodeUrls,
    blindfold: {
      operation: 'store' as const,
    },
  });

  // Authenticate
  await client.refreshRootToken();

  cachedClient = client;
  return client;
}

function getSchemaId(audience: string): string {
  switch (audience) {
    case 'Private':
      return NILLION_PRIVATE_ANSWER_SCHEMA_ID;
    case 'Anon':
      return NILLION_ANON_ANSWER_SCHEMA_ID;
    case 'Allowlist':
      return NILLION_ALLOWLIST_ANSWER_SCHEMA_ID;
    default:
      throw new Error(`Unknown audience: ${audience}`);
  }
}

/**
 * Recursively convert BigInt values to strings for JSON serialization
 */
function sanitizeBigInt(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeBigInt(item));
  }
  
  if (typeof obj === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeBigInt(value);
    }
    return sanitized;
  }
  
  return obj;
}

// Create Hono app
const app = new Hono();

// CORS (restrict to your worker in production)
app.use('*', cors({
  origin: ['https://qbase.tech', 'https://qbase.z00.workers.dev'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Proxy-Secret'],
}));

// Auth middleware - verify requests come from our worker
app.use('/v1/*', async (c, next) => {
  const secret = c.req.header('X-Proxy-Secret');
  if (secret !== PROXY_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'nillion-proxy' });
});

// Store an answer
app.post('/v1/answers', async (c) => {
  try {
    const body = await c.req.json<StoreAnswerRequest>();
    const client = await getNillionClient();
    const schemaId = getSchemaId(body.audience);

    // Prepare data with encryption markers
    // %allot = encryption marker for data payload (triggers secret sharing across nodes)
    // Note: %share is used in schema definitions, %allot is used in data payloads
    let user_id: number | { '%allot': number } = body.user_id;
    let value: string | { '%allot': string } = body.value;

    if (body.audience === 'Private') {
      user_id = { '%allot': body.user_id };
      value = { '%allot': body.value };
    } else if (body.audience === 'Anon') {
      user_id = { '%allot': body.user_id };
      // value remains plain for anon
    } else if (body.audience === 'Allowlist') {
      // user_id remains plain for allowlist
      value = { '%allot': body.value };
    }

    const now = new Date().toISOString();
    const answerId = crypto.randomUUID();

    const answerData: Record<string, unknown> = {
      _id: answerId,
      q_id: body.q_id,
      user_id,
      value,
      answer_type_id: body.answer_type_id, // Integer as per schema
      suggested_answer_type_id: body.answer_type_id,
      audience: body.audience,
      created_at: now,
      primary_type: body.primary_type,
    };

    console.log(`[Store Answer] Preparing to store ${body.audience} answer:`, JSON.stringify({
      answerId,
      schemaId,
      q_id: body.q_id,
      user_id_encrypted: typeof user_id === 'object',
      value_encrypted: typeof value === 'object',
      answer_type_id: body.answer_type_id,
      primary_type: body.primary_type,
    }, null, 2));
    console.log('[Store Answer] Full answerData object:', JSON.stringify(answerData, null, 2));

    // Add type-specific fields
    if (body.primary_type === 'identity' || body.primary_type === 'prospective' || body.primary_type === 'knowledge') {
      // Editable types: can be updated as user learns/changes
      answerData.updated_at = now;
    } else if (body.primary_type === 'recurring') {
      // Temporal tracking: can be soft-deleted
      answerData.is_deleted = false;
    }
    // predictive: immutable (no special fields, only created_at for integrity)

    // Add allowlist fields
    if (body.audience === 'Allowlist') {
      if (body.allowlist_id) {
        answerData.allowlist_id = body.allowlist_id;
      } else if (body.allowlist) {
        answerData.allowlist = body.allowlist.map(id => id.toString());
      }
    }

    // Store in Nillion
    const result = await client.createStandardData({
      collection: schemaId,
      data: [answerData],
    });

    return c.json({
      success: true,
      answer_id: answerId,
      nillion_result: sanitizeBigInt(result),
    });
  } catch (error) {
    console.error('Error storing answer:', error);
    // Log full error details for debugging
    if (error && typeof error === 'object') {
      console.error('Full error object:', JSON.stringify(error, null, 2));
    }
    cachedClient = null; // Reset client on error
    return c.json({ 
      error: 'Failed to store answer', 
      details: error instanceof Error ? error.message : 'Unknown error',
      fullError: error && typeof error === 'object' ? JSON.stringify(error, null, 2) : String(error)
    }, 500);
  }
});

// List answers for a query
app.get('/v1/answers', async (c) => {
  try {
    const q_id = c.req.query('q_id');
    const user_id = c.req.query('user_id');
    const audience = c.req.query('audience');

    if (!q_id) {
      return c.json({ error: 'q_id is required' }, 400);
    }

    const client = await getNillionClient();
    const results: Record<string, unknown>[] = [];

    // Determine which schemas to query
    const audiences = audience 
      ? audience.split(',') 
      : ['Private', 'Anon', 'Allowlist'];

    for (const aud of audiences) {
      try {
        const schemaId = getSchemaId(aud.trim());
        const filter: Record<string, unknown> = { q_id };
        
        // For Private and Allowlist answers, filter by user_id
        // Note: Anon answers have encrypted user_id, so we can't filter by it
        if ((aud === 'Private' || aud === 'Allowlist') && user_id) {
          filter.user_id = parseInt(user_id);
        }

        const response = await client.findData({
          collection: schemaId,
          filter,
        });

        if (response?.data) {
          // Sanitize BigInt values before pushing to results
          const sanitizedData = sanitizeBigInt(response.data) as Record<string, unknown>[];
          results.push(...sanitizedData);
        }
      } catch (e) {
        console.error(`Error fetching ${aud} answers:`, e);
        // Continue with other audiences
      }
    }

    return c.json({
      results: sanitizeBigInt(results),
      total: results.length,
    });
  } catch (error) {
    console.error('Error listing answers:', error);
    cachedClient = null;
    return c.json({ 
      error: 'Failed to list answers', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

// Get single answer
app.get('/v1/answers/:id', async (c) => {
  try {
    const answerId = c.req.param('id');
    const client = await getNillionClient();

    // Try each schema (private and allowlist are E2E encrypted, anon is server-encrypted)
    const schemas = [
      NILLION_ANON_ANSWER_SCHEMA_ID,
      NILLION_PRIVATE_ANSWER_SCHEMA_ID,
      NILLION_ALLOWLIST_ANSWER_SCHEMA_ID,
    ];

    for (const schemaId of schemas) {
      try {
        const response = await client.findData({
          collection: schemaId,
          filter: { _id: answerId },
        });

        if (response?.data && (response.data as unknown[]).length > 0) {
          return c.json(sanitizeBigInt((response.data as unknown[])[0]));
        }
      } catch {
        continue;
      }
    }

    return c.json({ error: 'Answer not found' }, 404);
  } catch (error) {
    console.error('Error getting answer:', error);
    cachedClient = null;
    return c.json({ 
      error: 'Failed to get answer', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

// Create attribution (for anonymous content)
app.post('/v1/attributions', async (c) => {
  try {
    const body = await c.req.json<AttributionRequest>();
    const client = await getNillionClient();

    const attributionId = crypto.randomUUID();
    const attributionData = {
      _id: attributionId,
      public_id: body.public_id,
      // Convert to string because SDK's blindfold transforms values during secret sharing,
      // and the schema %share type must be string to accept the transformed output
      author_id: { '%allot': String(body.author_id) },
      type: body.type,
    };

    console.log('[Attribution] Creating attribution:', JSON.stringify({
      attributionId,
      collectionId: NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID,
      public_id: body.public_id,
      author_id_type: typeof body.author_id,
      type: body.type,
    }));

    const result = await client.createStandardData({
      collection: NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID,
      data: [attributionData],
    });

    console.log('[Attribution] Success:', JSON.stringify(result));

    return c.json({
      success: true,
      attribution_id: attributionId,
    });
  } catch (error) {
    console.error('Error creating attribution:', error);
    // Log full error structure for debugging
    if (error && typeof error === 'object') {
      console.error('[Attribution] Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      if (Array.isArray(error)) {
        for (const e of error) {
          console.error('[Attribution] Node error:', JSON.stringify(e, null, 2));
        }
      }
    }
    cachedClient = null;
    return c.json({ 
      error: 'Failed to create attribution', 
      details: error instanceof Error ? error.message : JSON.stringify(error)
    }, 500);
  }
});

// Get attribution by public_id
app.get('/v1/attributions/:public_id', async (c) => {
  try {
    const publicId = c.req.param('public_id');
    const client = await getNillionClient();

    const response = await client.findData({
      collection: NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID,
      filter: { public_id: publicId },
    });

    if (response?.data && (response.data as unknown[]).length > 0) {
      return c.json(sanitizeBigInt((response.data as unknown[])[0]));
    }

    return c.json({ error: 'Attribution not found' }, 404);
  } catch (error) {
    console.error('Error getting attribution:', error);
    cachedClient = null;
    return c.json({ 
      error: 'Failed to get attribution', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

// List attributions by author_id and type
// Used to find user's own anonymous content
app.get('/v1/attributions', async (c) => {
  try {
    const authorId = c.req.query('author_id');
    const type = c.req.query('type'); // 'question' | 'answer' | 'direct_query'

    if (!authorId) {
      return c.json({ error: 'author_id is required' }, 400);
    }

    const client = await getNillionClient();

    // Query all attributions of this type
    const filter: Record<string, unknown> = {};
    if (type) {
      filter.type = type;
    }

    const response = await client.findData({
      collection: NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID,
      filter,
    });

    if (!response?.data) {
      return c.json({ results: [], total: 0 });
    }

    const allAttributions = response.data as Array<{
      _id: string;
      public_id: string;
      author_id: number; // Decrypted by SDK
      type: string;
    }>;

    // Filter by author_id (the SDK returns decrypted values, no need to check %share/%allot)
    const authorIdNum = parseInt(authorId);
    const matchingAttributions = allAttributions.filter(attr => {
      // After SDK decryption, author_id should be the plain number value
      const decryptedAuthorId = typeof attr.author_id === 'number' 
        ? attr.author_id 
        : attr.author_id;
      return decryptedAuthorId === authorIdNum;
    });

    return c.json({
      results: sanitizeBigInt(matchingAttributions),
      total: matchingAttributions.length,
    });
  } catch (error) {
    console.error('Error listing attributions:', error);
    cachedClient = null;
    return c.json({ 
      error: 'Failed to list attributions', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

// =========================================================================
// E2E ENCRYPTION - Delegation Tokens
// =========================================================================

interface DelegationTokenRequest {
  userDid: string;
  userId: number;
  collectionType: 'private' | 'allowlist';
}

/**
 * Generate a delegation token for E2E encrypted answer storage.
 * 
 * The delegation token allows a user's browser-based Nillion client to
 * write directly to the owned collection without exposing the org key.
 * 
 * collectionType:
 * - 'private': Private answers collection (user_id encrypted, value encrypted)
 *              Only the owner can read their answers.
 * - 'allowlist': Allowlist answers collection (user_id plain, value encrypted)
 *                Owner + allowlist members can read answers.
 * 
 * POST /v1/delegation-token
 */
app.post('/v1/delegation-token', async (c) => {
  try {
    const body = await c.req.json<DelegationTokenRequest>();
    
    if (!body.userDid || !body.userId) {
      return c.json({ error: 'userDid and userId are required' }, 400);
    }

    // Validate userDid format
    if (!body.userDid.startsWith('did:')) {
      return c.json({ error: 'Invalid userDid format' }, 400);
    }

    const client = await getNillionClient();
    
    // Determine which collection to grant access to
    const collectionType = body.collectionType || 'private';
    let collectionId: string;
    
    if (collectionType === 'private') {
      // Private answers: user_id encrypted, value encrypted
      collectionId = NILLION_PRIVATE_ANSWER_SCHEMA_ID;
    } else if (collectionType === 'allowlist') {
      // Allowlist answers: user_id plain, value encrypted
      collectionId = NILLION_ALLOWLIST_ANSWER_SCHEMA_ID;
    } else {
      return c.json({ error: 'Invalid collectionType. Use "private" or "allowlist".' }, 400);
    }

    console.log(`[E2E] Starting delegation token creation for user ${body.userId}`);
    
    // Clear cached client to force fresh authentication
    // This ensures we get a new root token with a fresh expiration
    cachedClient = null;
    console.log(`[E2E] Cleared cached client, getting fresh client...`);
    
    const freshClient = await getNillionClient();
    console.log(`[E2E] Got fresh client`);

    // Get the root token from the fresh client
    const rootToken = freshClient.rootToken;
    if (!rootToken) {
      throw new Error('No root token available from client');
    }
    console.log(`[E2E] Got root token`);

    // Parse the user DID using @nillion/nuc
    const { Builder, Did } = await import('@nillion/nuc');
    const audienceDid = Did.parse(body.userDid);
    console.log(`[E2E] Parsed audience DID: ${body.userDid.slice(0, 30)}...`);

    // Create signer from org key
    const signer = Signer.fromPrivateKey(NILLION_ORG_KEY);
    console.log(`[E2E] Created signer`);

    // Build delegation token
    // IMPORTANT: expiresIn() takes MILLISECONDS, not seconds!
    const expiresInMs = 5 * 60 * 1000; // 5 minutes in milliseconds
    console.log(`[E2E] Token will expire in ${expiresInMs}ms (${expiresInMs / 1000} seconds)`);

    const tokenString = await Builder.delegationFrom(rootToken)
      .audience(audienceDid)
      .expiresIn(expiresInMs)
      .signAndSerialize(signer);
    
    console.log(`[E2E] Created delegation token (length: ${tokenString.length})`);

    console.log(`[E2E] Issued delegation token for user ${body.userId} (DID: ${body.userDid.slice(0, 20)}...) collection: ${collectionType} (${collectionId})`);

    return c.json({
      delegationToken: tokenString,
      collectionId,
    });
  } catch (error) {
    console.error('Error creating delegation token:', error);
    cachedClient = null;
    return c.json({ 
      error: 'Failed to create delegation token', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
  }
});

// Start server
const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 Nillion proxy starting on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});


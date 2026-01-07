import { getNillionClient } from '../src/lib/nillion/client';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';

// Load environment variables
dotenv.config({ path: '.dev.vars' });

interface TestEnv {
  NILLION_ORG_DID: string;
  NILLION_ORG_KEY: string;
  NILLION_NODES: string;
  NILAUTH_URL: string | undefined;
  NILLION_PRIVATE_ANSWER_SCHEMA_ID: string;
  NILLION_ANON_ANSWER_SCHEMA_ID: string;
  NILLION_ALLOWLIST_ANSWER_SCHEMA_ID: string;
}

const mockEnv: TestEnv = {
  NILLION_ORG_DID: process.env.NILLION_ORG_DID || '',
  NILLION_ORG_KEY: process.env.NILLION_ORG_KEY || '',
  NILLION_NODES: process.env.NILLION_NODES || '[]',
  NILAUTH_URL: process.env.NILAUTH_URL,
  NILLION_PRIVATE_ANSWER_SCHEMA_ID: process.env.NILLION_PRIVATE_ANSWER_SCHEMA_ID || '',
  NILLION_ANON_ANSWER_SCHEMA_ID: process.env.NILLION_ANON_ANSWER_SCHEMA_ID || '',
  NILLION_ALLOWLIST_ANSWER_SCHEMA_ID: process.env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID || '',
};

async function main() {
  try {
    console.log('🛠️  Setting up Nillion Collections...\n');

    // Step 1: Initialize client
    console.log('📡 Initializing Nillion client...');
    const client = await getNillionClient(mockEnv);
    console.log('✅ Client initialized\n');

    // Step 2: Create collections
    // - Standard collections: server-managed (anon answers, attributions)
    // - Owned collection: user E2E encrypted (private + allowlist answers)
    const standardCollections = [
      { name: 'anon_answers', file: 'anonAnswerSchema.json' },
      { name: 'anon_query_attribution', file: 'anonQueryAttributionSchema.json' },
    ];

    const ownedCollections = [
      { name: 'user_owned_answers', file: 'privateAnswerSchema.json' },
    ];

    console.log('📝 Creating standard collections (server-managed)...\n');

    const collectionIds: Record<string, string> = {};

    for (const { name, file } of standardCollections) {
      const schema = JSON.parse(
        readFileSync(`./src/lib/schemas/${file}`, 'utf-8')
      );

      const collectionId = crypto.randomUUID();

      await client.createCollection({
        _id: collectionId,
        type: 'standard',
        name,
        schema,
      });

      collectionIds[name] = collectionId;
      console.log(`✅ Created standard collection ${name}: ${collectionId}`);
    }

    console.log('\n📝 Creating owned collections (E2E encrypted, user-owned)...\n');

    for (const { name, file } of ownedCollections) {
      const schema = JSON.parse(
        readFileSync(`./src/lib/schemas/${file}`, 'utf-8')
      );

      const collectionId = crypto.randomUUID();

      await client.createCollection({
        _id: collectionId,
        type: 'owned',
        name,
        schema,
      });

      collectionIds[name] = collectionId;
      console.log(`✅ Created owned collection ${name}: ${collectionId}`);
    }

    console.log('\n🎉 All collections created successfully!');
    console.log('\n⚠️  ACTION REQUIRED: Update your .dev.vars and wrangler.jsonc with these IDs\n');
    
    // Output in .dev.vars format
    console.log('--- For .dev.vars ---');
    if (collectionIds.anon_answers) {
      console.log(`NILLION_ANON_ANSWER_SCHEMA_ID=${collectionIds.anon_answers}`);
    }
    if (collectionIds.anon_query_attribution) {
      console.log(`NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID=${collectionIds.anon_query_attribution}`);
    }
    if (collectionIds.user_owned_answers) {
      console.log(`NILLION_USER_OWNED_ANSWER_SCHEMA_ID=${collectionIds.user_owned_answers}`);
    }
    
    // Output in wrangler.jsonc format
    console.log('\n--- For wrangler.jsonc (vars section) ---');
    console.log('"vars": {');
    if (collectionIds.anon_answers) {
      console.log(`  "NILLION_ANON_ANSWER_SCHEMA_ID": "${collectionIds.anon_answers}",`);
    }
    if (collectionIds.anon_query_attribution) {
      console.log(`  "NILLION_ANON_QUERY_ATTRIBUTION_SCHEMA_ID": "${collectionIds.anon_query_attribution}",`);
    }
    if (collectionIds.user_owned_answers) {
      console.log(`  "NILLION_USER_OWNED_ANSWER_SCHEMA_ID": "${collectionIds.user_owned_answers}",`);
    }
    console.log('}');

    console.log('\n📋 Collection types:');
    console.log('  - anon_answers: standard (server encrypts with org key)');
    console.log('  - anon_query_attribution: standard (server encrypts with org key)');
    console.log('  - user_owned_answers: owned (E2E encrypted, user owns data)');
    console.log('    └─ Used for both Private and Allowlist answers');
    console.log('    └─ ACLs control access (Private = owner only, Allowlist = owner + members)');

  } catch (error: unknown) {
    const err = error as { message?: string; context?: unknown };
    console.error('\n❌ Setup failed:', err.message);
    if (err.context) {
      console.error('Error details:', JSON.stringify(err.context, null, 2));
    }
    process.exit(1);
  }
}

main();

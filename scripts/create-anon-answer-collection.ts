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
}

const mockEnv: TestEnv = {
  NILLION_ORG_DID: process.env.NILLION_ORG_DID || '',
  NILLION_ORG_KEY: process.env.NILLION_ORG_KEY || '',
  NILLION_NODES: process.env.NILLION_NODES || '[]',
  NILAUTH_URL: process.env.NILAUTH_URL,
};

async function main() {
  try {
    console.log('🛠️  Creating Anonymous Answer Nillion Collection...\n');

    // Step 1: Initialize client
    console.log('📡 Initializing Nillion client...');
    const client = await getNillionClient(mockEnv);
    console.log('✅ Client initialized\n');

    // Step 2: Create anon answers collection (standard, server-side encrypted user_id)
    // Anon answers have user_id ENCRYPTED (server-side) and value PLAIN
    console.log('📝 Creating anon_answers collection...\n');

    const anonSchema = JSON.parse(
      readFileSync('./src/lib/schemas/anonAnswerSchema.json', 'utf-8')
    );

    const anonCollectionId = crypto.randomUUID();

    await client.createCollection({
      _id: anonCollectionId,
      type: 'standard',
      name: 'anon_answers',
      schema: anonSchema,
    });

    console.log(`✅ Created standard collection: anon_answers`);
    console.log(`   Collection ID: ${anonCollectionId}\n`);

    console.log('🎉 Collection created successfully!');
    console.log('\n⚠️  ACTION REQUIRED: Update your configuration files with this ID\n');
    
    // Output in .dev.vars format
    console.log('--- For .dev.vars ---');
    console.log(`NILLION_ANON_ANSWER_SCHEMA_ID=${anonCollectionId}`);
    
    // Output in wrangler.jsonc format
    console.log('\n--- For wrangler.jsonc and wrangler.dev.jsonc (vars section) ---');
    console.log(`"NILLION_ANON_ANSWER_SCHEMA_ID": "${anonCollectionId}",`);

    // Output in Fly.io secrets format
    console.log('\n--- For Fly.io secrets (nillion-proxy) ---');
    console.log(`flyctl secrets set NILLION_ANON_ANSWER_SCHEMA_ID="${anonCollectionId}" --app qbase-nillion-proxy`);

    console.log('\n📋 Collection details:');
    console.log('\n1️⃣  anon_answers (standard, server-side encrypted user_id)');
    console.log('  - Type: standard');
    console.log('  - Purpose: Anonymous answers (visible to all, but user identity hidden)');
    console.log('  - Encryption: Server-side (proxy) using %allot for secret sharing');
    console.log('  - user_id: ENCRYPTED (server encrypts and distributes shares across nodes)');
    console.log('  - value: PLAIN (visible to everyone)');
    console.log('  - answer_type_id: INTEGER (1=text, 2=mc, 3=scale, 4=checkbox)');
    console.log('  - Access Control: Public read, but user_id cannot be reconstructed without key');
    
    console.log('\n✨ Schema supports all primary types:');
    console.log('  - identity (editable, one canonical answer)');
    console.log('  - recurring (soft-deletable, time-series tracking)');
    console.log('  - prospective (editable, future plans)');
    console.log('  - knowledge (editable, external expertise)');
    console.log('  - predictive (immutable, predictions with integrity)');
    
    console.log('\n🔒 Privacy guarantee:');
    console.log('  - User identity protected via secret sharing (%allot)');
    console.log('  - Answer content visible for public discourse');
    console.log('  - Cannot link answers to users without decryption key');

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

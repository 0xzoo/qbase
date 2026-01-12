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
    console.log('🛠️  Creating Private & Allowlist Nillion Collections...\n');

    // Step 1: Initialize client
    console.log('📡 Initializing Nillion client...');
    const client = await getNillionClient(mockEnv);
    console.log('✅ Client initialized\n');

    const collectionIds: Record<string, string> = {};

    // Step 2: Create private answers collection (owned, E2E encrypted)
    // Private answers have BOTH user_id AND value encrypted
    console.log('📝 Creating private_answers collection (E2E encrypted)...\n');

    const privateSchema = JSON.parse(
      readFileSync('./src/lib/schemas/privateAnswerSchema.json', 'utf-8')
    );

    const privateCollectionId = crypto.randomUUID();

    await client.createCollection({
      _id: privateCollectionId,
      type: 'owned',
      name: 'private_answers',
      schema: privateSchema,
    });

    collectionIds.private_answers = privateCollectionId;
    console.log(`✅ Created owned collection: private_answers`);
    console.log(`   Collection ID: ${privateCollectionId}\n`);

    // Step 3: Create allowlist answers collection (owned, E2E encrypted)
    // Allowlist answers have user_id PLAIN, value encrypted
    console.log('📝 Creating allowlist_answers collection (E2E encrypted)...\n');

    const allowlistSchema = JSON.parse(
      readFileSync('./src/lib/schemas/allowlistAnswerSchema.json', 'utf-8')
    );

    const allowlistCollectionId = crypto.randomUUID();

    await client.createCollection({
      _id: allowlistCollectionId,
      type: 'owned',
      name: 'allowlist_answers',
      schema: allowlistSchema,
    });

    collectionIds.allowlist_answers = allowlistCollectionId;
    console.log(`✅ Created owned collection: allowlist_answers`);
    console.log(`   Collection ID: ${allowlistCollectionId}\n`);

    console.log('🎉 All collections created successfully!');
    console.log('\n⚠️  ACTION REQUIRED: Update your configuration files with these IDs\n');
    
    // Output in .dev.vars format
    console.log('--- For .dev.vars ---');
    console.log(`NILLION_PRIVATE_ANSWER_SCHEMA_ID=${collectionIds.private_answers}`);
    console.log(`NILLION_ALLOWLIST_ANSWER_SCHEMA_ID=${collectionIds.allowlist_answers}`);
    
    // Output in wrangler.jsonc format
    console.log('\n--- For wrangler.jsonc and wrangler.dev.jsonc (vars section) ---');
    console.log(`"NILLION_PRIVATE_ANSWER_SCHEMA_ID": "${collectionIds.private_answers}",`);
    console.log(`"NILLION_ALLOWLIST_ANSWER_SCHEMA_ID": "${collectionIds.allowlist_answers}",`);

    console.log('\n📋 Collection details:');
    
    console.log('\n1️⃣  private_answers (owned, E2E encrypted)');
    console.log('  - Type: owned');
    console.log('  - Purpose: Private answers (visible only to owner)');
    console.log('  - Encryption: Client-side (browser) with wallet-derived keys');
    console.log('  - user_id: ENCRYPTED (cannot link answers to users)');
    console.log('  - value: ENCRYPTED (only owner can decrypt)');
    console.log('  - Access Control: ACL grants access to owner only');
    
    console.log('\n2️⃣  allowlist_answers (owned, E2E encrypted)');
    console.log('  - Type: owned');
    console.log('  - Purpose: Allowlist answers (visible to owner + allowlist members)');
    console.log('  - Encryption: Client-side (browser) with wallet-derived keys');
    console.log('  - user_id: PLAIN (allowlist members can see who answered)');
    console.log('  - value: ENCRYPTED (only authorized users can decrypt)');
    console.log('  - Access Control: ACL grants access to owner + allowlist members');

    console.log('\n📝 Note: anon_answers collection already exists (not created by this script)');
    
    console.log('\n✨ All collections now support all primary types:');
    console.log('  - identity (editable, one canonical answer)');
    console.log('  - recurring (soft-deletable, time-series tracking)');
    console.log('  - prospective (editable, future plans)');
    console.log('  - knowledge (editable, external expertise)');
    console.log('  - predictive (immutable, predictions with integrity)');
    
    console.log('\n🔒 Privacy guarantees:');
    console.log('  - Anon: Server encrypts user_id, cannot link answers to users without key');
    console.log('  - Private: Both user_id and value encrypted - true zero-knowledge!');
    console.log('  - Allowlist: user_id plain (for attribution), value encrypted');

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

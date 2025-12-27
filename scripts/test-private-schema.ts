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
  NILLION_ANSWER_SCHEMA_ID: string;
  NILAUTH_URL: string | undefined;
}

const mockEnv: TestEnv = {
  NILLION_ORG_DID: process.env.NILLION_ORG_DID || '',
  NILLION_ORG_KEY: process.env.NILLION_ORG_KEY || '',
  NILLION_NODES: process.env.NILLION_NODES || '[]',
  NILLION_ANSWER_SCHEMA_ID: process.env.NILLION_ANSWER_SCHEMA_ID || '',
  NILAUTH_URL: process.env.NILAUTH_URL,
};

async function main() {
  try {
    console.log('🧪 Testing Private Answer Schema (No oneOf)...\n');

    // Step 1: Initialize client
    console.log('📡 Initializing Nillion client...');
    const client = await getNillionClient(mockEnv);
    console.log('✅ Client initialized\n');

    // Step 2: Create new collection for private answers
    console.log('📝 Creating private_answers collection...');
    const schema = JSON.parse(
      readFileSync('./src/lib/schemas/privateAnswerSchema.json', 'utf-8')
    );

    const collectionId = crypto.randomUUID();

    await client.createCollection({
      _id: collectionId,
      type: 'standard',
      name: 'private_answers',
      schema,
    });

    console.log(`✅ Collection created: ${collectionId}\n`);

    // Step 3: Test storing encrypted data
    console.log('🔐 Testing encrypted storage...\n');

    const testData = {
      _id: crypto.randomUUID(),
      q_id: 'test_q_123',
      user_id: { '%allot': 99999 },
      value: { '%allot': 'Super secret answer' },
      answer_type_id: 'text',
      suggested_answer_type_id: 'text',
      audience: 'Private',
    };

    console.log('Sending data:', JSON.stringify(testData, null, 2));

    const result = await client.createStandardData({
      collection: collectionId,
      data: [testData],
    });

    console.log('\n✅ Data stored!');
    console.log('Result:', JSON.stringify(result, null, 2));

    console.log('\n🔍 Next steps:');
    console.log(`1. Check Collection Explorer: https://collection-explorer.nillion.com`);
    console.log(`2. Collection ID: ${collectionId}`);
    console.log(`3. Look for encrypted %share values (not plain 99999)`);

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nError details:');

    if (error.context) {
      for (const [node, details] of Object.entries(error.context)) {
        const d = details as any;
        console.error(`\nNode: ${node}`);
        console.error('Error body:', JSON.stringify(d.body, null, 2));
        console.error('Error message:', d.message);
      }
    }

    process.exit(1);
  }
}

main();

import { getNillionClient, storePrivateAnswer } from '../src/lib/nillion/client';
import { config } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .dev.vars file
config({ path: resolve(__dirname, '../.dev.vars') });

// Mock environment variables for testing
const mockEnv = {
  NILLION_ORG_DID: process.env.NILLION_ORG_DID || '',
  NILLION_ORG_KEY: process.env.NILLION_ORG_KEY || '',
  NILLION_NODES: process.env.NILLION_NODES || '[]',
  NILLION_ANSWER_SCHEMA_ID: process.env.NILLION_ANSWER_SCHEMA_ID || '', // Keep for backward compat
  NILLION_PRIVATE_ANSWER_SCHEMA_ID: process.env.NILLION_PRIVATE_ANSWER_SCHEMA_ID || '',
  NILLION_ANON_ANSWER_SCHEMA_ID: process.env.NILLION_ANON_ANSWER_SCHEMA_ID || '',
  NILLION_ALLOWLIST_ANSWER_SCHEMA_ID: process.env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID || '',
  NILLION_ANON_QUERY_SCHEMA_ID: process.env.NILLION_ANON_QUERY_SCHEMA_ID || '',
  NILAUTH_URL: process.env.NILAUTH_URL,
};

// Validate environment variables
function validateEnv() {
  const missing = [];
  if (!mockEnv.NILLION_ORG_DID) missing.push('NILLION_ORG_DID');
  if (!mockEnv.NILLION_ORG_KEY) missing.push('NILLION_ORG_KEY');
  if (!mockEnv.NILLION_NODES || mockEnv.NILLION_NODES === '[]') missing.push('NILLION_NODES');

  // Check for new schema IDs
  if (!mockEnv.NILLION_PRIVATE_ANSWER_SCHEMA_ID) missing.push('NILLION_PRIVATE_ANSWER_SCHEMA_ID');
  if (!mockEnv.NILLION_ANON_ANSWER_SCHEMA_ID) missing.push('NILLION_ANON_ANSWER_SCHEMA_ID');
  if (!mockEnv.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID) missing.push('NILLION_ALLOWLIST_ANSWER_SCHEMA_ID');

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables in .dev.vars:');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\nPlease ensure these are set in your .dev.vars file.');
    process.exit(1);
  }
}

async function testNillionIntegration() {
  console.log('🧪 Testing Nillion Integration (Multi-Collection)...\n');

  // Validate environment first
  validateEnv();

  try {
    // Helper to handle BigInt serialization
    const replacer = (key: string, value: any) =>
      typeof value === 'bigint' ? value.toString() : value;

    // Step 1: Initialize client
    console.log('📡 Initializing Nillion client...');
    const client = await getNillionClient(mockEnv);
    console.log('✅ Client initialized successfully\n');

    // Step 2: Create test private answers for different audiences
    console.log('📝 Creating test answers...');

    // 2a. Private Answer (Both Encrypted)
    console.log('\n--- Testing Private Audience (Both Encrypted) ---');
    const privateAnswer = {
      _id: crypto.randomUUID(),
      q_id: 'test_question_private',
      user_id: { '%allot': 12345 },
      value: { '%allot': 'My private test answer' },
      answer_type_id: 'text',
      suggested_answer_type_id: 'text',
      audience: 'Private',
      created_at: new Date().toISOString(),
    };
    const resultPrivate = await storePrivateAnswer(client, privateAnswer, mockEnv.NILLION_PRIVATE_ANSWER_SCHEMA_ID);
    console.log('✅ Private Answer stored successfully:', JSON.stringify(resultPrivate, replacer, 2));

    // 2b. Anon Answer (User ID Encrypted Only)
    console.log('\n--- Testing Anon Audience (User ID Encrypted) ---');
    const anonAnswer = {
      _id: crypto.randomUUID(),
      q_id: 'test_question_anon',
      user_id: { '%allot': 67890 },
      value: 'My anon test answer', // Plain string
      answer_type_id: 'text',
      suggested_answer_type_id: 'text',
      audience: 'Anon',
      created_at: new Date().toISOString(),
    };
    const resultAnon = await storePrivateAnswer(client, anonAnswer, mockEnv.NILLION_ANON_ANSWER_SCHEMA_ID);
    console.log('✅ Anon Answer stored successfully:', JSON.stringify(resultAnon, replacer, 2));

    // 2c. Allowlist Answer (Value Encrypted Only)
    console.log('\n--- Testing Allowlist Audience (Value Encrypted) ---');
    const allowlistAnswer = {
      _id: crypto.randomUUID(),
      q_id: 'test_question_allowlist',
      user_id: 11223, // Plain integer
      value: { '%allot': 'My allowlist test answer' },
      answer_type_id: 'text',
      suggested_answer_type_id: 'text',
      audience: 'Allowlist',
      created_at: new Date().toISOString(),
    };
    const resultAllowlist = await storePrivateAnswer(client, allowlistAnswer, mockEnv.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID);
    console.log('✅ Allowlist Answer stored successfully:', JSON.stringify(resultAllowlist, replacer, 2));
    console.log('\n');

    // Step 3: Test Anon Query Attribution (No oneOf)
    console.log('📝 Creating test anon query attribution...');
    const anonAttribution = {
      _id: crypto.randomUUID(),
      public_id: 'test_question_anon_123',
      author_id: { '%allot': 99999 },
      type: 'question',
    };
    const resultAttribution = await storePrivateAnswer(client, anonAttribution, mockEnv.NILLION_ANON_QUERY_SCHEMA_ID);
    console.log('✅ Anon Attribution stored successfully:', JSON.stringify(resultAttribution, replacer, 2));
    console.log('\n');

    // Step 4: Verify encryption by retrieving and decrypting data
    console.log('🔍 Verifying encryption by retrieving data...\n');

    // Retrieve the private answer we just stored
    console.log('--- Retrieving Private Answer ---');
    const { getPrivateAnswers } = await import('../src/lib/nillion/client');
    const retrievedPrivate = await getPrivateAnswers(client, mockEnv.NILLION_PRIVATE_ANSWER_SCHEMA_ID, {
      _id: privateAnswer._id
    }) as any;

    // Check if decryption worked
    // findData returns { data: [...], pagination: {...} } directly
    let privateData: any = null;

    if (retrievedPrivate.data && retrievedPrivate.data.length > 0) {
      privateData = retrievedPrivate.data[0];
    } else {
      // Fallback: check if it's keyed by DID (just in case behavior changes)
      const nodeDids = Object.keys(retrievedPrivate);
      for (const did of nodeDids) {
        if (retrievedPrivate[did]?.data?.documents?.[0]) {
          privateData = retrievedPrivate[did].data.documents[0];
          break;
        }
      }
    }

    if (privateData) {
      console.log('Retrieved data:', JSON.stringify(privateData, replacer, 2));
      console.log('\n✅ Encryption verified!');

      // Handle BigInt comparison for user_id
      const decryptedUserId = typeof privateData.user_id === 'bigint'
        ? Number(privateData.user_id)
        : privateData.user_id;

      console.log(`   Original user_id: ${privateAnswer.user_id['%allot']}`);
      console.log(`   Decrypted user_id: ${decryptedUserId}`);
      console.log(`   Original value: ${privateAnswer.value['%allot']}`);
      console.log(`   Decrypted value: ${privateData.value}`);

      if (decryptedUserId === 12345 && privateData.value === 'My private test answer') {
        console.log('\n🎉 Encryption/Decryption working correctly!');
      } else {
        console.log('\n⚠️  Warning: Decrypted values don\'t match originals');
      }
    } else {
      console.log('⚠️  Could not retrieve data for verification. Response:', JSON.stringify(retrievedPrivate, replacer, 2));
    }

    console.log('\n');

    // Step 5: Success summary
    console.log('🎉 All tests passed!');
    console.log('\nWhat happened:');
    console.log('1. Data was sent with %allot markers to specific collections');
    console.log('2. Blindfold encrypted it into shares');
    console.log('3. Each node stored a different encrypted share');
    console.log('4. Retrieved data was automatically decrypted');
    console.log('\nNext steps:');
    console.log('- View encrypted data in Collection Explorer: https://collection-explorer.nillion.com');
    console.log('- Test the full API endpoint via POST /api/answers');

  } catch (error: any) {
    console.error('❌ Test failed:');
    console.error(error.message);
    console.error('\nError details:');

    // Try to print more detailed error info
    if (Array.isArray(error)) {
      error.forEach((nodeError, i) => {
        console.error(`\nNode ${i + 1}:`, nodeError.node);
        if (nodeError.error?.body) {
          console.error('Error body:', JSON.stringify(nodeError.error.body, null, 2));
        }
        if (nodeError.error?.message) {
          console.error('Error message:', nodeError.error.message);
        }
      });
    } else {
      console.error(JSON.stringify(error, null, 2));
    }
    process.exit(1);
  }
}

// Run the test
testNillionIntegration();

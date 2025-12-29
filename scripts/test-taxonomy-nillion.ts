import { getNillionClient, storePrivateAnswer, getPrivateAnswers } from '../src/lib/nillion/client';
import { config } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

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
  NILLION_PRIVATE_ANSWER_SCHEMA_ID: process.env.NILLION_PRIVATE_ANSWER_SCHEMA_ID || '',
  NILLION_ANON_ANSWER_SCHEMA_ID: process.env.NILLION_ANON_ANSWER_SCHEMA_ID || '',
  NILLION_ALLOWLIST_ANSWER_SCHEMA_ID: process.env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID || '',
  NILAUTH_URL: process.env.NILAUTH_URL,
};

// Validate environment variables
function validateEnv() {
  const missing: string[] = [];
  if (!mockEnv.NILLION_ORG_DID) missing.push('NILLION_ORG_DID');
  if (!mockEnv.NILLION_ORG_KEY) missing.push('NILLION_ORG_KEY');
  if (!mockEnv.NILLION_NODES || mockEnv.NILLION_NODES === '[]') missing.push('NILLION_NODES');
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

type PrimaryType = 'identity' | 'recurring' | 'prospective';
type Audience = 'Private' | 'Anon' | 'Allowlist';

interface TestCase {
  primary_type: PrimaryType;
  audience: Audience;
  description: string;
}

const testCases: TestCase[] = [
  // Identity answers
  { primary_type: 'identity', audience: 'Private', description: 'Identity + Private (both encrypted)' },
  { primary_type: 'identity', audience: 'Anon', description: 'Identity + Anon (user_id encrypted)' },
  { primary_type: 'identity', audience: 'Allowlist', description: 'Identity + Allowlist (value encrypted)' },
  
  // Recurring answers
  { primary_type: 'recurring', audience: 'Private', description: 'Recurring + Private (both encrypted)' },
  { primary_type: 'recurring', audience: 'Anon', description: 'Recurring + Anon (user_id encrypted)' },
  { primary_type: 'recurring', audience: 'Allowlist', description: 'Recurring + Allowlist (value encrypted)' },
  
  // Prospective answers
  { primary_type: 'prospective', audience: 'Private', description: 'Prospective + Private (both encrypted)' },
  { primary_type: 'prospective', audience: 'Anon', description: 'Prospective + Anon (user_id encrypted)' },
  { primary_type: 'prospective', audience: 'Allowlist', description: 'Prospective + Allowlist (value encrypted)' },
];

function getSchemaId(audience: Audience): string {
  switch (audience) {
    case 'Private':
      return mockEnv.NILLION_PRIVATE_ANSWER_SCHEMA_ID;
    case 'Anon':
      return mockEnv.NILLION_ANON_ANSWER_SCHEMA_ID;
    case 'Allowlist':
      return mockEnv.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID;
  }
}

function createTestAnswer(testCase: TestCase, testId: string): Record<string, unknown> {
  const now = new Date().toISOString();
  const baseAnswer = {
    _id: crypto.randomUUID(),
    q_id: `test_q_${testId}`,
    answer_type_id: 'text',
    suggested_answer_type_id: 'text',
    audience: testCase.audience,
    created_at: now,
    primary_type: testCase.primary_type,
  };

  // Set user_id and value based on audience
  let user_id: number | { '%allot': number };
  let value: string | { '%allot': string };

  if (testCase.audience === 'Private') {
    user_id = { '%allot': 1000 + parseInt(testId) };
    value = { '%allot': `Test answer for ${testCase.description}` };
  } else if (testCase.audience === 'Anon') {
    user_id = { '%allot': 2000 + parseInt(testId) };
    value = `Test answer for ${testCase.description}`; // Plain string
  } else { // Allowlist
    user_id = 3000 + parseInt(testId); // Plain integer
    value = { '%allot': `Test answer for ${testCase.description}` };
  }

  // Add type-specific fields
  if (testCase.primary_type === 'identity' || testCase.primary_type === 'prospective') {
    return {
      ...baseAnswer,
      user_id,
      value,
      updated_at: now,
    };
  } else { // recurring
    return {
      ...baseAnswer,
      user_id,
      value,
      is_deleted: false,
    };
  }
}

async function testTaxonomyNillion() {
  console.log('🧪 Testing Nillion Integration with Taxonomy (9 Combinations)...\n');

  // Validate environment first
  validateEnv();

  try {
    // Helper to handle BigInt serialization
    const replacer = (_key: string, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value;

    // Step 1: Initialize client
    console.log('📡 Initializing Nillion client...');
    const client = await getNillionClient(mockEnv);
    console.log('✅ Client initialized successfully\n');

    // Step 2: Test all 9 combinations
    console.log('📝 Testing all 9 combinations (3 primary types × 3 privacy tiers)...\n');
    
    const results: Array<{ testCase: TestCase; success: boolean; error?: string; storedId?: string }> = [];

    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      const testId = String(i + 1).padStart(2, '0');
      
      console.log(`\n[${testId}/09] Testing: ${testCase.description}`);
      console.log(`   Primary Type: ${testCase.primary_type}`);
      console.log(`   Audience: ${testCase.audience}`);

      try {
        // Create test answer
        const testAnswer = createTestAnswer(testCase, testId);
        const schemaId = getSchemaId(testCase.audience);

        // Store in Nillion
        await storePrivateAnswer(client, testAnswer, schemaId);
        
        // Use the testAnswer._id as the stored ID
        const storedId = testAnswer._id as string;
        results.push({ testCase, success: true, storedId });
        console.log(`   ✅ Stored successfully (ID: ${storedId})`);

        // Verify retrieval
        try {
          const retrieved = await getPrivateAnswers(client, schemaId, { _id: storedId });
          if (retrieved && retrieved.data && retrieved.data.length > 0) {
            const answer = retrieved.data[0] as Record<string, unknown>;
            console.log(`   ✅ Retrieved and decrypted successfully`);
            console.log(`   ✅ primary_type: ${answer.primary_type}`);
            
            if (testCase.primary_type === 'identity' || testCase.primary_type === 'prospective') {
              if (answer.updated_at) {
                console.log(`   ✅ updated_at: ${answer.updated_at}`);
              } else {
                console.log(`   ⚠️  Missing updated_at field`);
              }
            } else if (testCase.primary_type === 'recurring') {
              if (answer.is_deleted !== undefined) {
                console.log(`   ✅ is_deleted: ${answer.is_deleted}`);
              } else {
                console.log(`   ⚠️  Missing is_deleted field`);
              }
            }
          } else {
            console.log(`   ⚠️  Could not retrieve answer for verification`);
          }
        } catch (retrieveError) {
          console.log(`   ⚠️  Could not retrieve answer: ${(retrieveError as Error).message}`);
        }
      } catch (error) {
        const errorMessage = (error as Error).message || 'Unknown error';
        results.push({ testCase, success: false, error: errorMessage });
        console.log(`   ❌ Failed: ${errorMessage}`);
      }
    }

    // Step 3: Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Test Summary');
    console.log('='.repeat(60));
    
    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`\n✅ Passed: ${passed}/9`);
    console.log(`❌ Failed: ${failed}/9\n`);

    if (failed > 0) {
      console.log('Failed tests:');
      results.filter(r => !r.success).forEach((r, i) => {
        console.log(`\n${i + 1}. ${r.testCase.description}`);
        console.log(`   Error: ${r.error}`);
      });
    }

    // Detailed breakdown
    console.log('\n' + '-'.repeat(60));
    console.log('Detailed Results:');
    console.log('-'.repeat(60));
    
    const byType: Record<PrimaryType, { passed: number; failed: number }> = {
      identity: { passed: 0, failed: 0 },
      recurring: { passed: 0, failed: 0 },
      prospective: { passed: 0, failed: 0 },
    };

    const byAudience: Record<Audience, { passed: number; failed: number }> = {
      Private: { passed: 0, failed: 0 },
      Anon: { passed: 0, failed: 0 },
      Allowlist: { passed: 0, failed: 0 },
    };

    results.forEach(r => {
      if (r.success) {
        byType[r.testCase.primary_type].passed++;
        byAudience[r.testCase.audience].passed++;
      } else {
        byType[r.testCase.primary_type].failed++;
        byAudience[r.testCase.audience].failed++;
      }
    });

    console.log('\nBy Primary Type:');
    (['identity', 'recurring', 'prospective'] as PrimaryType[]).forEach(type => {
      const stats = byType[type];
      console.log(`  ${type}: ${stats.passed} passed, ${stats.failed} failed`);
    });

    console.log('\nBy Audience:');
    (['Private', 'Anon', 'Allowlist'] as Audience[]).forEach(audience => {
      const stats = byAudience[audience];
      console.log(`  ${audience}: ${stats.passed} passed, ${stats.failed} failed`);
    });

    if (failed === 0) {
      console.log('\n🎉 All tests passed! The taxonomy migration is complete.');
    } else {
      console.log('\n⚠️  Some tests failed. Please review the errors above.');
      process.exit(1);
    }

  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('\n❌ Test suite failed:');
    console.error(err.message);
    console.error('\nError details:');
    console.error(JSON.stringify(error, null, 2));
    process.exit(1);
  }
}

// Run the test
testTaxonomyNillion();


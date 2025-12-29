import { getNillionClient, getPrivateAnswers } from '../src/lib/nillion/client';
import { config } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .dev.vars file
config({ path: resolve(__dirname, '../.dev.vars') });

// Mock environment variables
const mockEnv = {
  NILLION_ORG_DID: process.env.NILLION_ORG_DID || '',
  NILLION_ORG_KEY: process.env.NILLION_ORG_KEY || '',
  NILLION_NODES: process.env.NILLION_NODES || '[]',
  NILLION_PRIVATE_ANSWER_SCHEMA_ID: process.env.NILLION_PRIVATE_ANSWER_SCHEMA_ID || '',
  NILLION_ANON_ANSWER_SCHEMA_ID: process.env.NILLION_ANON_ANSWER_SCHEMA_ID || '',
  NILLION_ALLOWLIST_ANSWER_SCHEMA_ID: process.env.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID || '',
  NILAUTH_URL: process.env.NILAUTH_URL,
};

async function cleanupTestAnswers() {
  console.log('🧹 Cleaning up test answers from Nillion...\n');

  try {
    // Initialize client
    console.log('📡 Initializing Nillion client...');
    const client = await getNillionClient(mockEnv);
    console.log('✅ Client initialized\n');

    const schemas = [
      { name: 'Private', id: mockEnv.NILLION_PRIVATE_ANSWER_SCHEMA_ID },
      { name: 'Anon', id: mockEnv.NILLION_ANON_ANSWER_SCHEMA_ID },
      { name: 'Allowlist', id: mockEnv.NILLION_ALLOWLIST_ANSWER_SCHEMA_ID },
    ];

    let totalDeleted = 0;

    for (const schema of schemas) {
      if (!schema.id) {
        console.log(`⚠️  Skipping ${schema.name} - no schema ID configured`);
        continue;
      }

      console.log(`\n🔍 Searching for test answers in ${schema.name} collection...`);
      
      try {
        // Find all records with test q_ids
        const results = await getPrivateAnswers(client, schema.id, {});
        
        if (!results || !results.data || results.data.length === 0) {
          console.log(`   No records found in ${schema.name} collection`);
          continue;
        }

        // Filter for test records (q_id starts with "test_q_")
        const testRecords = results.data.filter((record: Record<string, unknown>) => {
          const qId = record.q_id as string;
          return qId && qId.startsWith('test_q_');
        });

        if (testRecords.length === 0) {
          console.log(`   No test records found in ${schema.name} collection`);
          continue;
        }

        console.log(`   Found ${testRecords.length} test record(s) in ${schema.name} collection`);
        
        // Delete each test record
        let deletedCount = 0;
        for (const record of testRecords) {
          const recordId = record._id as string;
          try {
            await client.deleteData({
              collection: schema.id,
              filter: {
                _id: recordId,
              },
            });
            console.log(`   ✅ Deleted test record: ${recordId} (q_id: ${record.q_id})`);
            deletedCount++;
          } catch (deleteError) {
            console.error(`   ❌ Failed to delete record ${recordId}:`, (deleteError as Error).message);
          }
        }

        totalDeleted += deletedCount;
        
        if (deletedCount < testRecords.length) {
          console.log(`   ⚠️  Only deleted ${deletedCount} of ${testRecords.length} test records`);
        }

      } catch (error) {
        console.error(`   ❌ Error searching ${schema.name} collection:`, (error as Error).message);
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Deleted ${totalDeleted} test record(s) across all collections`);
    
    if (totalDeleted === 0) {
      console.log(`\n✅ No test records found - collections are clean!`);
    } else {
      console.log(`\n✅ Cleanup complete! All test records have been removed.`);
    }

  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('\n❌ Cleanup failed:', err.message);
    process.exit(1);
  }
}

// Run the cleanup
cleanupTestAnswers();


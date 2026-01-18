/**
 * Backfill Topics Script
 * 
 * This script triggers the topic backfill process via the admin API.
 * It extracts topics from existing questions' tags and populates the Topics
 * and QueryTopics tables.
 * 
 * Prerequisites:
 * 1. You must be logged in as an admin user
 * 2. Have a valid session token
 * 
 * Usage:
 * 1. First, do a dry run to see what will be processed:
 *    npx tsx scripts/backfill-topics.ts --dry-run
 * 
 * 2. Then run the actual backfill:
 *    npx tsx scripts/backfill-topics.ts
 * 
 * Environment:
 * - QBASE_API_URL: API URL (default: http://localhost:8787 for dev)
 * - QBASE_SESSION_TOKEN: Your admin session token
 */

import { config } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .dev.vars file
config({ path: resolve(__dirname, '../.dev.vars') });

interface BackfillResponse {
  success: boolean;
  dryRun: boolean;
  totalQueries: number;
  processedCount: number;
  topicsCreated: number;
  associationsCreated: number;
  errors: string[];
  errorCount: number;
}

async function backfillTopics() {
  const apiUrl = process.env.QBASE_API_URL || 'http://localhost:8787';
  const sessionToken = process.env.QBASE_SESSION_TOKEN;
  const isDryRun = process.argv.includes('--dry-run');
  const batchSize = parseInt(process.argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1] || '100', 10);

  console.log('🏷️  Topics Backfill Script');
  console.log('========================\n');

  if (!sessionToken) {
    console.error('❌ Error: QBASE_SESSION_TOKEN environment variable is required');
    console.log('\nTo get a session token:');
    console.log('1. Log in to qbase as an admin user');
    console.log('2. Open browser dev tools > Application > Local Storage');
    console.log('3. Copy the value of "qbase_session_token"');
    console.log('4. Set it: export QBASE_SESSION_TOKEN=your_token_here');
    process.exit(1);
  }

  console.log(`📍 API URL: ${apiUrl}`);
  console.log(`🔢 Batch Size: ${batchSize}`);
  console.log(`🧪 Dry Run: ${isDryRun ? 'Yes (no changes will be made)' : 'No (will modify database)'}`);
  console.log('');

  if (!isDryRun) {
    console.log('⚠️  WARNING: This will modify the database!');
    console.log('   Run with --dry-run first to preview changes.\n');
  }

  try {
    console.log('📤 Sending backfill request...\n');

    const response = await fetch(`${apiUrl}/api/admin/topics/backfill`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({
        batchSize,
        dryRun: isDryRun,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ API request failed (${response.status}): ${errorText}`);
      process.exit(1);
    }

    const result = await response.json() as BackfillResponse;

    console.log('📊 Results:');
    console.log('===========');
    console.log(`   Total queries with tags: ${result.totalQueries}`);
    console.log(`   Queries processed: ${result.processedCount}`);
    console.log(`   Topics created: ${result.topicsCreated}`);
    console.log(`   Topic associations created: ${result.associationsCreated}`);
    console.log(`   Errors: ${result.errorCount}`);

    if (result.errors.length > 0) {
      console.log('\n⚠️  First 10 errors:');
      result.errors.forEach((err, i) => {
        console.log(`   ${i + 1}. ${err}`);
      });
    }

    if (result.dryRun) {
      console.log('\n✅ Dry run complete! No changes were made.');
      console.log('   Run without --dry-run to apply changes.');
    } else {
      console.log('\n✅ Backfill complete!');
      console.log('   Topics have been extracted from tags and stored in the database.');
    }

  } catch (error) {
    console.error('\n❌ Script failed:', (error as Error).message);
    process.exit(1);
  }
}

backfillTopics();

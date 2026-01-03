# Vector Metadata Backfill

This guide explains how to backfill metadata for existing vectors in your Vectorize index.

## Problem

Older questions in the vector index only have minimal metadata:
- `stem`, `type`, `created_at`, `coiner_id`, `options_count`

New questions include enhanced metadata:
- `stem`, `text` (alias), `type`, `created_at`, `coiner_id`, `coiner_fid`, `coiner_fname`, `options_count`

Without the enhanced metadata, similarity search results can't display author information in the UI.

## Solution

Run the backfill script to update existing vectors with full metadata from the database.

## Option 1: Via Temporary HTTP Endpoint (Recommended)

This is the easiest method for production workers.

### Step 1: Add temporary endpoint

Add this to `worker/index.ts` (around line 800, near other API routes):

```typescript
// TEMPORARY: Backfill vector metadata (REMOVE AFTER RUNNING)
if (url.pathname === "/admin/backfill-vectors" && request.method === "GET") {
  // Optional: Add authentication check
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== 'Bearer YOUR_SECRET_TOKEN') {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const { backfillVectorMetadata } = await import('./scripts/backfill-vector-metadata-simple');
  return await backfillVectorMetadata(env);
}
```

### Step 2: Deploy

```bash
# For dev environment
npm run deploy:dev

# For production
npm run deploy
```

### Step 3: Run the backfill

```bash
# For dev
curl -H "Authorization: Bearer YOUR_SECRET_TOKEN" https://qbase-dev.z00.workers.dev/admin/backfill-vectors

# For production
curl -H "Authorization: Bearer YOUR_SECRET_TOKEN" https://qbase.tech/admin/backfill-vectors
```

### Step 4: Remove the endpoint

After successful backfill, remove the temporary endpoint from `worker/index.ts` and redeploy.

## Option 2: Via Wrangler CLI

This method runs the script directly via Wrangler.

### Step 1: Add to wrangler config

Add a trigger to `wrangler.jsonc`:

```jsonc
{
  // ... existing config
  "triggers": {
    "crons": ["0 0 * * *"] // Run daily at midnight (or manually trigger)
  }
}
```

### Step 2: Run via Wrangler

```bash
# Test locally first
npx wrangler dev --test-scheduled

# Run in production
npx wrangler deploy
npx wrangler trigger-scheduled backfill-vector-metadata
```

## Verification

After running the backfill:

1. Open the app and start creating a question
2. Type a partial match of an existing question
3. You should now see:
   - Author avatar (or generated dicebear avatar)
   - Author username (not "anonymous")
   - Full question text

## Troubleshooting

### "Vector not found" errors

Some queries might not have vectors in the index. This is expected for:
- Very old questions (before vectorization)
- Deleted questions
- Failed insertions

These can be safely ignored.

### Rate limiting

The script processes in batches to avoid rate limits. If you have thousands of questions:
- Use Option 1 (HTTP endpoint) as it runs in the worker context
- Monitor the output for errors
- Re-run if needed (the script is idempotent)

### Metadata still not showing

Check:
1. The backfill completed successfully
2. The frontend code is deployed with the latest changes
3. Browser cache is cleared (or use incognito/private mode)

## Script Files

- `scripts/backfill-vector-metadata.ts` - Scheduled/CLI version
- `scripts/backfill-vector-metadata-simple.ts` - HTTP endpoint version (recommended)


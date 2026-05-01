/**
 * One-time backfill: fix users with placeholder "user-{fid}" display names.
 *
 * These were created by the snap answer flow (ensureUserByFid) which didn't
 * fetch Neynar profiles. This script finds them all and updates fname from
 * the real Farcaster username.
 *
 * Usage:
 *   NEYNAR_API_KEY=<key> npx tsx scripts/backfill-snap-usernames.ts
 *
 * Uses wrangler's local D1 via the same bindings the dev server uses.
 * For production, run against the remote D1 or adapt the DB binding.
 */

const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const NEYNAR_BULK_URL = 'https://api.neynar.com/v2/farcaster/user/bulk';

// Rate limit: Neynar allows ~60 req/min on free tier
const RATE_LIMIT_MS = 1100;
const BATCH_SIZE = 50; // Neynar bulk endpoint max

interface NeynarProfile {
  username?: string;
  display_name?: string;
  pfp_url?: string;
}

interface DbUser {
  fid: number;
  fname: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchProfiles(fids: number[]): Promise<Map<number, NeynarProfile>> {
  const result = new Map<number, NeynarProfile>();
  if (!NEYNAR_API_KEY || fids.length === 0) return result;

  const params = fids.map((f) => `fids=${f}`).join('&');
  const res = await fetch(`${NEYNAR_BULK_URL}?${params}`, {
    headers: { 'x-api-key': NEYNAR_API_KEY },
  });

  if (!res.ok) {
    console.error(`  Neynar bulk fetch failed: ${res.status}`);
    return result;
  }

  const data = (await res.json()) as { users?: Array<{ fid: number } & NeynarProfile> };
  for (const u of data.users || []) {
    if (u.username) {
      result.set(u.fid, {
        username: u.username,
        display_name: u.display_name,
        pfp_url: u.pfp_url,
      });
    }
  }
  return result;
}

async function main() {
  if (!NEYNAR_API_KEY) {
    console.error('Set NEYNAR_API_KEY environment variable');
    process.exit(1);
  }

  // Dynamic import for wrangler's D1 local binding
  // For remote D1, use: wrangler d1 execute prod-qbase --remote --command "..."
  let DB: any;
  try {
    const miniflare = await import('miniflare');
    console.log('Using miniflare for local D1 access');
    // This is a placeholder — in practice you'd run this via wrangler or
    // connect to the actual D1 binding
    console.error('For production backfill, run the SQL portion via:');
    console.error('  wrangler d1 execute prod-qbase --remote --command "SELECT ... "');
    process.exit(0);
  } catch {
    // If not using miniflare, we output the SQL for manual execution
  }

  // Output the SQL to find affected users
  console.log(`\n${'='.repeat(60)}`);
  console.log('BACKFILL: Fix snap-created placeholder usernames');
  console.log(`${'='.repeat(60)}\n`);

  console.log('Step 1: Find affected users (run in D1 console):');
  console.log(`
SELECT fid, fname FROM users
WHERE fname LIKE 'user-%'
  AND CAST(SUBSTR(fname, 6) AS INTEGER) = fid
  AND fid NOT IN (${Number(process.env.ANON_FID) || 514282}, ${Number(process.env.QGENT_FID) || 975961})
ORDER BY fid;
  `);

  console.log('\nStep 2: Run this script with the FIDs from step 1:');
  console.log('  NEYNAR_API_KEY=<key> npx tsx scripts/backfill-snap-usernames.ts --fids 7143,12345,...');

  // If --fids argument provided, do the actual backfill
  const fidsArg = process.argv.find((a) => a.startsWith('--fids='));
  if (fidsArg) {
    const fids = fidsArg.split('=')[1]?.split(',').map(Number).filter(Boolean);
    if (!fids?.length) {
      console.error('No valid FIDs provided');
      process.exit(1);
    }

    console.log(`\nFetching profiles for ${fids.length} users from Neynar...`);

    // Batch into groups of BATCH_SIZE
    const allProfiles = new Map<number, NeynarProfile>();
    for (let i = 0; i < fids.length; i += BATCH_SIZE) {
      const batch = fids.slice(i, i + BATCH_SIZE);
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(fids.length / BATCH_SIZE)}: fids ${batch[0]}..${batch[batch.length - 1]}`);
      const profiles = await fetchProfiles(batch);
      for (const [fid, profile] of profiles) {
        allProfiles.set(fid, profile);
      }
      if (i + BATCH_SIZE < fids.length) await sleep(RATE_LIMIT_MS);
    }

    console.log(`\nFetched ${allProfiles.size}/${fids.length} profiles\n`);

    // Output UPDATE statements
    const updates: string[] = [];
    for (const fid of fids) {
      const profile = allProfiles.get(fid);
      if (profile?.username) {
        const fname = profile.username.replace(/'/g, "''");
        const displayName = (profile.display_name || '').replace(/'/g, "''");
        const pfpUrl = (profile.pfp_url || '').replace(/'/g, "''");
        updates.push(
          `UPDATE users SET fname = '${fname}', display_name = NULLIF('${displayName}', ''), pfp_url = NULLIF('${pfpUrl}', '') WHERE fid = ${fid} AND fname LIKE 'user-%';`,
        );
        console.log(`  ${fid}: user-${fid} → ${profile.username} (${profile.display_name || 'no display name'})`);
      } else {
        console.log(`  ${fid}: NOT FOUND on Neynar — skipping`);
      }
    }

    if (updates.length) {
      console.log(`\n${'='.repeat(60)}`);
      console.log('SQL to apply (run in D1 console):');
      console.log(`${'='.repeat(60)}\n`);
      console.log('BEGIN TRANSACTION;');
      updates.forEach((u) => console.log(u));
      console.log('COMMIT;');
      console.log(`\n${updates.length} users to update.`);
    }
  }
}

main().catch(console.error);

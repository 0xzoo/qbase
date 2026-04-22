/**
 * Register Hypersnap webhooks for qbase.
 *
 * Creates two webhook subscriptions against the Hypersnap node:
 *   1. cast_created — replies to our bot FIDs (4n0n, Q)
 *   2. cast_deleted — deletions by our bot FIDs
 *
 * Requires the FID's CUSTODY wallet — either the private key OR the
 * recovery mnemonic. The custody key signs EIP-712 typed data for
 * Hypersnap management endpoints.
 *
 * Usage (mnemonic):
 *   MNEMONIC="word1 word2 ... word12" FID=514282 npx tsx scripts/register-hypersnap-webhook.ts
 *
 * Usage (private key):
 *   CUSTODY_KEY=0x... FID=514282 npx tsx scripts/register-hypersnap-webhook.ts
 *
 * After creation, set the returned secret:
 *   wrangler secret put HYPERSNAP_WEBHOOK_SECRET
 */

import { createWalletClient, http, keccak256, toHex, hexToBytes, randomBytes, type Hex } from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { optimism } from 'viem/chains';

const HYPERSNAP_BASE = 'https://haatz.quilibrium.com';
const TARGET_URL = 'https://qbase.tech/webhooks/hypersnap';

// Bot FIDs we track
const ANON_FID = 514282;
const QGENT_FID = 975961;

// EIP-712 domain for Hypersnap
const DOMAIN = {
  name: 'Hypersnap',
  version: '1',
  chainId: 10, // Optimism
} as const;

const TYPES = {
  HypersnapSignedOp: [
    { name: 'op', type: 'string' },
    { name: 'fid', type: 'uint64' },
    { name: 'signedAt', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'requestHash', type: 'bytes32' },
  ],
} as const;

async function main() {
  const custodyKey = process.env.CUSTODY_KEY as Hex | undefined;
  const mnemonic = process.env.MNEMONIC;
  const fid = Number(process.env.FID);

  if (!custodyKey && !mnemonic) {
    console.error('Missing CUSTODY_KEY or MNEMONIC env var');
    console.error('  MNEMONIC="word1 word2 ... word12" FID=514282 npx tsx scripts/register-hypersnap-webhook.ts');
    console.error('  CUSTODY_KEY=0x... FID=514282 npx tsx scripts/register-hypersnap-webhook.ts');
    process.exit(1);
  }
  if (!fid) {
    console.error('Missing FID env var (the FID that owns the custody wallet)');
    process.exit(1);
  }

  // Derive account from mnemonic or private key
  const account = mnemonic
    ? mnemonicToAccount(mnemonic)
    : privateKeyToAccount(custodyKey!);
  console.log(`Using custody address: ${account.address} for FID ${fid}`);

  // -- List existing webhooks first --
  console.log('\nChecking existing webhooks...');
  const existing = await signedRequest('GET', '/v2/farcaster/webhook/list', fid, account);
  if (existing.webhooks?.length) {
    console.log(`Found ${existing.webhooks.length} existing webhook(s):`);
    for (const wh of existing.webhooks) {
      console.log(`  ${wh.webhook_id} — ${wh.title} → ${wh.target_url} (active: ${wh.active})`);
    }
    console.log('\nSkipping creation (webhooks already exist). Delete them first if you want to re-register.');
    console.log('To delete: MNEMONIC="..." FID=514282 DELETE_ID=<webhook_id> npx tsx scripts/register-hypersnap-webhook.ts');
    if (process.env.DELETE_ID) {
      console.log(`\nDeleting webhook ${process.env.DELETE_ID}...`);
      await signedRequest('DELETE', '/v2/farcaster/webhook/', fid, account, undefined, { webhook_id: process.env.DELETE_ID });
      console.log('Deleted.');
    }
    return;
  }

  // -- Register cast_created webhook --
  console.log('\nRegistering cast_created webhook...');
  const createBody = {
    name: 'qbase cast_created',
    url: TARGET_URL,
    description: 'Replies to qbase bot FIDs (4n0n, Q) — feeds answer reconciliation',
    subscription: {
      cast_created: {
        parent_author_fids: [ANON_FID, QGENT_FID],
      },
    },
  };

  const createResult = await signedRequest('POST', '/v2/farcaster/webhook/', fid, account, createBody);
  const createSecret = createResult.webhook?.secrets?.[0]?.value;
  console.log(`Created: ${createResult.webhook?.webhook_id}`);
  console.log(`Secret:  ${createSecret}`);

  // -- Register cast_deleted webhook --
  console.log('\nRegistering cast_deleted webhook...');
  const deleteBody = {
    name: 'qbase cast_deleted',
    url: TARGET_URL,
    description: 'Deletions by qbase bot FIDs — triggers re-anchor flow',
    subscription: {
      cast_deleted: {
        author_fids: [ANON_FID, QGENT_FID],
      },
    },
  };

  const deleteResult = await signedRequest('POST', '/v2/farcaster/webhook/', fid, account, deleteBody);
  const deleteSecret = deleteResult.webhook?.secrets?.[0]?.value;
  console.log(`Created: ${deleteResult.webhook?.webhook_id}`);
  console.log(`Secret:  ${deleteSecret}`);

  // -- Summary --
  console.log('\n--- Done ---');
  if (createSecret) {
    console.log(`\nNext step:\n  wrangler secret put HYPERSNAP_WEBHOOK_SECRET\n  # paste: ${createSecret}`);
  }
  if (deleteSecret && deleteSecret !== createSecret) {
    console.log(`\n⚠️  The cast_deleted webhook has a DIFFERENT secret. You may need to handle both.`);
    console.log(`  Or use the same secret by creating one webhook with both event types.`);
  }
}

import { type Account } from 'viem';

async function signedRequest(
  method: 'POST' | 'PUT' | 'DELETE' | 'GET',
  path: string,
  fid: number,
  account: Account,
  body?: Record<string, unknown>,
  queryParams?: Record<string, string>,
): Promise<any> {

  // Build op string from method + path
  const opMap: Record<string, string> = {
    'POST:/v2/farcaster/webhook/': 'webhook.create',
    'PUT:/v2/farcaster/webhook/': 'webhook.update',
    'DELETE:/v2/farcaster/webhook/': 'webhook.delete',
    'GET:/v2/farcaster/webhook/': 'webhook.read',
    'GET:/v2/farcaster/webhook/list': 'webhook.read',
  };
  const opKey = `${method}:${path}`;
  const op = opMap[opKey];
  if (!op) throw new Error(`Unknown op for ${opKey}`);

  // Serialize body
  const bodyStr = body ? JSON.stringify(body) : '';
  const requestHash = bodyStr
    ? keccak256(new TextEncoder().encode(bodyStr))
    : keccak256(new Uint8Array(0));

  // Nonce + timestamp
  const nonce = `0x${Buffer.from(randomBytes(32)).toString('hex')}` as Hex;
  const signedAt = BigInt(Math.floor(Date.now() / 1000));

  // Sign EIP-712
  const signature = await account.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: 'HypersnapSignedOp',
    message: {
      op,
      fid: BigInt(fid),
      signedAt,
      nonce,
      requestHash,
    },
  });

  // Build URL
  let url = `${HYPERSNAP_BASE}${path}`;
  if (queryParams) {
    const params = new URLSearchParams(queryParams);
    url += `?${params.toString()}`;
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Hypersnap-Fid': String(fid),
    'X-Hypersnap-Op': op,
    'X-Hypersnap-Signed-At': String(signedAt),
    'X-Hypersnap-Nonce': nonce,
    'X-Hypersnap-Signature': signature,
  };

  console.log(`  ${method} ${url} (op=${op})`);

  const res = await fetch(url, {
    method,
    headers,
    body: bodyStr || undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`  Error ${res.status}: ${text.slice(0, 500)}`);
    throw new Error(`Hypersnap ${res.status}: ${text.slice(0, 200)}`);
  }

  return text ? JSON.parse(text) : {};
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

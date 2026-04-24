/**
 * Create + register a Neynar signer for a Farcaster user.
 *
 * This script runs locally — the seed phrase never leaves your machine.
 * It creates a signer via Neynar, signs the EIP-712 key request with
 * the app's custody wallet, and registers it. The user then approves
 * the signer in farcaster.xyz.
 *
 * After approval, insert the signer into D1:
 *   npx wrangler d1 execute prod-qbase --remote --command="INSERT INTO user_signers (fid, signer_uuid, public_key, status) VALUES (FID, 'UUID', 'KEY', 'approved')"
 *
 * Usage (mnemonic):
 *   NEYNAR_API_KEY=xxx MNEMONIC="word1 word2 ... word12" FID=12345 npx tsx scripts/create-neynar-signer.ts
 *
 * Usage (private key):
 *   NEYNAR_API_KEY=xxx CUSTODY_KEY=0x... FID=12345 npx tsx scripts/create-neynar-signer.ts
 *
 * The script will:
 *   1. Create a new signer via Neynar API
 *   2. Look up the app's FID from the custody wallet address
 *   3. Sign an EIP-712 SignedKeyRequest with the custody wallet
 *   4. Register the signed key with Neynar
 *   5. Print the signer_approval_url for the user to approve
 *   6. Print the SQL to insert into D1 after approval
 */

import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// EIP-712 constants for Farcaster SignedKeyRequestValidator
// Contract: 0x00000000fc700472606ed4fa22623acf62c60553 (Optimism Mainnet)
// ---------------------------------------------------------------------------

const SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN = {
  name: 'Farcaster SignedKeyRequestValidator',
  version: '1',
  chainId: 10, // Optimism Mainnet
  verifyingContract: '0x00000000fc700472606ed4fa22623acf62c60553' as const,
} as const;

const SIGNED_KEY_REQUEST_TYPE = [
  { name: 'requestFid', type: 'uint256' },
  { name: 'key', type: 'bytes' },
  { name: 'deadline', type: 'uint256' },
] as const;

const DEFAULT_SIGNED_KEY_DEADLINE = 86400; // 24 hours

const NEYNAR_BASE = 'https://api.neynar.com/v2/farcaster';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = requiredEnv('NEYNAR_API_KEY');
  const targetFid = parseInt(requiredEnv('FID'), 10);

  // Resolve custody account from mnemonic or private key
  const mnemonic = process.env.MNEMONIC;
  const privateKey = process.env.CUSTODY_KEY;

  if (!mnemonic && !privateKey) {
    console.error('Error: Provide MNEMONIC or CUSTODY_KEY env var');
    process.exit(1);
  }

  const account = mnemonic
    ? mnemonicToAccount(mnemonic)
    : privateKeyToAccount(privateKey as `0x${string}`);

  console.log(`Custody address: ${account.address}`);

  // 1. Look up app's FID from custody address
  console.log('\nLooking up app FID from custody address...');
  const userRes = await neynarGet(`/user/bycustody?address=${account.address}`, apiKey);
  const appFid = userRes.user?.fid;
  if (!appFid) {
    console.error(`No Farcaster account found for custody address ${account.address}`);
    process.exit(1);
  }
  console.log(`App FID: ${appFid}`);

  // 2. Create signer
  console.log('\nCreating signer...');
  const signerRes = await neynarPost('/signer', {}, apiKey);
  const signerUuid = signerRes.signer_uuid;
  const publicKey = signerRes.public_key;
  console.log(`Signer UUID: ${signerUuid}`);
  console.log(`Public key: ${publicKey}`);

  // 3. Generate deadline
  const deadline = Math.floor(Date.now() / 1000) + DEFAULT_SIGNED_KEY_DEADLINE;

  // 4. Sign EIP-712 typed data
  console.log('\nSigning EIP-712 SignedKeyRequest...');
  const signature = await account.signTypedData({
    domain: SIGNED_KEY_REQUEST_VALIDATOR_EIP_712_DOMAIN,
    types: {
      SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE,
    },
    primaryType: 'SignedKeyRequest',
    message: {
      requestFid: BigInt(appFid),
      key: publicKey as `0x${string}`,
      deadline: BigInt(deadline),
    },
  });
  console.log(`Signature: ${signature.slice(0, 20)}...`);

  // 5. Register signed key with Neynar
  console.log('\nRegistering signed key...');
  const registerRes = await neynarPost('/signed_key', {
    signer_uuid: signerUuid,
    app_fid: appFid,
    deadline,
    signature,
  }, apiKey);

  const approvalUrl = registerRes.signer_approval_url;
  console.log(`\n✅ Signer created and registered!`);
  console.log(`\nApproval URL: ${approvalUrl}`);
  console.log(`\nAsk the user (FID ${targetFid}) to open this URL in farcaster.xyz to approve.`);

  // 6. Print D1 insert SQL
  console.log(`\n--- After approval, run this to store in D1 ---`);
  console.log(`npx wrangler d1 execute prod-qbase --remote --command="INSERT INTO user_signers (fid, signer_uuid, public_key, status) VALUES (${targetFid}, '${signerUuid}', '${publicKey}', 'pending_approval') ON CONFLICT(signer_uuid) DO UPDATE SET status = 'pending_approval', updated_at = CURRENT_TIMESTAMP"`);
  console.log(`\n--- Then poll status until approved ---`);
  console.log(`curl "https://qbase.tech/api/farcaster/signer/status?signer_uuid=${signerUuid}"`);
}

// ---------------------------------------------------------------------------
// Neynar HTTP helpers
// ---------------------------------------------------------------------------

async function neynarGet(path: string, apiKey: string): Promise<any> {
  const res = await fetch(`${NEYNAR_BASE}${path}`, {
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Neynar GET ${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function neynarPost(path: string, body: Record<string, any>, apiKey: string): Promise<any> {
  const res = await fetch(`${NEYNAR_BASE}${path}`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Neynar POST ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: ${name} env var is required`);
    process.exit(1);
  }
  return val;
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

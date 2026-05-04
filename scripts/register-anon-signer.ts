/**
 * Register a self-managed Ed25519 signer for FID 514282 (@4n0n).
 *
 * Runs locally — the custody key never leaves your machine. The script:
 *   1. Resolves the custody address from MNEMONIC or CUSTODY_KEY.
 *   2. Verifies the custody EOA actually owns FID (defaults to 514282).
 *   3. Signs an EIP-712 SignedKeyRequest authorizing the new public key.
 *   4. ABI-encodes SignedKeyRequestMetadata.
 *   5. Submits KeyGateway.add(keyType=1, key, metadataType=1, metadata)
 *      on Optimism. The same custody wallet sends the tx.
 *   6. Prints tx hash + block explorer link.
 *
 * After confirmation (~2 min on Optimism), set the matching private key
 * as the Cloudflare secret:
 *
 *   wrangler secret put ANON_SIGNER_KEY
 *
 * Usage:
 *   PUBLIC_KEY=0x... CUSTODY_KEY=0x... FID=514282 npx tsx scripts/register-anon-signer.ts
 *   PUBLIC_KEY=0x... MNEMONIC="..." FID=514282 npx tsx scripts/register-anon-signer.ts
 *
 * Env (optional):
 *   RPC_URL          custom Optimism RPC (default: https://mainnet.optimism.io)
 *   DEADLINE_HOURS   request expiry (default 24h)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbi,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { optimism } from 'viem/chains';

// ---------------------------------------------------------------------------
// Farcaster contract constants (Optimism Mainnet)
// ---------------------------------------------------------------------------

const KEY_GATEWAY = '0x00000000fc56947c7e7183f8ca4b62398caadf0b' as const;
const ID_REGISTRY = '0x00000000fc6c5f01fc30151999387bb99a9f489b' as const;

const SIGNED_KEY_REQUEST_VALIDATOR_DOMAIN = {
  name: 'Farcaster SignedKeyRequestValidator',
  version: '1',
  chainId: 10,
  verifyingContract: '0x00000000fc700472606ed4fa22623acf62c60553' as const,
} as const;

const SIGNED_KEY_REQUEST_TYPE = [
  { name: 'requestFid', type: 'uint256' },
  { name: 'key', type: 'bytes' },
  { name: 'deadline', type: 'uint256' },
] as const;

const KEY_GATEWAY_ABI = parseAbi([
  'function add(uint32 keyType, bytes calldata key, uint8 metadataType, bytes calldata metadata) external',
]);

const ID_REGISTRY_ABI = parseAbi([
  'function idOf(address owner) external view returns (uint256)',
]);

// ABI for SignedKeyRequestMetadata struct (passed as the `metadata` bytes).
const METADATA_STRUCT = [
  {
    type: 'tuple',
    components: [
      { name: 'requestFid', type: 'uint256' },
      { name: 'requestSigner', type: 'address' },
      { name: 'signature', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
] as const;

const DEFAULT_FID = 514282; // @4n0n
const DEFAULT_DEADLINE_HOURS = 24;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const publicKey = requiredEnv('PUBLIC_KEY') as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(publicKey)) {
    fatal('PUBLIC_KEY must be a 0x-prefixed 32-byte hex string (64 hex chars)');
  }

  const targetFid = BigInt(process.env.FID ?? String(DEFAULT_FID));
  const deadlineHours = Number(process.env.DEADLINE_HOURS ?? String(DEFAULT_DEADLINE_HOURS));
  const rpcUrl = process.env.RPC_URL ?? 'https://mainnet.optimism.io';

  const mnemonic = process.env.MNEMONIC;
  const custodyKey = process.env.CUSTODY_KEY;
  if (!mnemonic && !custodyKey) {
    fatal('Provide MNEMONIC or CUSTODY_KEY env var (the EOA that owns the FID).');
  }

  const account = mnemonic
    ? mnemonicToAccount(mnemonic)
    : privateKeyToAccount(custodyKey as `0x${string}`);

  console.log(`Custody address: ${account.address}`);
  console.log(`Target FID:      ${targetFid}`);
  console.log(`Public key:      ${publicKey}`);

  // -------------------------------------------------------------------------
  // 1. Verify the custody address owns the target FID
  // -------------------------------------------------------------------------
  const publicClient = createPublicClient({ chain: optimism, transport: http(rpcUrl) });

  console.log('\nVerifying custody → FID mapping on IdRegistry…');
  // viem 2.40+ tightened the readContract param types; cast around the
  // pedantic authorizationList field for this one-shot script.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ownedFid = (await (publicClient.readContract as any)({
    address: ID_REGISTRY,
    abi: ID_REGISTRY_ABI,
    functionName: 'idOf',
    args: [account.address],
  })) as bigint;

  if (ownedFid === 0n) {
    fatal(`Address ${account.address} does not own any FID. Did you supply the right custody wallet?`);
  }
  if (ownedFid !== targetFid) {
    fatal(
      `Custody mismatch: ${account.address} owns FID ${ownedFid}, not ${targetFid}. ` +
        'Either supply the correct custody, or change FID env to match.',
    );
  }
  console.log(`✅ Custody owns FID ${ownedFid}`);

  // -------------------------------------------------------------------------
  // 2. Sign EIP-712 SignedKeyRequest
  // -------------------------------------------------------------------------
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineHours * 3600);

  console.log(`\nSigning SignedKeyRequest (deadline: ${new Date(Number(deadline) * 1000).toISOString()})…`);
  const signature = await account.signTypedData({
    domain: SIGNED_KEY_REQUEST_VALIDATOR_DOMAIN,
    types: { SignedKeyRequest: SIGNED_KEY_REQUEST_TYPE },
    primaryType: 'SignedKeyRequest',
    message: {
      requestFid: targetFid,
      key: publicKey,
      deadline,
    },
  });
  console.log(`✅ Signature: ${signature.slice(0, 20)}…`);

  // -------------------------------------------------------------------------
  // 3. Encode metadata + submit KeyGateway.add()
  // -------------------------------------------------------------------------
  const metadata = encodeAbiParameters(METADATA_STRUCT, [
    {
      requestFid: targetFid,
      requestSigner: account.address,
      signature,
      deadline,
    },
  ]);

  const walletClient = createWalletClient({
    account,
    chain: optimism,
    transport: http(rpcUrl),
  });

  console.log('\nSubmitting KeyGateway.add() …');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txHash = (await (walletClient.writeContract as any)({
    address: KEY_GATEWAY,
    abi: KEY_GATEWAY_ABI,
    functionName: 'add',
    args: [1, publicKey, 1, metadata],
  })) as `0x${string}`;

  console.log(`\n✅ Tx submitted: ${txHash}`);
  console.log(`   ${`https://optimistic.etherscan.io/tx/${txHash}`}`);

  console.log('\nWaiting for confirmation (this takes ~10–30s on Optimism)…');
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success') {
    fatal(`Tx reverted. Block: ${receipt.blockNumber}. Inspect the trace on Etherscan.`);
  }

  console.log(`✅ Confirmed in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed})`);
  console.log('\nNext steps:');
  console.log('  1. Wait ~1–2 min for the hub to ingest the SIGNER_ADD event.');
  console.log(`  2. Verify: curl "https://haatz.quilibrium.com/v1/onChainSignersByFid?fid=${targetFid}" | grep ${publicKey.slice(2)}`);
  console.log('  3. Rotate the secret: wrangler secret put ANON_SIGNER_KEY');
  console.log('     (paste the matching Ed25519 PRIVATE key when prompted)');
  console.log('  4. Submit a Public text answer; tail should show [AnswerCast] Enqueued.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) fatal(`Env var ${name} is required.`);
  return val!;
}

function fatal(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

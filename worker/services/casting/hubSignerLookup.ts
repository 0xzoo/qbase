/**
 * hubSignerLookup — which Ed25519 key signs hub messages for a FID.
 *
 * Bots: wrangler secrets, one per account (the same map the queue consumer and
 * the agents use). Users: none yet — card C7 adds `user_signers` rows with
 * `provider = 'hypersnap'` and a decryptable key; until then users fall through
 * to the Neynar providers.
 *
 * Unlike `snapchainSignerLookup`, this does not require a D1 row for a bot:
 * the key is registered on-chain (scripts/register-anon-signer.ts) and the
 * hub rejects an unregistered signer with 400 "invalid signer", which the
 * routers treat as "try the next provider".
 */

export interface HubSigner {
  key: string;
  fid: number;
}

export async function hubSignerLookup(fid: number, env: any): Promise<HubSigner | null> {
  const botKeys: Record<number, string | undefined> = {
    [Number(env.ANON_FID) || 514282]: env.ANON_SIGNER_KEY,
    [Number(env.QGENT_FID) || 975961]: env.QGENT_SIGNER_KEY,
    [Number(env.POLLS_FID) || 3321680]: env.POLLS_SIGNER_KEY,
    [Number(env.QLAUDE_FID) || 1729350]: env.QLAUDE_SIGNER_KEY,
    [Number(env.QEMINI_FID) || 1729476]: env.QEMINI_SIGNER_KEY,
    [Number(env.CHATQPT_FID) || 1729438]: env.CHATQPT_SIGNER_KEY,
  };

  const key = botKeys[fid];
  if (key) return { key, fid };

  // Users: card C7 (user signers without Neynar).
  return null;
}

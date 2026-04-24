/**
 * SnapchainCastProvider — publishes casts via Snapchain hub protocol.
 *
 * Uses FarcasterHubWriter (Worker-safe protobuf + Ed25519) to build and
 * sign messages, then submits to the Snapchain hub's /v1/submitMessage.
 *
 * This is the PRIMARY write path for existing Farcaster users (Option A
 * from the tarot reading). Signers are Snapchain-native KEY_ADD/KEY_REMOVE
 * with scopes and sliding TTL — no Neynar dependency on the write path.
 *
 * Reads still go through Haatz API (free, no vendor lock-in).
 *
 * Future: when onboarding non-Farcaster users, HypersnapCastProvider
 * slots in alongside this without changing the router or route handlers.
 */

import {
  makeCastAddMessage,
  bytesToHex,
} from '../FarcasterHubWriter';
import type { CastProvider, CastPayload, CastResult } from './CastProvider';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SnapchainCastProviderOptions {
  /** Snapchain hub endpoint (e.g. https://snapchain.farcaster.xyz or a self-hosted hub) */
  hubEndpoint: string;
  /** Signer registry — maps FID → Ed25519 private key (0x hex). Keys from D1 or env. */
  signerLookup: (fid: number, env: any) => Promise<{ key: string; fid: number } | null>;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SnapchainCastProvider implements CastProvider {
  readonly name = 'snapchain';

  private hubEndpoint: string;
  private signerLookup: (fid: number, env: any) => Promise<{ key: string; fid: number } | null>;

  constructor(opts: SnapchainCastProviderOptions) {
    this.hubEndpoint = opts.hubEndpoint.replace(/\/$/, '');
    this.signerLookup = opts.signerLookup;
  }

  async canPublish(fid: number, env: any): Promise<boolean> {
    const signer = await this.signerLookup(fid, env);
    return !!signer;
  }

  async publish(payload: CastPayload, env: any): Promise<CastResult> {
    const signer = await this.signerLookup(payload.fid, env);
    if (!signer) {
      throw new Error(`No Snapchain signer registered for FID ${payload.fid}`);
    }

    // Build the protobuf message via FarcasterHubWriter (same code Hypersnap uses).
    const encoded = makeCastAddMessage(
      {
        text: payload.text,
        embeds: payload.embeds,
        parentHash: payload.parentHash,
        parentAuthorFid: payload.parentAuthorFid,
      },
      { fid: payload.fid, network: 1 },
      signer.key,
    );

    // Submit to Snapchain hub.
    const hubRes = await fetch(`${this.hubEndpoint}/v1/submitMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encoded,
    });

    if (!hubRes.ok) {
      const errBody = await hubRes.text();
      throw new Error(`Snapchain hub rejected cast: ${hubRes.status} ${errBody}`);
    }

    // Hub returns the message hash.
    const hubResult: any = await hubRes.json();
    const hash = hubResult.hash || bytesToHex(new Uint8Array(hubResult.hashBytes || []));

    return {
      hash,
      author_fid: payload.fid,
      text: payload.text,
      provider: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Default signer lookup — queries D1 for Snapchain signers
// ---------------------------------------------------------------------------

/**
 * Signer lookup that checks D1 for Snapchain-registered Ed25519 keys.
 *
 * Storage convention: in the user_signers table, Snapchain signers have
 * provider='snapchain' and public_key = Ed25519 public key hex.
 * The private key lives as a wrangler secret (for bots) or client-side
 * (for users — server never custodies user private keys).
 *
 * For bots: reads the Ed25519 private key from env vars (wrangler secrets).
 * For users: returns null (users sign client-side, server only submits).
 */
export async function snapchainSignerLookup(
  fid: number,
  env: any,
): Promise<{ key: string; fid: number } | null> {
  // Bot FIDs: private keys are wrangler secrets.
  const botKeys: Record<number, string | undefined> = {
    [Number(env.ANON_FID) || 514282]: env.ANON_SIGNER_KEY,
    [Number(env.QGENT_FID) || 975961]: env.QGENT_SIGNER_KEY,
  };

  const botKey = botKeys[fid];
  if (botKey) {
    // Check D1 for a Snapchain-registered signer for this FID.
    // The provider column (migration 0046) tells us which hub this signer is on.
    // If no Snapchain row exists, the hub will reject with 'invalid signer' —
    // that's fine, the router will fall through to the next provider.
    const row = await env.DB.prepare(
      "SELECT 1 FROM user_signers WHERE fid = ? AND status = 'approved' AND provider = 'snapchain' LIMIT 1"
    ).bind(fid).first();

    if (!row) {
      // Signer key exists in env but not registered on Snapchain hub yet.
      // Return null so the router skips to the next provider (Neynar fallback).
      console.log(`[Snapchain] FID ${fid} has signer key but no D1 row with provider='snapchain'`);
      return null;
    }

    return { key: botKey, fid };
  }

  // User FIDs: server never holds private keys.
  // User-signed messages arrive pre-signed via the client; the server
  // only submits them to the hub. This lookup returns null for users.
  return null;
}

/**
 * HypersnapCastProvider — publishes casts via Hypersnap hub protocol.
 *
 * This is the FUTURE path for onboarding users outside the Farcaster protocol.
 * It uses the same FarcasterHubWriter as SnapchainCastProvider but targets
 * the Hypersnap (Quilibrium) hub instead.
 *
 * Currently deferred — Snapchain handles existing Farcaster users.
 * Activate when you're ready to onboard non-Farcaster users with
 * Hypersnap-native FIDs.
 *
 * Reads: Haatz API (same as Snapchain — no Neynar dependency).
 */

import {
  makeCastAddMessage,
  bytesToHex,
} from '../FarcasterHubWriter';
import type { CastProvider, CastPayload, CastResult } from './CastProvider';

export class HypersnapCastProvider implements CastProvider {
  readonly name = 'hypersnap';

  private hubEndpoint: string;
  private signerLookup: (fid: number, env: any) => Promise<{ key: string; fid: number } | null>;

  constructor(opts: {
    hubEndpoint: string;
    signerLookup: (fid: number, env: any) => Promise<{ key: string; fid: number } | null>;
  }) {
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
      throw new Error(`No Hypersnap signer registered for FID ${payload.fid}`);
    }

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

    const hubRes = await fetch(`${this.hubEndpoint}/v1/submitMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encoded,
    });

    if (!hubRes.ok) {
      const errBody = await hubRes.text();
      throw new Error(`Hypersnap hub rejected cast: ${hubRes.status} ${errBody}`);
    }

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

/**
 * LoginProvider — where "sign in with Farcaster" is brokered.
 *
 * Today that is Neynar's SIWN (Sign In With Neynar): the client needs a
 * client id, and the redirect flow needs an authorization URL minted by
 * Neynar. A SIWF (Farcaster Auth Kit / relay) implementation is a later card;
 * the route handler only sees this interface.
 */

export interface LoginProvider {
  readonly name: string;
  /** Public config the client needs to start the flow. */
  clientConfig(): { client_id: string };
  /** URL to redirect the user to for the hosted flow. */
  getAuthorizationUrl(redirectUri: string): Promise<string>;
}

const NEYNAR_BASE = 'https://api.neynar.com/v2/farcaster';

export class NeynarLoginProvider implements LoginProvider {
  readonly name = 'neynar';
  private apiKey: string;
  private clientId: string;
  private fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; clientId: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.clientId = opts.clientId;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  clientConfig(): { client_id: string } {
    return { client_id: this.clientId };
  }

  async getAuthorizationUrl(redirectUri: string): Promise<string> {
    if (!this.clientId) throw new Error('NEYNAR_CLIENT_ID not configured');
    const res = await this.fetchImpl(
      `${NEYNAR_BASE}/login/authorize?client_id=${encodeURIComponent(this.clientId)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}`,
      { headers: { 'x-api-key': this.apiKey, accept: 'application/json' } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Neynar ${res.status} on /login/authorize: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { authorization_url?: string };
    if (!data.authorization_url) throw new Error('Neynar /login/authorize returned no authorization_url');
    return data.authorization_url;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initLoginProvider(env: any): LoginProvider {
  return new NeynarLoginProvider({
    apiKey: env?.NEYNAR_API_KEY ?? '',
    clientId: env?.NEYNAR_CLIENT_ID ?? '',
  });
}

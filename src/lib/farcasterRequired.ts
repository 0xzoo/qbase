/**
 * Farcaster-only actions (casting, signer connect, question likes) answer
 * 409 { error: 'farcaster_required' } for an account with no linked Farcaster
 * (account-root spec §6.1 / §6.3). Callers show FARCASTER_REQUIRED_MESSAGE
 * inline in their existing error UI.
 */
export const FARCASTER_REQUIRED_MESSAGE = 'Link Farcaster to do this';

/** True when a parsed error body + status is the farcaster_required refusal. */
export function isFarcasterRequiredBody(status: number, body: unknown): boolean {
  return status === 409
    && typeof body === 'object' && body !== null
    && (body as { error?: unknown }).error === 'farcaster_required';
}

/** Reads a cloned body, so the caller can still consume the response. */
export async function isFarcasterRequired(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  const body = await res.clone().json().catch(() => null);
  return isFarcasterRequiredBody(res.status, body);
}

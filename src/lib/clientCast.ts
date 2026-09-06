/**
 * Client-side casting helpers (signerless question flow).
 *
 * Shared by CreateQueryModal (cast on create) and QuestionSlide (cast an
 * existing question). Three concerns:
 *
 *   1. Signer status — is the user's own server-side signer available? If so
 *      the server casts as the user; if not, the user casts from their own
 *      Farcaster client (miniapp composeCast / web share-intent).
 *   2. Miniapp composeCast + anchoring the resulting hash via
 *      POST /api/queries/:id/cast-hash.
 *   3. Web share-intent (farcaster.xyz/~/compose), including the tab
 *      pre-open trick so a popup blocker doesn't eat the composer when the
 *      open happens after a multi-second await.
 */

import { sdk } from '@farcaster/miniapp-sdk';

/**
 * true = approved signer confirmed, false = confirmed none,
 * 'unknown' = could not determine (auth/network failure). Callers must treat
 * 'unknown' as "don't know", never as "no signer".
 */
export type SignerStatus = boolean | 'unknown';

/**
 * Ask the server whether the caller has an approved signer.
 * A non-OK response (401 while the token is still loading, 5xx, rate limit)
 * is 'unknown' — it must not read as "confirmed no signer".
 */
export async function fetchApprovedSignerStatus(token: string | null): Promise<SignerStatus> {
  if (!token) return 'unknown';
  try {
    const res = await fetch('/api/farcaster/signer/list', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return 'unknown';
    const data = await res.json() as { signers?: Array<{ status?: string }> };
    const signers = Array.isArray(data?.signers) ? data.signers : [];
    return signers.some((s) => s?.status === 'approved');
  } catch {
    return 'unknown';
  }
}

/**
 * Pick the cast path from a resolved signer status.
 *   - Confirmed signer → server casts as the user.
 *   - Confirmed no signer → client casts (composeCast / share-intent).
 *   - Unknown → miniapp: client (composeCast always works there);
 *               web: server (it knows the truth and has its own fallbacks;
 *               a share-intent tab for a user who does have a signer would
 *               be a silent regression).
 */
export function shouldClientCast(status: SignerStatus, isMiniApp: boolean): boolean {
  if (status === true) return false;
  if (status === false) return true;
  return isMiniApp;
}

/** Plain snap URL for a question — the client-cast embed (no compact/token gate). */
export function questionSnapUrl(questionId: string): string {
  return `${window.location.origin}/snap/question/${questionId}`;
}

/**
 * Open the user's composer inside the miniapp. Resolves with the cast hash,
 * or null when the user cancelled or the composer failed to open. Never
 * pass close:true — that resolves undefined and loses the hash.
 */
export async function composeCastInMiniApp(opts: {
  text: string;
  embedUrl: string;
  channelKey?: string;
}): Promise<string | null> {
  try {
    // No `close` option → Result is `{ cast: ... | null }` (close:true resolves
    // undefined and loses the hash). Loose cast: the SDK's conditional return
    // type doesn't narrow cleanly across versions.
    const result = (await sdk.actions.composeCast({
      text: opts.text,
      embeds: [opts.embedUrl],
      channelKey: opts.channelKey,
    })) as { cast?: { hash?: string } | null } | undefined;
    return result?.cast?.hash ?? null;
  } catch (err) {
    console.warn('[clientCast] composeCast failed:', err);
    return null;
  }
}

/**
 * Anchor a client-produced cast to its question (Phase 2 endpoint).
 * Non-critical: returns false on any failure instead of throwing.
 */
export async function anchorCastHash(
  questionId: string,
  castHash: string,
  token: string | null,
): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(`/api/queries/${questionId}/cast-hash`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ cast_hash: castHash }),
    });
    return res.ok;
  } catch (err) {
    console.warn('[clientCast] cast-hash attach failed (non-critical):', err);
    return false;
  }
}

/** farcaster.xyz compose intent with prefilled text + embed. */
export function buildComposeIntentUrl(text: string, embedUrl: string): string {
  return `https://farcaster.xyz/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(embedUrl)}`;
}

/**
 * Open a blank tab *synchronously* from a click handler and keep the handle.
 * Browsers only honor window.open within a few seconds of user activation;
 * the question-create request takes longer than that, so a tab opened after
 * it is popup-blocked (silently). Open first, navigate later.
 *
 * Deliberately no 'noopener' feature — it makes window.open return null.
 * The opener is severed by hand instead.
 */
export function preopenComposeTab(): Window | null {
  try {
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    return tab;
  } catch {
    return null;
  }
}

/**
 * Point a pre-opened tab (or a fresh one) at the compose intent. Also copies
 * "text + url" to the clipboard as a fallback for pasting into another
 * client; clipboard failures are ignored.
 */
export async function openWebComposeIntent(
  tab: Window | null,
  text: string,
  embedUrl: string,
): Promise<void> {
  const composeUrl = buildComposeIntentUrl(text, embedUrl);
  let opened = false;
  if (tab && !tab.closed) {
    try {
      tab.location.href = composeUrl;
      opened = true;
    } catch {
      /* fall through to a fresh open */
    }
  }
  if (!opened) {
    const fresh = window.open(composeUrl, '_blank', 'noopener,noreferrer');
    opened = !!fresh;
  }
  try {
    await navigator.clipboard.writeText(`${text}\n\n${embedUrl}`);
  } catch {
    /* clipboard unavailable — ignore */
  }
}

/** Close a pre-opened tab that will not be used (create failed, etc.). */
export function discardComposeTab(tab: Window | null): void {
  try {
    if (tab && !tab.closed) tab.close();
  } catch {
    /* ignore */
  }
}

/**
 * Shared SIWF nonce fetcher.
 *
 * Pass this to AuthKit's `useSignIn({ nonce })` AND to every standalone
 * `<SignInButton nonce={...} />` instance. If the `nonce` prop is
 * omitted, AuthKit's `useCreateChannel` falls through to a relay-
 * generated nonce — which our server's single-use KV check (added in
 * commit 6152c65) won't recognize, breaking SIWF entirely.
 */
export async function fetchAuthNonce(): Promise<string> {
  console.log('[AUTH] 🔄 Nonce callback invoked - fetching from server...');
  const response = await fetch('/api/auth/nonce');
  if (!response.ok) {
    const text = await response.text();
    console.error('[AUTH] Nonce fetch failed:', text);
    throw new Error(`Nonce fetch failed: ${response.status}`);
  }
  const data = await response.json() as { nonce: string };
  console.log('[AUTH] ✅ Received nonce from server:', data.nonce.substring(0, 8));
  return data.nonce;
}

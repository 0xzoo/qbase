/**
 * snapCompat — parseRequest with a compatibility shim for legacy/Frames-style
 * snap POST payloads.
 *
 * Clients like Quorum POST a legacy Frames-style payload (top-level `fid` +
 * `button_index`, empty `inputs`, no `user`/`audience`/`surface`) that the
 * current `@farcaster/snap` schema rejects, so `parseRequest` 400s and the snap
 * can't advance. The JFS signature is still valid, so on a failed POST parse we
 * rebuild a minimal POST action from the *verified* envelope: the fid comes from
 * the signed JFS header (verified against the Farcaster hub, then the Quil hub)
 * — never from unsigned input.
 *
 * Forced-choice answers ride on the `?choice=` URL param, so they work as-is;
 * slider/text answers depend on the client populating `inputs` (logged on the
 * compat path so we can confirm which clients do).
 */

import { parseRequest, parseJfs, decodePayload, verifyJFS } from '@farcaster/snap/server';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

type ParsedRequest = Awaited<ReturnType<typeof parseRequest>>;
type SnapAction = Extract<ParsedRequest, { success: true }>['action'];

/**
 * Drop-in replacement for `parseRequest(request, { skipJFSVerification })` that
 * additionally accepts legacy snap POST payloads via the compat shim above.
 */
export async function parseSnapRequestCompat(request: Request, env: Env): Promise<ParsedRequest> {
  // Capture the body before parseRequest consumes it (POST only).
  const rawBody = request.method === 'POST'
    ? await request.clone().text().catch(() => null)
    : null;

  const parsed = await parseRequest(request, {
    skipJFSVerification: env.SNAP_SKIP_JFS === '1',
  });
  if (parsed.success || !rawBody) return parsed;

  const action = await compatParsePostAction(rawBody, env);
  if (action) return { success: true, action };
  return parsed;
}

async function compatParsePostAction(rawBody: string, env: Env): Promise<SnapAction | null> {
  const parsed = parseJfs(rawBody);
  if (!parsed.ok) return null;
  const jfs = parsed.jfs;

  let fid: number | null = null;
  if (env.SNAP_SKIP_JFS === '1') {
    // Local dev only — trust the claimed fid without hub verification.
    try {
      const p = decodePayload(jfs.payload) as { fid?: number; user?: { fid?: number } };
      fid = p.user?.fid ?? p.fid ?? null;
    } catch { /* ignore */ }
  } else {
    // Verify the signature and take the fid from the signed header. Try the
    // default Farcaster hub first, then the Quil hub (Quorum signers may only
    // be registered there).
    const hubs: (string | undefined)[] = [undefined];
    if (env.HUB_ENDPOINT) hubs.push(env.HUB_ENDPOINT as string);
    for (const hub of hubs) {
      try {
        const v = await verifyJFS(jfs, hub ? { hubHttpBaseUrl: hub } : {});
        if (v.valid) { fid = (v as { signingUserFid: number }).signingUserFid; break; }
      } catch { /* try next hub */ }
    }
  }
  if (fid == null) return null;

  let inputs: Record<string, unknown> = {};
  let timestamp = Math.floor(Date.now() / 1000);
  try {
    const p = decodePayload(jfs.payload) as { inputs?: Record<string, unknown>; timestamp?: number };
    if (p.inputs && typeof p.inputs === 'object') inputs = p.inputs;
    if (typeof p.timestamp === 'number') timestamp = p.timestamp;
  } catch { /* ignore */ }

  console.log('[snap-compat] accepted legacy snap POST payload', 'fid=', fid, 'inputs=', JSON.stringify(inputs));
  return {
    type: 'post',
    user: { fid },
    inputs: inputs as Record<string, string | number | boolean | string[]>,
    timestamp,
    audience: 'public',
    surface: { type: 'standalone' },
  } as SnapAction;
}

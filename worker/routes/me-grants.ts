/**
 * Owner surface for grants (docs/specs/consent-model.md §4, personal-mcp.md §3.4):
 * the /me/access page.
 *
 *   GET    /api/me/grants        → { grants: GrantSummary[], reach, recent, copy }   each grant with read totals + the last
 *                                  20 reads; reach = what all live grants allow together, recent = reads across all of
 *                                  them in the last 30 days (consent-model.md §4, decision 10)
 *   POST   /api/me/grants        { label?, ceiling?, disclosure?, domains?, purpose?, expires_at? }
 *                                → { grant, key }   the key is shown once and never stored
 *   DELETE /api/me/grants/:id    → { revoked: true }   forward-only
 *
 * Signed-in owner only (session / Quick Auth). An agent key can't reach
 * these: requireFlexibleAuth doesn't accept one, so an agent can't mint or
 * widen its own grant.
 */

import { requireFlexibleAuth } from '../middleware/auth';
import {
  GrantError, KEY_COPY_ID, combinedReach, createKeyGrant, listGrants, recentReads, revokeGrant, type KeyGrantInput,
} from '../services/personal/GrantService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

export async function handleMeGrantsRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/api\/me\/grants(?:\/([^/]+))?$/);
  if (!m) return null;

  const auth = await requireFlexibleAuth(request, env);
  if (!auth.authenticated || auth.userKey === undefined) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }
  const owner = auth.userKey;

  try {
    if (!m[1] && request.method === 'GET') {
      const copy = await env.DB.prepare('SELECT id, text FROM consent_copy WHERE id = ?').bind(KEY_COPY_ID).first();
      const now = Date.now();
      const grants = await listGrants(env, owner);
      return Response.json({ grants, reach: combinedReach(grants, now), recent: await recentReads(env, owner, now), copy });
    }
    if (!m[1] && request.method === 'POST') {
      let body: KeyGrantInput;
      try {
        body = await request.json() as KeyGrantInput;
      } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
      }
      const { grant, secret } = await createKeyGrant(env, owner, body ?? {});
      return Response.json({ grant, key: secret }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    }
    if (m[1] && request.method === 'DELETE') {
      const revoked = await revokeGrant(env, owner, decodeURIComponent(m[1]));
      return revoked ? Response.json({ revoked: true }) : Response.json({ error: 'Not found' }, { status: 404 });
    }
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (e) {
    if (e instanceof GrantError) return Response.json({ error: e.message, code: e.code }, { status: 400 });
    console.error('[me-grants] failed:', e);
    return Response.json({ error: 'Failed' }, { status: 500 });
  }
}

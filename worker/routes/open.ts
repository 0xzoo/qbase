/**
 * Open data release (DATA.md, worker/services/OpenDataService.ts). Public,
 * no auth, CC BY 4.0.
 *
 *   GET /api/open/items?after=<id>&limit=<n>  → { license, floor, items, next }   releasable questions by id
 *   GET /api/open/items/:id.json              → OpenItem                          one question, floored, with provenance
 *   GET /api/open/items/:id.csv               → long-format CSV of the same
 */

import { RateLimitService } from '../services/RateLimitService';
import { getOpenItem, listOpenItems, openItemCsv, OPEN_FLOOR, OPEN_LICENSE } from '../services/OpenDataService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const LICENSE_LINK = `<${OPEN_LICENSE.url}>; rel="license"`;

export async function handleOpenRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/open/') || request.method !== 'GET') return null;

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, 60, 60, 'open');
  if (!allowed) return new Response('Too Many Requests', { status: 429 });

  try {
    if (url.pathname === '/api/open/items') {
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const page = await listOpenItems(env.DB, url.origin, {
        after: url.searchParams.get('after'),
        limit: Number.isFinite(limit) ? limit : 100,
      });
      return Response.json({ license: OPEN_LICENSE, floor: OPEN_FLOOR, ...page }, {
        headers: { 'Cache-Control': 'public, max-age=600', Link: LICENSE_LINK },
      });
    }

    const m = url.pathname.match(/^\/api\/open\/items\/([a-zA-Z0-9_-]+)\.(json|csv)$/);
    if (!m) return null;
    const item = await getOpenItem(env.DB, m[1], url.origin);
    if (!item) return Response.json({ error: 'not_released' }, { status: 404 });
    if (m[2] === 'csv') {
      return new Response(openItemCsv(item), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="qbase-${item.question.id}-${item.generated_at.slice(0, 10)}.csv"`,
          'Cache-Control': 'public, max-age=600',
          Link: LICENSE_LINK,
        },
      });
    }
    return Response.json(item, { headers: { 'Cache-Control': 'public, max-age=600', Link: LICENSE_LINK } });
  } catch (error) {
    console.error('[Open Data] Error:', error);
    return Response.json({ error: 'Failed to build the release' }, { status: 500 });
  }
}

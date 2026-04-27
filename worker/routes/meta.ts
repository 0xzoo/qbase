/**
 * Meta Tag Injection Routes
 * 
 * Handles meta tag injection for social sharing on:
 * - /quiz/* - Quiz pages
 * - /ask/* - Ask pages
 * - /question/* - Question pages — content negotiation: snap JSON if Accept requests it, else fc:miniapp HTML
 * - /questions - Questions listing page
 * - /about - About page
 */

import { MetaService } from '../services/MetaService';
import { handleSnapRoutes } from './snap';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

const SNAP_ACCEPT = 'application/vnd.farcaster.snap+json';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Max-Age': '86400',
};

/**
 * Handle meta tag injection routes
 * Returns modified HTML with injected meta tags, or null if path doesn't match
 */
export async function handleMetaRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // Check if this is a meta tag injection route
  if (!url.pathname.startsWith('/quiz/') &&
      !url.pathname.startsWith('/ask/') &&
      !url.pathname.startsWith('/question/') &&
      url.pathname !== '/questions' &&
      url.pathname !== '/about' &&
      url.pathname !== '/create-poll') {
    return null;
  }

  try {
    // Manually construct the index.html request
    const indexUrl = new URL('/index.html', url.origin);
    const indexRequest = new Request(indexUrl.toString(), {
      method: 'GET',
      headers: request.headers
    });

    const indexResponse = await env.ASSETS.fetch(indexRequest);

    if (!indexResponse.ok) {
      // If index.html fetch fails, fall back to default handling
      return indexResponse;
    }

    const html = await indexResponse.text();
    let metaTags = '';

    if (url.pathname.startsWith('/quiz/')) {
      const id = url.pathname.split('/')[2];
      if (id) {
        const imageUrl = `${url.origin}/api/og/quiz/${id}`;
        const actionUrl = `${url.origin}/quiz/${id}`;
        metaTags = MetaService.generateMiniAppTag(imageUrl, "Take Quiz", actionUrl);
      }
    } else if (url.pathname.startsWith('/ask/')) {
      const username = url.pathname.split('/')[2];
      if (username) {
        const imageUrl = `${url.origin}/api/og/ask/${username}`;
        const actionUrl = `${url.origin}/ask/${username}`;
        metaTags = MetaService.generateMiniAppTag(imageUrl, "ask", actionUrl);
      }
    } else if (url.pathname.startsWith('/question/')) {
      const id = url.pathname.split('/')[2];
      if (id) {
        // ── Content negotiation: serve snap JSON if requested ──
        const accept = request.headers.get('Accept') || '';
        if (accept.includes(SNAP_ACCEPT)) {
          // Rewrite URL to /snap/question/:id and delegate to snap handler
          const snapUrl = new URL(`/snap/question/${id}`, url.origin);
          const snapReq = new Request(snapUrl.toString(), {
            method: request.method,
            headers: request.headers,
          });
          const snapRes = await handleSnapRoutes(snapReq, env);
          if (snapRes) {
            // Add CORS headers (snap handler adds its own, but ensure they're present)
            const headers = new Headers(snapRes.headers);
            for (const [k, v] of Object.entries(CORS_HEADERS)) {
              if (!headers.has(k)) headers.set(k, v);
            }
            return new Response(snapRes.body, {
              status: snapRes.status,
              headers,
            });
          }
          // Snap handler returned null (no match) — fall through to HTML
        }

        // ── HTML response with fc:miniapp meta tag ──
        const imageUrl = `${url.origin}/api/og/question/${id}`;
        const actionUrl = `${url.origin}/question/${id}`;
        metaTags = MetaService.generateMiniAppTag(imageUrl, "🗣️", actionUrl);
      }
    } else if (url.pathname === '/questions') {
      const imageUrl = `${url.origin}/questions.png`;
      const actionUrl = `${url.origin}/questions`;
      metaTags = MetaService.generateMiniAppTag(imageUrl, "🔍", actionUrl);
    } else if (url.pathname === '/about') {
      const imageUrl = `${url.origin}/questions.png`;
      const actionUrl = `${url.origin}/about`;
      metaTags = MetaService.generateMiniAppTag(imageUrl, "learn more", actionUrl);
    } else if (url.pathname === '/create-poll') {
      const imageUrl = `${url.origin}/questions.png`;
      const actionUrl = `${url.origin}/create-poll`;
      metaTags = MetaService.generateMiniAppTag(imageUrl, "📊 Create Poll", actionUrl);
    }

    const modifiedHtml = MetaService.injectTags(html, metaTags);

    // Longer cache for static pages (1 day), shorter for dynamic pages (10 minutes)
    const isStaticPage = url.pathname === '/questions' || url.pathname === '/about';
    const maxAge = isStaticPage ? 86400 : 600; // 1 day vs 10 minutes

    return new Response(modifiedHtml, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': `public, max-age=${maxAge}, must-revalidate`,
        ...CORS_HEADERS,
      },
      status: indexResponse.status
    });
  } catch (e) {
    console.error('Meta Tag Injection Error:', e);
    // Fall back to ASSETS on error
    return env.ASSETS.fetch(request);
  }
}

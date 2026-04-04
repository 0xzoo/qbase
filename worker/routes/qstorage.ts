/**
 * QStorage API Routes
 * 
 * Handles:
 * - PUT /api/qstorage/:key* - Store encrypted blob
 * - GET /api/qstorage/:key* - Retrieve encrypted blob
 * - DELETE /api/qstorage/:key* - Delete object
 */

import { QStorageService } from '../services/QStorageService';
import { requireFlexibleAuth } from '../middleware/auth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

/**
 * Handle qstorage-related API routes
 */
export async function handleQStorageRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // PUT /api/qstorage/:key* - Store an encrypted blob
  if (pathname.startsWith("/api/qstorage/") && request.method === "PUT") {
    try {
      const auth = requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }

      const key = pathname.replace('/api/qstorage/', '');
      if (!key) {
        return Response.json({ error: 'Object key required' }, { status: 400 });
      }

      const body = await request.arrayBuffer();
      if (!body || body.byteLength === 0) {
        return Response.json({ error: 'Request body required' }, { status: 400 });
      }

      // Size limit: 5MB per object
      if (body.byteLength > 5 * 1024 * 1024) {
        return Response.json({ error: 'Object too large (max 5MB)' }, { status: 413 });
      }

      // Extract metadata from x-qbase-meta-* headers
      const metadata: Record<string, string> = {};
      for (const [k, v] of request.headers.entries()) {
        if (k.startsWith('x-qbase-meta-')) {
          metadata[k.replace('x-qbase-meta-', '')] = v;
        }
      }

      const qstorage = QStorageService.fromEnv(env);
      const result = await qstorage.put(
        key,
        body,
        Object.keys(metadata).length > 0 ? metadata : undefined,
        request.headers.get('content-type') || 'application/octet-stream'
      );

      return Response.json(result);
    } catch (e) {
      console.error('[QStorage] PUT error:', e);
      return Response.json(
        { error: 'Failed to store object', detail: String(e) },
        { status: 500 }
      );
    }
  }

  // GET /api/qstorage/:key* - Retrieve an encrypted blob
  if (pathname.startsWith("/api/qstorage/") && request.method === "GET") {
    try {
      const auth = requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }

      const key = pathname.replace('/api/qstorage/', '');
      if (!key) {
        return Response.json({ error: 'Object key required' }, { status: 400 });
      }

      const qstorage = QStorageService.fromEnv(env);
      const result = await qstorage.get(key);

      if (!result) {
        return Response.json({ error: 'Object not found' }, { status: 404 });
      }

      // Return the raw encrypted blob with metadata in headers
      const headers = new Headers({
        'Content-Type': result.contentType || 'application/octet-stream',
      });
      if (result.metadata) {
        for (const [k, v] of Object.entries(result.metadata)) {
          headers.set(`x-qbase-meta-${k}`, v);
        }
      }

      return new Response(result.data, { headers });
    } catch (e) {
      console.error('[QStorage] GET error:', e);
      return Response.json(
        { error: 'Failed to retrieve object', detail: String(e) },
        { status: 500 }
      );
    }
  }

  // DELETE /api/qstorage/:key* - Delete an object
  if (pathname.startsWith("/api/qstorage/") && request.method === "DELETE") {
    try {
      const auth = requireFlexibleAuth(request, env);
      if (!auth.authenticated) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }

      const key = pathname.replace('/api/qstorage/', '');
      if (!key) {
        return Response.json({ error: 'Object key required' }, { status: 400 });
      }

      const qstorage = QStorageService.fromEnv(env);
      const success = await qstorage.delete(key);

      return Response.json({ success });
    } catch (e) {
      console.error('[QStorage] DELETE error:', e);
      return Response.json(
        { error: 'Failed to delete object', detail: String(e) },
        { status: 500 }
      );
    }
  }

  return null;
}

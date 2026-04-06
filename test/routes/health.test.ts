/**
 * Integration tests: Worker fetch handler
 * 
 * These tests exercise the full worker fetch handler — routing, middleware,
 * response shaping — by making HTTP requests via SELF.fetch().
 * 
 * SELF is a Fetcher binding to the worker's default export, provided by
 * the @cloudflare/vitest-pool-workers test environment.
 * 
 * What we test here:
 * - Unknown API routes return a structured 404 JSON response
 * - Authenticated routes reject unauthenticated requests with 401
 * - The root path returns a Response (either HTML from ASSETS or a 404)
 * 
 * The worker runs in the same isolate as the tests, so all bindings
 * (D1, KV, R2, Durable Objects, Vectorize) are available and isolated
 * per-test via the Workers pool.
 */

import { describe, it, expect } from 'vitest';
// Import the worker instance from the same isolate
// This is the same module instance used internally by the pool
import worker from '../../worker/index';

// Access the worker's env from the pool (all bindings auto-provided)
import { env } from 'cloudflare:workers';

describe('Worker Fetch Handler', () => {
  describe('Health / Root path', () => {
    it('returns a Response for the root path (ASSETS or 404)', async () => {
      const request = new Request('http://localhost/');
      const ctx = new ExecutionContext();
      
      const response = await worker.default.fetch(request, env, ctx);
      
      // We expect either 200 (index.html served) or 404 — not 500
      expect(response.status).toBeLessThan(500);
    });
  });

  describe('API 404 handling', () => {
    it('returns 404 JSON for an unknown /api/* route', async () => {
      const request = new Request('http://localhost/api/this-does-not-exist', {
        method: 'GET',
      });
      const ctx = new ExecutionContext();
      
      const response = await worker.default.fetch(request, env, ctx);
      
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toHaveProperty('error');
    });

    it('returns 404 for unknown webhook routes', async () => {
      const request = new Request('http://localhost/webhooks/unknown-event', {
        method: 'POST',
      });
      const ctx = new ExecutionContext();
      
      const response = await worker.default.fetch(request, env, ctx);
      
      expect(response.status).toBe(404);
    });
  });

  describe('Auth protection on /api/points', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const request = new Request('http://localhost/api/points', {
        method: 'GET',
        headers: {
          // Intentionally no Authorization header
          'CF-Connecting-IP': '127.0.0.1',
        },
      });
      const ctx = new ExecutionContext();
      
      const response = await worker.default.fetch(request, env, ctx);
      
      // Auth middleware should reject without credentials
      expect(response.status).toBe(401);
    });

    it('returns 401 when a malformed Authorization header is provided', async () => {
      const request = new Request('http://localhost/api/points', {
        method: 'GET',
        headers: {
          'Authorization': 'NotBearer token',
          'CF-Connecting-IP': '127.0.0.1',
        },
      });
      const ctx = new ExecutionContext();
      
      const response = await worker.default.fetch(request, env, ctx);
      
      expect(response.status).toBe(401);
    });
  });

  describe('Worker bindings are available', () => {
    it('env.DB is a D1Database binding', () => {
      // Verify the D1 binding is present and has expected methods
      expect(env.DB).toBeDefined();
      expect(typeof env.DB.prepare).toBe('function');
      expect(typeof env.DB.exec).toBe('function');
      expect(typeof env.DB.all).toBe('function');
    });

    it('env.KV_USER_POINTS is a KVNamespace binding', () => {
      expect(env.KV_USER_POINTS).toBeDefined();
      expect(typeof env.KV_USER_POINTS.get).toBe('function');
      expect(typeof env.KV_USER_POINTS.put).toBe('function');
      expect(typeof env.KV_USER_POINTS.delete).toBe('function');
    });

    it('env.R2 is an R2Bucket binding', () => {
      expect(env.R2).toBeDefined();
      expect(typeof env.R2.get()).toBe('function'); // R2 list() returns a handler
    });

    it('env.QINDEX is a VectorizeIndex binding', () => {
      expect(env.QINDEX).toBeDefined();
      expect(typeof env.QINDEX.query).toBe('function');
    });

    it('env.AI is an Ai binding', () => {
      expect(env.AI).toBeDefined();
    });

    it('env.QGENT is a Durable Object namespace binding', () => {
      expect(env.QGENT).toBeDefined();
      expect(typeof env.QGENT.get).toBe('function');
      expect(typeof env.QGENT.idFromName).toBe('function');
    });
  });
});

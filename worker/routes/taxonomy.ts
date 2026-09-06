/**
 * Taxonomy Classification Test Routes (dev-only; isDevDomain)
 *
 * - POST /api/test/taxonomy-classification/single  { stem, options?, classifier? }
 * - POST /api/test/taxonomy-classification          { classifier? }  → runs the canonical test set
 *
 * `classifier` is 'haiku' | 'legacy' | 'auto' (default auto). The test set
 * lives in worker/services/taxonomy/testSet.ts and is shared with
 * scripts/taxonomy-gate.ts so the gate and this route agree.
 */

import { AIService, type ClassifierChoice } from '../services/AIService';
import { RateLimitService } from '../services/RateLimitService';
import { TAXONOMY_TEST_SET, checkTaxonomy } from '../services/taxonomy/testSet';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Env = any;

function isDevDomain(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === 'qbase-dev.z00.workers.dev' || hostname === 'localhost';
}

function parseChoice(v: unknown): ClassifierChoice {
  return v === 'haiku' || v === 'legacy' ? v : 'auto';
}

export async function handleTaxonomyRoutes(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === '/api/test/taxonomy-classification/single' && request.method === 'POST') {
    if (!isDevDomain(request)) return new Response('Not Found', { status: 404 });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, 30, 60, 'test:taxonomy-single');
    if (!allowed) return new Response('Too Many Requests', { status: 429 });

    try {
      const body = (await request.json()) as { stem?: string; options?: string[]; classifier?: string };
      if (!body.stem) return Response.json({ error: 'stem is required' }, { status: 400 });

      const aiService = AIService.fromEnv(env);
      const startTime = Date.now();
      const result = await aiService.classifyQuestion(body.stem, body.options, parseChoice(body.classifier));
      const latencyMs = Date.now() - startTime;

      return Response.json({
        result,
        latency: { ms: latencyMs, seconds: (latencyMs / 1000).toFixed(2) },
      });
    } catch (error) {
      console.error('Error classifying single question:', error);
      return Response.json({ error: 'Failed to classify question', details: String(error) }, { status: 500 });
    }
  }

  if (pathname === '/api/test/taxonomy-classification' && request.method === 'POST') {
    if (!isDevDomain(request)) return new Response('Not Found', { status: 404 });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await RateLimitService.fromEnv(env).checkLimit(ip, 20, 60, 'test:taxonomy');
    if (!allowed) return new Response('Too Many Requests', { status: 429 });

    try {
      const body = (await request.json().catch(() => ({}))) as { classifier?: string };
      const choice = parseChoice(body.classifier);
      const aiService = AIService.fromEnv(env);
      const results = [];

      for (const testCase of TAXONOMY_TEST_SET) {
        const startTime = Date.now();
        try {
          const result = await aiService.classifyQuestion(testCase.stem, testCase.options, choice);
          const errors = checkTaxonomy(result, testCase.expected);
          results.push({
            name: testCase.name,
            stem: testCase.stem,
            options: testCase.options,
            result,
            expected: testCase.expected,
            passed: errors.length === 0,
            errors,
            latencyMs: Date.now() - startTime,
          });
        } catch (error) {
          results.push({
            name: testCase.name,
            stem: testCase.stem,
            options: testCase.options,
            expected: testCase.expected,
            passed: false,
            errors: [String(error)],
            latencyMs: Date.now() - startTime,
          });
        }
      }

      const passed = results.filter((r) => r.passed).length;
      const failed = results.length - passed;
      const meanLatencyMs = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / Math.max(1, results.length));

      return Response.json({
        summary: {
          classifier: choice,
          total: results.length,
          passed,
          failed,
          passRate: ((passed / results.length) * 100).toFixed(1),
          meanLatencyMs,
        },
        results,
      });
    } catch (error) {
      console.error('Error running taxonomy classification tests:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  return null;
}

/**
 * Vitest configuration for Cloudflare Workers testing.
 *
 * Uses @cloudflare/vitest-pool-workers v0.14 with vitest v4. The pool's
 * factory function `cloudflarePool` returns a `PoolRunnerInitializer`
 * that vitest 4 accepts directly as `test.pool`. Earlier versions of the
 * pool used a `pool: '@cloudflare/vitest-pool-workers'` string; that no
 * longer works on vitest 4.
 *
 * Bindings (D1, KV, R2, Vectorize, AI, QGENT DO) are read from
 * wrangler.jsonc and provided to tests via `import { env } from
 * 'cloudflare:workers'`.
 */
import { defineConfig } from 'vitest/config';
import { cloudflarePool } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    pool: cloudflarePool({
      // `main` tells the pool to run the worker in the same isolate as
      // the test files. Without this, `import { SELF } from
      // 'cloudflare:test'` fails — SELF is only injected when the pool
      // knows the worker entrypoint.
      main: './worker/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      // Pool defaults remoteBindings to true, which triggers a remote proxy
      // session against the prod D1/KV/R2 IDs in wrangler.jsonc and
      // requires `wrangler login` just to run tests. Force everything
      // through miniflare's local bindings instead.
      remoteBindings: false,
    }),
    timeout: 30_000,
  },
});

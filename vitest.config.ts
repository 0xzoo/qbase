/**
 * Vitest configuration for Cloudflare Workers testing.
 *
 * Uses @cloudflare/vitest-pool-workers v0.14 with vitest v4. The pool
 * exposes two entry points:
 *
 *  - `cloudflarePool(opts)` — returns a `PoolRunnerInitializer` only.
 *  - `cloudflareTest(opts)` — returns a Vite plugin that registers the
 *    pool runner *and* resolves the virtual `cloudflare:test` module.
 *
 * Without the plugin, `import { SELF, env } from 'cloudflare:test'` in
 * integration tests fails with "Cannot find package 'cloudflare:test'"
 * because nothing aliases the virtual module ID. So we use the plugin.
 *
 * Bindings (D1, KV, R2, Vectorize, AI, QGENT DO) are read from
 * wrangler.jsonc and exposed via `cloudflare:test`.
 */
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './worker/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      // Pool defaults remoteBindings to true, which triggers a remote proxy
      // session against the prod D1/KV/R2 IDs in wrangler.jsonc and
      // requires `wrangler login` just to run tests. Force everything
      // through miniflare's local bindings instead.
      remoteBindings: false,
    }),
  ],
  test: {
    timeout: 30_000,
  },
});

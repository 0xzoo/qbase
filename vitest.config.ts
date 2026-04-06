/**
 * Vitest configuration for Cloudflare Workers testing
 * 
 * This config uses @cloudflare/vitest-pool-workers to simulate the Workers runtime
 * with full support for D1, KV, R2, Durable Objects, and Vectorize bindings.
 * 
 * The pool reads bindings from wrangler.jsonc automatically.
 * Individual tests can override or customize bindings via the envBootstrap option.
 */
import { defineConfig } from 'vitest/config';
import cloudflare from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    // Workers pool plugin - provides D1, KV, R2, DO, Vectorize simulation
    cloudflare({
      // Optional: Path to wrangler config (defaults to wrangler.jsonc / wrangler.toml)
      // wrangler.configPath: './wrangler.jsonc',
      
      // Optional: Custom environment variable bootstrapping per test
      // envBootstrap: {
      //   MY_VAR: 'default-value',
      // },
    }),
  ],
  
  test: {
    // Use the Workers pool for all test files
    pool: '@cloudflare/vitest-pool-workers',
    
    // Pool-specific options
    poolOptions: {
      // Workers pool options
      workers: {
        // Specify which wrangler config to use for bindings
        wrangler: { configPath: './wrangler.jsonc' },
        
        // Optional: Override bindings per test via test environment
        // See: https://github.com/cloudflare/vitest-pool-workers#environment-variables
      },
    },
    
    // Global test timeout (30s is usually enough for Workers tests)
    timeout: 30_000,
    
    // Enable watch mode for development
    watch: true,
  },
  
  // TypeScript configuration for tests
  resolve: {
    alias: {
      // Keep the same buffer alias as vite.config.ts
      buffer: require.resolve('buffer/index.js'),
    },
  },
});

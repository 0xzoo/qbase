import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
  ],
  resolve: {
    alias: {
      // Prevent Vite from externalizing 'buffer' - use the npm package instead
      buffer: path.resolve(__dirname, 'node_modules/buffer/index.js'),
    },
  },
  optimizeDeps: {
    exclude: [
      '@cf-wasm/resvg',
      '@resvg/resvg-wasm',
      'yoga-wasm-web',
    ],
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy vendor deps into their own chunks so they cache across
        // route navigations and don't bloat per-route bundles. Buckets are
        // named by the consumer cluster, not by transitive deps, so a single
        // viem update only invalidates the viem chunk (not, say, framer).
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-react-query': ['@tanstack/react-query', '@tanstack/react-query-devtools'],
          'vendor-framer': ['framer-motion'],
          'vendor-recharts': ['recharts'],
          'vendor-viem': ['viem'],
          'vendor-wagmi': ['wagmi'],
          'vendor-flaunch': ['@flaunch/sdk'],
          'vendor-farcaster': [
            '@farcaster/auth-client',
            '@farcaster/auth-kit',
            '@farcaster/frame-sdk',
            '@farcaster/miniapp-sdk',
            '@farcaster/miniapp-wagmi-connector',
            '@farcaster/quick-auth',
            '@farcaster/snap',
          ],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { cloudflare } from "@cloudflare/vite-plugin";
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
    // Node polyfills for Nillion SDK browser compatibility
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'util', 'process'],
      globals: {
        Buffer: true,
        process: true,
      },
    }),
  ],
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: [
      '@cf-wasm/resvg',
      '@resvg/resvg-wasm',
      'yoga-wasm-web',
      '@nillion/nuc',
      '@nillion/secretvaults',
    ],
  },
  worker: {
    format: 'es',
  },
})

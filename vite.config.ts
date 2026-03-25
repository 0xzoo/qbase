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
  worker: {
    format: 'es',
  },
})

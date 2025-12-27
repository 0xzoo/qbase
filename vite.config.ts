import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: [
      '@resvg/resvg-wasm',
      'yoga-wasm-web',
      '@nillion/nuc',
      '@nillion/secretvaults'
    ],
  },
  worker: {
    format: 'es',
  },
})
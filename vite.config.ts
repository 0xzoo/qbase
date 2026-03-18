import path from 'path'
import fs from 'fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { cloudflare } from "@cloudflare/vite-plugin";

// Serves channelwasm_bg.wasm from any path - the Quil SDK's pre-bundled
// code tries to fetch it relative to import.meta.url which changes based
// on Vite's dep optimization output location.
function quilWasmPlugin(): Plugin {
  const wasmFileName = 'channelwasm_bg.wasm';
  return {
    name: 'quil-wasm-serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.endsWith(wasmFileName)) {
          const wasmPath = path.resolve(__dirname, 'public', wasmFileName);
          if (fs.existsSync(wasmPath)) {
            res.setHeader('Content-Type', 'application/wasm');
            fs.createReadStream(wasmPath).pipe(res);
            return;
          }
        }
        next();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    quilWasmPlugin(),
    react(),
    cloudflare(),
  ],
  resolve: {
    alias: {
      // The Quil SDK imports 'crypto' (Node builtin) - shim it for browser
      crypto: path.resolve(__dirname, 'src/crypto-shim.ts'),
      // Prevent Vite from externalizing 'buffer' - use the npm package instead
      buffer: path.resolve(__dirname, 'node_modules/buffer/index.js'),
    },
  },
  assetsInclude: ['**/*.wasm'],
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

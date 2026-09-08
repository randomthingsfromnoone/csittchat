import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// GenosDB dynamically imports GenosRTC relative to import.meta.url. Keep the
// published files together, hosted by us, instead of rewriting vendor internals.
function genosAssets(): Plugin {
  const assets = ['index.js', 'genosrtc.min.js'];
  const root = resolve('node_modules/genosdb');
  return {
    name: 'local-genosdb',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = req.url?.split('?')[0]?.match(/^\/vendor\/genosdb\/([^/]+)$/)?.[1];
        if (!name || !assets.includes(name)) return next();
        res.setHeader('Content-Type', 'text/javascript');
        res.end(readFileSync(resolve(root, 'dist', name)));
      });
    },
    generateBundle() {
      for (const name of assets) this.emitFile({ type: 'asset', fileName: `vendor/genosdb/${name}`, source: readFileSync(resolve(root, 'dist', name)) });
      this.emitFile({ type: 'asset', fileName: 'vendor/genosdb/LICENSE', source: readFileSync(resolve(root, 'LICENSE')) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [genosAssets()],
  optimizeDeps: { exclude: ['genosdb'] },
  build: { target: 'es2022' },
});

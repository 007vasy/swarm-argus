import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Client dev server on 5173, proxying API + WS to the backend on 4000.
export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  publicDir: '../../public',
  // 3d-force-graph and three-forcegraph both pull three; force a single copy so
  // the renderer and graph objects share one Matrix4 prototype.
  resolve: { dedupe: ['three'] },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});

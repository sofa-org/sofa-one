import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import type { RollupLog } from 'rollup';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3100';

function isThirdPartyPureAnnotationWarning(warning: RollupLog) {
  return (
    warning.code === 'INVALID_ANNOTATION' &&
    warning.id?.includes('/node_modules/') &&
    warning.message.includes('/*#__PURE__*/')
  );
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    modulePreload: false,
    chunkSizeWarningLimit: 1300,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (isThirdPartyPureAnnotationWarning(warning)) {
          return;
        }

        defaultHandler(warning);
      },
      // Let Rollup assign shared dependencies from the actual lazy-route graph.
      // Package-level wallet chunks also absorb common runtime helpers, making
      // the public entry statically import the entire SDK through those helpers.
    },
  },
  resolve: {
    dedupe: ['viem'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    fs: {
      allow: [__dirname, path.resolve(__dirname, '../src/common/calibur')],
    },
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});

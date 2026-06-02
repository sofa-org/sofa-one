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
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          wallet: ['@openfort/react', '@openfort/react/ethereum', '@openfort/react/wagmi', 'wagmi', 'viem'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});

import path from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Focused frontend unit tests: jsdom + React Testing Library, isolated from the
// Openfort/Stripe/backend runtime by mocking `@/lib/api` and auth dependencies.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.resolve(__dirname, 'src/test/setup.ts')],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    clearMocks: true,
  },
});

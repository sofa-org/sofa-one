import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// React Testing Library auto-cleanup is driven by globals; keep this explicit so
// tests never leak DOM between cases even if globals are reconfigured.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

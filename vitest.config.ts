import { defineConfig } from 'vitest/config';

// unit    — pure, no browser (`*.test.ts`).
// browser — Chromium driven by playwright inside each test (`*.browser.test.ts`).
// e2e     — the BUILT package: Playwright MCP over stdio + a packed-tarball consumer
//           (`*.e2e.test.ts`); needs `npm run build` first (`npm run test:e2e`).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts', 'test/**/*.e2e.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'browser',
          environment: 'node',
          include: ['test/**/*.browser.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['test/**/*.e2e.test.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});

import { defineConfig } from 'vitest/config';

// convex-test runs functions in an isolate; edge-runtime matches Convex's V8
// runtime semantics. The engine (imported from ../server) reads process.env in
// debug.ts, which edge-runtime doesn't provide, so we polyfill it in setup.
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    server: { deps: { inline: ['convex-test'] } },
    include: ['convex/__tests__/**/*.test.ts'],
    setupFiles: ['./convex/__tests__/setup.ts'],
  },
});

import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { 'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts') } },
  test: {
    environment: 'node',
    include: ['tests/render/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

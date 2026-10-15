import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // server-only throws outside the Next server build; the stub lets server modules be unit tested.
  resolve: { alias: { 'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts') } },
  test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] },
});

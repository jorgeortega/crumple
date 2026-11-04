import { defineConfig } from 'vitest/config';

// `npm run test:interop`: a real, separate MCP implementation against a real server. Kept out of
// `npm test` and the pre-push gate because it needs uv and a download.
export default defineConfig({
  test: {
    include: ['tests/python-interop/**/*.run.ts'],
    testTimeout: 30_000,
  },
});

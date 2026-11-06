import { defineConfig } from 'vitest/config';

// `npm run test:workers`: the demo on Cloudflare's own runtime, in a real `wrangler dev`, over real
// sockets. @cloudflare/vitest-pool-workers needs Vitest 4, and everything else here is on 5. It's
// slower than the rest, so like test:install it stays out of the pre-push gate. It deploys nothing.
export default defineConfig({
  test: {
    include: ['tests/workers/**/*.run.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each file starts its own workerd.
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

// `npm run test:install`: a packed tarball, installed in an empty folder, with no repository around
// it. It's kept out of the pre-push gate because npm has to reach the registry for the two
// dependencies, and a gate shouldn't fail for being offline.
export default defineConfig({
  test: {
    include: ['tests/install/**/*.run.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});

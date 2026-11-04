import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'spikes/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary'],
      // The spec's bars. Mistakes in these two cause real damage, so they get the higher one.
      thresholds: {
        branches: 85,
        'src/executor/**': { branches: 95 },
        'src/access-control/**': { branches: 95 },
      },
    },
  },
});

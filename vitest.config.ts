import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'spikes/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'workers/**/*.ts'],
      // index.ts is the few lines that read Cloudflare's bindings, and test:workers runs those.
      exclude: ['src/**/*.test.ts', 'workers/**/*.test.ts', 'workers/index.ts'],
      reporter: ['text-summary'],
      // The spec's bars. Mistakes in these two cause real damage, so they get the higher one.
      thresholds: {
        branches: 85,
        'src/executor/**': { branches: 95 },
        'src/access-control/**': { branches: 95 },
        // C17's safety promise: the budget and the rule about what may be called.
        'src/prove/external.ts': { branches: 95 },
        'src/mcp-client/**': { branches: 95 },
        // A mistake here spends real money.
        'src/agent-runner/**': { branches: 95 },
      },
    },
  },
});

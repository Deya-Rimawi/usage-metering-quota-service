import { defineConfig } from 'vitest/config';

// Test files share one real Postgres database, so files run one after another.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 20_000 } });

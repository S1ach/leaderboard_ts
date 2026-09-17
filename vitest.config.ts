import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false, // integration tests share one database
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      // Same host ports as docker-compose.yml: POSTGRES_PORT / REDIS_PORT move
      // both. TEST_DATABASE_URL / TEST_REDIS_URL still win over them.
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        `postgres://leaderboard:leaderboard@localhost:${process.env.POSTGRES_PORT ?? 5433}/leaderboard_test`,
      REDIS_URL: process.env.TEST_REDIS_URL ?? `redis://localhost:${process.env.REDIS_PORT ?? 6380}/1`,
    },
  },
});

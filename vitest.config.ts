import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false, // integration tests share one database
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://leaderboard:leaderboard@localhost:5433/leaderboard_test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6380/1',
    },
  },
});

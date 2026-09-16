/**
 * Redis keys. The `{season}` hash tag keeps all keys of a season in one
 * cluster slot: required for the Lua scripts and RENAME.
 */
export const keys = {
  leaderboard: (seasonId: number) => `leaderboard:{${seasonId}}`,
  meta: (seasonId: number) => `leaderboard:{${seasonId}}:meta`,
  rebuild: (seasonId: number) => `leaderboard:{${seasonId}}:rebuild`,
};

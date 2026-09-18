/**
 * design.md §2.2. Tie-break is encoded into the sorted-set score:
 *
 *   tie_local   = tie_seq - season.tie_base            (0 … 2^32-1)
 *   redis_score = score * 2^32 + (2^32 - 1 - tie_local)
 *
 * Higher score first; among equal scores the smaller tie_local (earlier
 * update) wins. All values stay below 2^53, so doubles are exact.
 */
export const TWO_32 = 4_294_967_296;
export const TIE_MAX = TWO_32 - 1;
export const SCORE_ABS_LIMIT = 2_097_152; // 2^21, mirrors the CHECK constraint

export function encodeScore(score: number, tieLocal: number): number {
  if (!Number.isInteger(score) || Math.abs(score) >= SCORE_ABS_LIMIT) {
    throw new RangeError(`score out of range: ${score}`);
  }
  if (!Number.isInteger(tieLocal) || tieLocal < 0 || tieLocal > TIE_MAX) {
    throw new RangeError(`tie_local out of range: ${tieLocal}`);
  }
  return score * TWO_32 + (TIE_MAX - tieLocal);
}

export function decodeScore(redisScore: number): { score: number; tieLocal: number } {
  const score = Math.floor(redisScore / TWO_32);
  const tieLocal = TIE_MAX - (redisScore - score * TWO_32);
  return { score, tieLocal };
}

export function tieLocal(tieSeq: number, tieBase: number): number {
  return tieSeq - tieBase;
}

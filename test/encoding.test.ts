import { describe, expect, it } from 'vitest';
import { decodeScore, encodeScore, SCORE_ABS_LIMIT, TIE_MAX, TWO_32 } from '../src/lib/encoding.js';

describe('score encoding (RFC-001 §2.2)', () => {
  it('round-trips positive, zero and negative scores', () => {
    for (const score of [0, 1, 42, -1, -42, SCORE_ABS_LIMIT - 1, -(SCORE_ABS_LIMIT - 1)]) {
      for (const tie of [0, 1, 123_456_789, TIE_MAX]) {
        expect(decodeScore(encodeScore(score, tie))).toEqual({ score, tieLocal: tie });
      }
    }
  });

  it('orders by score desc, then by earlier tie', () => {
    expect(encodeScore(10, 5)).toBeGreaterThan(encodeScore(9, 0));
    expect(encodeScore(10, 5)).toBeGreaterThan(encodeScore(10, 6));
    expect(encodeScore(-1, 0)).toBeGreaterThan(encodeScore(-2, 0));
    expect(encodeScore(0, 0)).toBeGreaterThan(encodeScore(-1, 0));
  });

  it('stays within double precision', () => {
    expect(Math.abs(encodeScore(SCORE_ABS_LIMIT - 1, 0))).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(Math.abs(encodeScore(-(SCORE_ABS_LIMIT - 1), TIE_MAX))).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    expect(encodeScore(SCORE_ABS_LIMIT - 1, 0)).toBe((SCORE_ABS_LIMIT - 1) * TWO_32 + TIE_MAX);
  });

  it('rejects out-of-range input', () => {
    expect(() => encodeScore(SCORE_ABS_LIMIT, 0)).toThrow(RangeError);
    expect(() => encodeScore(1, TIE_MAX + 1)).toThrow(RangeError);
    expect(() => encodeScore(1, -1)).toThrow(RangeError);
  });
});

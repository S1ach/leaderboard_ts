// Scenario "read": top and rank, target ~10 000 RPS in total (RFC-001 §9).
import { getTop, getRank, thresholds, summaryTrendStats } from './common.js';

const RATE = Number(__ENV.RATE || 10000);
const DURATION = __ENV.DURATION || '60s';

export const options = {
  summaryTrendStats,
  thresholds,
  scenarios: {
    top: {
      executor: 'constant-arrival-rate',
      rate: Math.round(RATE / 2),
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 300,
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      exec: 'top',
    },
    rank: {
      executor: 'constant-arrival-rate',
      rate: Math.round(RATE / 2),
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 300,
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      exec: 'rank',
    },
  },
};

export function top() {
  getTop();
}
export function rank() {
  getRank();
}

// Scenario "mixed": 10 reads : 1 write (design.md §6.1).
import { postScore, getTop, getRank, thresholds, summaryTrendStats } from './common.js';

const WRITE_RATE = Number(__ENV.WRITE_RATE || 1000);
const DURATION = __ENV.DURATION || '60s';

export const options = {
  summaryTrendStats,
  thresholds,
  scenarios: {
    write: {
      executor: 'constant-arrival-rate',
      rate: WRITE_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 200,
      maxVUs: Number(__ENV.MAX_VUS || 1000),
      exec: 'write',
    },
    top: {
      executor: 'constant-arrival-rate',
      rate: WRITE_RATE * 5,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 300,
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      exec: 'top',
    },
    rank: {
      executor: 'constant-arrival-rate',
      rate: WRITE_RATE * 5,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 300,
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      exec: 'rank',
    },
  },
};

export function write() {
  postScore();
}
export function top() {
  getTop();
}
export function rank() {
  getRank();
}

// Scenario "write": up to 1000 POST /score per second (RFC-001 §6.1).
import { postScore, thresholds, summaryTrendStats } from './common.js';

const RATE = Number(__ENV.RATE || 1000);
const DURATION = __ENV.DURATION || '60s';

export const options = {
  summaryTrendStats,
  thresholds,
  scenarios: {
    write: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 200,
      maxVUs: Number(__ENV.MAX_VUS || 1000),
    },
  },
};

export default postScore;

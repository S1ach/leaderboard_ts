import http from 'k6/http';
import { check } from 'k6';

const BASE_URLS = (__ENV.BASE_URL || 'http://localhost:3000').split(',');
function baseUrl() {
  return BASE_URLS[Math.floor(Math.random() * BASE_URLS.length)];
}
// Player id space: match the seed (p000000001 …). PLAYERS must be <= seeded count.
export const PLAYERS = Number(__ENV.PLAYERS || 100000);

export function randomPlayer() {
  return 'p' + String(1 + Math.floor(Math.random() * PLAYERS)).padStart(9, '0');
}

export function postScore() {
  const res = http.post(
    `${baseUrl()}/score`,
    JSON.stringify({ player_id: randomPlayer(), score_delta: 1 + Math.floor(Math.random() * 100) }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST /score' } },
  );
  check(res, { 'score 200': (r) => r.status === 200 });
}

export function getTop() {
  const res = http.get(`${baseUrl()}/leaderboard/top?limit=100`, { tags: { name: 'GET /leaderboard/top' } });
  check(res, { 'top 200': (r) => r.status === 200 });
}

export function getRank() {
  const res = http.get(`${baseUrl()}/leaderboard/rank/${randomPlayer()}?n=5`, { tags: { name: 'GET /leaderboard/rank' } });
  // 404 is legitimate for a player that has never scored.
  check(res, { 'rank 200/404': (r) => r.status === 200 || r.status === 404 });
}

// Per-endpoint thresholds also make k6 print a per-endpoint latency breakdown.
export const thresholds = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<200'],
  'http_req_duration{name:POST /score}': ['p(95)<500'],
  'http_req_duration{name:GET /leaderboard/top}': ['p(95)<500'],
  'http_req_duration{name:GET /leaderboard/rank}': ['p(95)<500'],
};

export const summaryTrendStats = ['avg', 'med', 'p(95)', 'p(99)', 'max'];

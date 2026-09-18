// Follow-up player_id boundary checks against the dedicated smoke API only.
// Repeatable: the expected score of a GET is whatever the preceding POST returned,
// so the script does not need a fresh set of ids.
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const results = [];
let posted = null;
for (const id of ['x'.repeat(100), 'x'.repeat(101), 'x'.repeat(128), 'x'.repeat(129), 'игрок /?#😀']) {
  for (const method of ['POST', 'GET']) {
    const path = method === 'POST' ? '/score' : `/leaderboard/rank/${encodeURIComponent(id)}`;
    const body = method === 'POST' ? { player_id: id, score_delta: 1 } : undefined;
    const expected = id.length > 128 ? 400 : 200;
    const response = await fetch('http://127.0.0.1:13000' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (method === 'POST') posted = response.status === 200 ? data.score : null;
  const pass =
    response.status === expected &&
    (expected !== 200 ||
      (method === 'GET' ? data.player?.player_id === id && data.player?.score === posted : data.player_id === id && typeof data.score === 'number'));
    results.push({ method, path, request: body, expected, status: response.status, response: data, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'} ${method} id.length=${id.length}: ${response.status}, expected ${expected}`);
    if (!pass) process.exitCode = 1;
    if (method === 'POST') await sleep(500);
  }
}
writeFileSync('docs/smoke-player-id-results.json', JSON.stringify({ date: new Date().toISOString(), results }, null, 2) + '\n');

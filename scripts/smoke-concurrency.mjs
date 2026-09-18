// Regression probe for SMOKE-01; fixed isolated smoke endpoint/project.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const results = [];
const started = new Date().toISOString();
const prefix = `race-${Date.now()}`;
try {
  for (let round = 1; round <= 10; round++) {
    const player = `${prefix}-${round}`;
    const result = { round, player, status: 'FAIL' };
    results.push(result);
    const responses = await Promise.all(Array.from({ length: 100 }, async () => {
      const response = await fetch('http://127.0.0.1:13000/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ player_id: player, score_delta: 1 }), signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.json() };
    }));
    result.responses = responses;
    assert.ok(responses.every(r => r.status === 200));
    assert.deepEqual(responses.map(r => r.body.score).sort((a,b) => a-b), Array.from({ length: 100 }, (_,i) => i+1));
    const deadline = Date.now() + 25000;
    do {
      const response = await fetch(`http://127.0.0.1:13000/leaderboard/rank/${player}?n=0`, { signal: AbortSignal.timeout(15000) });
      result.rank = { status: response.status, body: await response.json() };
      if (response.status === 200 && result.rank.body.player.score === 100) break;
      await sleep(200);
    } while (Date.now() < deadline);
    assert.equal(result.rank.status, 200);
    assert.equal(result.rank.body.player.score, 100);
    result.postgresScore = Number(execFileSync('docker', ['compose', '--env-file', 'scripts/smoke.env', '-p', 'lb-smoke', 'exec', '-T', 'postgres', 'psql', '-U', 'leaderboard', '-d', 'leaderboard', '-v', 'ON_ERROR_STOP=1', '-Atc', `SELECT score FROM player_scores WHERE player_id='${player}'`], { encoding: 'utf8', timeout: 15000 }).trim());
    assert.equal(result.postgresScore, 100);
    result.status = 'PASS';
    console.log(`PASS round ${round}: 100 parallel writes, PostgreSQL=Redis=100`);
  }
} catch (error) {
  results.at(-1).error = error.message;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeFileSync('docs/smoke-concurrency-results.json', JSON.stringify({ started, finished: new Date().toISOString(), results }, null, 2) + '\n');
}

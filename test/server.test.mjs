import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

test('HTTP budget limits, same-origin writes, ledger persistence, duplicate prevention and undo', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manwon-test-'));
  const port = 18787, base = `http://127.0.0.1:${port}`;
  let child;
  async function launch() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), LAB_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw new Error(stderr);
      try { const r = await fetch(base + '/api/state'); if (r.ok) return await r.json(); } catch {}
      await delay(100);
    }
    throw new Error('Test server startup timeout ' + stderr);
  }
  async function stop() {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
  try {
    let state = await launch();
    assert.equal(state.paper.initialCapital, 10000);
    const post = async (url, body, headers = {}) => {
      const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': state.token, ...headers }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.get(base + '/api/state', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await post('/api/capital', { capital: 30000 }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/capital', { capital: 30000 }, { 'X-Lab-Token': '' })).status, 403);
    assert.equal((await post('/api/strategy', { strategy: 'scalp' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post('/api/strategy', { strategy: 'toString' })).status, 400);
    const strategy = await post('/api/strategy', { strategy: 'scalp' });
    assert.equal(strategy.status, 200); assert.equal(strategy.body.rules.maxHoldMs, 300000);
    assert.equal(strategy.body.control.running, false); assert.equal(strategy.body.feedback.samples, 0);
    for (const capital of [0, 9999, 100001, 110000, 10000.5]) assert.equal((await post('/api/capital', { capital })).status, 400);
    let result = await post('/api/capital', { capital: 100000 });
    assert.equal(result.status, 200); assert.equal(result.body.paper.initialCapital, 100000); assert.equal(result.body.manual.cash, 100000);
    result = await post('/api/capital', { capital: 30000 }); assert.equal(result.status, 200);
    const fill = { side: 'buy', market: 'KRW-XRP', quantity: 6, price: 1000, fee: 3, reference: 'isolated-test-only', at: Date.now() };
    result = await post('/api/manual', fill); assert.equal(result.status, 200); assert.equal(result.body.manual.cash, 23997);
    assert.equal(result.body.paper.trades.length, 0); assert.equal(result.body.manual.trades.length, 1);
    assert.equal((await post('/api/manual', fill)).status, 400);
    assert.equal((await post('/api/manual', { ...fill, quantity: 100, reference: 'overdraft' })).status, 400);
    assert.equal((await post('/api/capital', { capital: 50000 })).status, 400);
    assert.equal((await fetch(base + '/api/orders')).status, 404);
    const csv = await (await fetch(base + '/api/export?mode=manual')).text();
    assert.ok(csv.includes('사용자 입력 실거래')); assert.ok(csv.includes('isolated-test-only'));
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'experiment.json'), 'utf8'));
    assert.equal(persisted.manual.trades.length, 1);
    await stop(); state = await launch();
    assert.equal(state.control.strategy, 'scalp'); assert.equal(state.rules.maxEntriesPerDay, 30);
    assert.equal(state.manual.cash, 23997); assert.equal(state.manual.trades.length, 1); assert.equal(state.control.running, false);
    result = await post('/api/manual/undo', {});
    assert.equal(result.status, 200); assert.equal(result.body.manual.cash, 30000); assert.equal(result.body.manual.trades.length, 0);
    assert.equal(result.body.capitalEditable, false);
    assert.equal((await post('/api/capital', { capital: 50000 })).status, 400);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'experiment.json'), 'utf8')).corrections.length, 1);
  } finally {
    await stop();
    // A fixed-prefix, freshly-created test directory only; never user data.
    if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('manwon-test-')) fs.rmSync(dir, { recursive: true, force: true });
  }
});

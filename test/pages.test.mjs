import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { newState } from '../engine.mjs';
import { applyPagesAction, validateSavedState, tradesCsv } from '../pages-state.mjs';

test('Pages keeps the chosen budget locked and real records separate from paper funds', () => {
  const now = Date.now(), state = newState(now);
  applyPagesAction(state, '/api/capital', { capital: 100000 }, {}, now);
  assert.equal(state.paper.cash, 100000); assert.equal(state.manual.cash, 100000);
  const fill = { side: 'buy', market: 'KRW-XRP', quantity: 6, price: 1000, fee: 3, reference: 'test-only', at: now };
  applyPagesAction(state, '/api/manual', fill, {}, now);
  assert.equal(state.manual.cash, 93997); assert.equal(state.paper.cash, 100000);
  assert.throws(() => applyPagesAction(state, '/api/manual', fill, {}, now), /이미/);
  applyPagesAction(state, '/api/manual/undo', {}, {}, now);
  assert.equal(state.manual.cash, 100000);
  assert.throws(() => applyPagesAction(state, '/api/capital', { capital: 10000 }, {}, now), /원금/);
});
test('Pages rejects out-of-range budgets, stale starts and unsupported actions', () => {
  const now = Date.now(), state = newState(now);
  for (const capital of [0, 9000, 101000, 10000.5, Infinity]) assert.throws(() => applyPagesAction(state, '/api/capital', { capital }, {}, now));
  assert.throws(() => applyPagesAction(state, '/api/control', { action: 'start' }, {}, now), /시세/);
  assert.throws(() => applyPagesAction(state, '/api/orders', {}, {}, now));
});
test('Pages preserves corrupt storage and escapes spreadsheet formulas in CSV', () => {
  assert.throws(() => validateSavedState({ schema: 0 }));
  const state = newState(); assert.equal(validateSavedState(state), state);
  state.manual.cash = -1; assert.throws(() => validateSavedState(state));
  const fresh = newState();
  applyPagesAction(fresh, '/api/manual', { side: 'buy', market: 'KRW-XRP', quantity: 6, price: 1000, fee: 3, reference: '=BAD()', at: Date.now() }, {}, Date.now());
  assert.ok(tradesCsv(fresh.manual, 'manual').includes("'=BAD()"));
});
test('Pages artifact is subpath-safe and contains only static site assets', () => {
  const folder = new URL('../docs/', import.meta.url);
  const html = fs.readFileSync(new URL('index.html', folder), 'utf8');
  assert.ok(html.includes('name="lab-runtime" content="browser"'));
  assert.ok(html.includes('type="module"'));
  assert.ok(!/(href|src)="\//.test(html));
  for (const file of ['app.js', 'style.css', 'favicon.svg', 'engine.mjs', 'pages-state.mjs', 'browser-runtime.mjs', 'market-universe.mjs', '.nojekyll']) assert.ok(fs.existsSync(new URL(file, folder)));
  assert.ok(fs.existsSync(new URL('strategies.mjs', folder)));
  assert.equal(fs.readdirSync(folder).length, 10);
  assert.ok(!fs.readFileSync(new URL('engine.mjs', folder), 'utf8').includes('node:'));
  assert.ok(fs.readFileSync(new URL('browser-runtime.mjs', folder), 'utf8').includes('wss://api.upbit.com/websocket/v1'));
});

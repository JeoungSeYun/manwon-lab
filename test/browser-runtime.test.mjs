import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../browser-runtime.mjs';
import { newState } from '../engine.mjs';
import { SCANNER } from '../market-universe.mjs';

function runtimeFixture() {
  const now = Date.now(), boundary = Math.floor(now / 60000) * 60000;
  const runtime = Object.create(BrowserRuntime.prototype);
  const market = { code: 'KRW-ADA', entryEligible: true, selected: true, reasons: [] };
  Object.assign(runtime, { state: newState(now), catalog: [market], scanTickers: { 'KRW-ADA': { trade_price: 1029, acc_trade_price_24h: 2e9 } }, tickers: {}, selection: { watched: [market] }, offset: 0, quotes: { 'KRW-ADA': { at: now, spread: .001, levels: [{ ask_price: 1030, bid_price: 1029, ask_size: 100, bid_size: 100 }] } }, signals: {}, bootstrapped: { 'KRW-ADA': true }, candleErrors: {}, candles: { 'KRW-ADA': Array.from({ length: 30 }, (_, i) => ({ candle_date_time_utc: new Date(boundary - (30 - i) * 60000).toISOString().slice(0, 19), trade_price: 1000 + i })) }, readOnly: false, storageError: '', scanError: '', catalogFetched: now, tickersFetched: now, socket: null, nextRequestAt: Infinity, lastSave: Infinity });
  runtime.state.control.running = true; runtime.state.control.startedAt = now;
  runtime.save = () => true;
  return runtime;
}

test('runtime suspends entries on stale or failed discovery, yet still closes held paper positions', () => {
  for (const setup of [r => { r.scanError = 'network failure'; }, r => { r.catalogFetched -= SCANNER.maxAgeMs + 1; }, r => { r.tickersFetched = r.catalogFetched - 1; }]) {
    const runtime = runtimeFixture(); setup(runtime); runtime.tick();
    assert.equal(runtime.state.paper.trades.length, 0);
  }
  const runtime = runtimeFixture(); runtime.tick();
  assert.equal(runtime.state.paper.trades.length, 1);
  runtime.scanError = 'network failure';
  runtime.quotes['KRW-ADA'].levels[0].bid_price = 1000;
  runtime.tick();
  assert.equal(runtime.state.paper.trades.length, 2);
  assert.equal(runtime.state.paper.trades[1].side, 'sell');
});

test('runtime waits for REST bootstrap even when a live candle stream contains enough candles', () => {
  const runtime = runtimeFixture(); runtime.bootstrapped = {}; runtime.tick();
  assert.equal(runtime.state.paper.trades.length, 0); assert.equal(runtime.signals['KRW-ADA'].ready, false);
});

test('REST throttling backs off after 429 and never transmits credentials or an order', async t => {
  const runtime = runtimeFixture(); runtime.apiBusy = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.upbit.com/v1/ticker/all?quote_currencies=KRW');
    assert.equal(options.credentials, 'omit'); assert.equal(options.method, undefined);
    return { ok: false, status: 429 };
  });
  const before = Date.now();
  await assert.rejects(runtime.request('ticker/all?quote_currencies=KRW'), /429/);
  assert.ok(runtime.nextRequestAt >= before + 60000); assert.equal(runtime.apiBusy, false);
});

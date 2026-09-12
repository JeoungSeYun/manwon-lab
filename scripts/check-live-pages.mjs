// Bounded integration check: public market data only, in-memory test storage.
import assert from 'node:assert/strict';
const memory = new Map(), events = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
globalThis.window = { addEventListener: (name, callback) => events.set(name, callback) };
Object.defineProperty(globalThis.navigator, 'locks', { value: { request: async (name, options, callback) => callback({ name }) }, configurable: true });
const { BrowserRuntime } = await import('../browser-runtime.mjs');
const runtime = new BrowserRuntime();
const startedAt = Date.now();
try {
  await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const snapshot = runtime.snapshot();
      if (snapshot.feed.storageError) { clearInterval(timer); reject(new Error(snapshot.feed.storageError)); return; }
      if (snapshot.universe.total > 4 && snapshot.universe.selected > 4 && snapshot.markets.every(m => m.quote) && snapshot.markets.every(m => runtime.bootstrapped[m.code])) {
        clearInterval(timer); resolve();
      } else if (Date.now() - startedAt > 230000) { clearInterval(timer); reject(new Error('Live quote/candle startup timed out: ' + JSON.stringify({ error: snapshot.feed.error, universe: snapshot.universe.total, selected: snapshot.universe.selected, books: snapshot.markets.filter(m => m.quote).length, prepared: Object.keys(runtime.bootstrapped).length }))); }
    }, 500);
  });
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.paper.trades.length, 0);
  assert.equal(snapshot.manual.trades.length, 0);
  assert.equal(snapshot.control.running, false);
  assert.equal(snapshot.control.strategy, 'scalp');
  assert.equal(snapshot.feedback.samples, 0);
  assert.ok(snapshot.feed.ok);
  assert.ok(Object.values(runtime.candles).some(rows => rows.some(c => c.type === 'candle.1m')), 'WebSocket one-minute candle messages received');
  runtime.tick();
  console.log(JSON.stringify({ ok: true, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), mode: 'read-only integration check', strategy: snapshot.control.strategy, feedbackSamples: snapshot.feedback.samples, universe: { total: snapshot.universe.total, selected: snapshot.universe.selected, excluded: snapshot.universe.excluded }, markets: runtime.snapshot().markets.map(m => ({ market: m.code, price: m.quote.price, spreadPct: m.quote.spread * 100, signalReady: m.signal.ready, volumeRatio: m.signal.volumeRatio, signal: m.signal.reason })) }, null, 2));
} finally { events.get('pagehide')?.(); }

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
      if (snapshot.markets.every(m => m.quote) && snapshot.markets.every(m => m.signal.ready || m.signal.reason !== '마감 1분봉 수집 중 · 첫 연결 시 약 1분 소요')) {
        clearInterval(timer); resolve();
      } else if (Date.now() - startedAt > 55000) { clearInterval(timer); reject(new Error('Live quote/candle startup timed out')); }
    }, 500);
  });
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.paper.trades.length, 0);
  assert.equal(snapshot.manual.trades.length, 0);
  assert.equal(snapshot.control.running, false);
  assert.ok(snapshot.feed.ok);
  console.log(JSON.stringify({ ok: true, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), mode: 'read-only integration check', markets: snapshot.markets.map(m => ({ market: m.code, price: m.quote.price, spreadPct: m.quote.spread * 100, signalReady: m.signal.ready, signal: m.signal.reason })) }, null, 2));
} finally { events.get('pagehide')?.(); }

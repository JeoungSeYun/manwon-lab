import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, newState, newLedger, recordFill, valuation, simulateFill, signalFromCandles, advancePaper, closePaper, dayKey } from '../engine.mjs';

const NOW = Date.UTC(2026, 8, 12, 12, 0, 30);
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function quote(price = 1000, at = NOW) {
  return { at, price, bid: price, ask: price + 1, spread: 1 / (price + 1), levels: [{ ask_price: price + 1, ask_size: 100, bid_price: price, bid_size: 100 }] };
}
function signal(now = NOW) { return { ready: true, entry: true, exit: false, validUntil: now + 60_000, score: .003, candleAt: now - 60_000 }; }
function running(capital = 10000) {
  const state = newState(NOW); state.paper = newLedger(capital); state.manual = newLedger(capital);
  state.control.running = true; state.control.startedAt = NOW; return state;
}

test('cash, average cost, partial sells and fees reconcile without manufacturing profit', () => {
  const l = newLedger();
  recordFill(l, { side: 'buy', market: 'KRW-XRP', quantity: 6, price: 1000, fee: 3 }, NOW);
  near(l.cash, 3997); near(l.positions['KRW-XRP'].cost, 6003);
  recordFill(l, { side: 'sell', market: 'KRW-XRP', quantity: 2, price: 1100, fee: 1.1 }, NOW + 1);
  near(l.realizedPnl, 197.9); near(l.positions['KRW-XRP'].cost, 4002);
  recordFill(l, { side: 'sell', market: 'KRW-XRP', quantity: 4, price: 900, fee: 1.8 }, NOW + 2);
  near(l.realizedPnl, -205.9); near(l.cash, 9794.1); near(l.totalFees, 5.9);
  assert.deepEqual(l.positions, {}); near(valuation(l, {}, NOW).pnl, l.realizedPnl);
});
test('reject overspending, short sales, duplicate fills and non-finite input without mutation', () => {
  const l = newLedger(); const empty = structuredClone(l);
  for (const input of [
    { quantity: 10, price: 1000, fee: 5 }, { quantity: -1, price: 1000, fee: 0 },
    { quantity: Infinity, price: 1000, fee: 0 }, { quantity: 1, price: 1000, fee: -1 },
    { quantity: 1, price: NaN, fee: 0 },
  ]) assert.throws(() => recordFill(l, { side: 'buy', market: 'KRW-BTC', ...input }, NOW));
  assert.deepEqual(l, empty);
  assert.throws(() => recordFill(l, { side: 'sell', market: 'KRW-BTC', quantity: 1, price: 1, fee: 0 }, NOW));
  const fill = { side: 'buy', market: 'KRW-XRP', quantity: 6, price: 1000, fee: 3, reference: 'same-fill' };
  recordFill(l, fill, NOW); const before = structuredClone(l);
  assert.throws(() => recordFill(l, fill, NOW)); assert.deepEqual(l, before);
});
test('paper fill walks real book depth and charges adverse slippage on both sides', () => {
  const q = quote(); q.levels = [
    { ask_price: 100, ask_size: 10, bid_price: 99, bid_size: 10 },
    { ask_price: 110, ask_size: 100, bid_price: 90, bid_size: 100 },
  ];
  const fill = simulateFill(q, 'buy', 5500, NOW);
  assert.ok(fill.price > 100); assert.ok(fill.notional <= 5500); near(fill.fee, fill.notional * RULES.feeRate);
  const sold = simulateFill(q, 'sell', fill.quantity, NOW);
  assert.ok(sold.notional < fill.notional); assert.ok(sold.price < 99);
  assert.throws(() => simulateFill(q, 'buy', 1000000, NOW), /잔량/);
});
test('stale and future quotes cannot produce fills; missing valuation is unknown, not a false loss', () => {
  assert.throws(() => simulateFill(quote(1000, NOW - 31_000), 'buy', 6000, NOW), /지연/);
  assert.throws(() => simulateFill(quote(1000, NOW + 10_000), 'buy', 6000, NOW), /지연/);
  const l = newLedger(); recordFill(l, { side: 'buy', market: 'KRW-XRP', quantity: 6, price: 1000, fee: 3 }, NOW);
  assert.equal(valuation(l, {}, NOW).equity, null);
  const view = valuation(l, { 'KRW-XRP': quote(1000, NOW - 31_000) }, NOW);
  assert.equal(view.stale, true); assert.ok(view.equity > l.cash);
});
test('current candle is excluded, and gaps or stale candles suspend signals', () => {
  const boundary = Math.floor(NOW / 60_000) * 60_000;
  const rows = Array.from({ length: 30 }, (_, i) => ({ candle_date_time_utc: new Date(boundary - (30 - i) * 60_000).toISOString().slice(0, 19), trade_price: 1000 + i }));
  const clean = signalFromCandles(rows, NOW); assert.equal(clean.entry, true);
  const withFuture = signalFromCandles([...rows, { candle_date_time_utc: new Date(boundary).toISOString().slice(0, 19), trade_price: 999999 }], NOW);
  assert.deepEqual(clean, withFuture);
  assert.equal(signalFromCandles(rows.filter((_, i) => i !== 23), NOW).ready, false);
  assert.equal(signalFromCandles(rows, NOW + 180_000).ready, false);
});
test('1–10만 원 budgets keep 10% cash and make only one position, even on repeated ticks', () => {
  for (const capital of [10000, 30000, 50000, 100000]) {
    const state = running(capital);
    const quotes = { 'KRW-XRP': quote(), 'KRW-SOL': quote() };
    const signals = { 'KRW-XRP': signal(), 'KRW-SOL': signal() };
    advancePaper(state, quotes, signals, NOW);
    assert.equal(state.paper.trades.length, 1);
    assert.ok(state.paper.cash >= capital * .1 - .000001);
    assert.ok(state.paper.trades[0].notional >= RULES.minOrder);
    advancePaper(state, quotes, signals, NOW + 1);
    assert.equal(state.paper.trades.length, 1);
    assert.equal(valuation(state.paper, quotes, NOW).initialCapital, capital);
  }
});
test('no entries on wide spreads, stale signals or stale books', () => {
  for (const [q, s] of [[{ ...quote(), spread: .03 }, signal()], [quote(), { ...signal(), validUntil: NOW - 1 }], [quote(1000, NOW - 31_000), signal()]]) {
    const state = running(); advancePaper(state, { 'KRW-XRP': q }, { 'KRW-XRP': s }, NOW);
    assert.equal(state.paper.trades.length, 0);
  }
});
test('pause still exits existing position at stop loss and does not re-enter', () => {
  const state = running(); advancePaper(state, { 'KRW-XRP': quote() }, { 'KRW-XRP': signal() }, NOW);
  state.control.running = false;
  advancePaper(state, { 'KRW-XRP': quote(980, NOW + 10_000) }, { 'KRW-XRP': signal() }, NOW + 10_000);
  assert.equal(state.paper.trades.length, 2); assert.equal(state.paper.trades[1].side, 'sell'); assert.ok(state.paper.realizedPnl < 0);
  assert.equal(Object.keys(state.paper.positions).length, 0);
});
test('experiment loss limit locks entries and exits at current price; does not clip losses to the limit', () => {
  const state = running(); advancePaper(state, { 'KRW-XRP': quote() }, { 'KRW-XRP': signal() }, NOW);
  advancePaper(state, { 'KRW-XRP': quote(900, NOW + 10_000) }, { 'KRW-XRP': signal() }, NOW + 10_000);
  assert.equal(state.control.locked, true); assert.equal(state.control.running, false);
  assert.ok(state.paper.realizedPnl < -500); assert.equal(Object.keys(state.paper.positions).length, 0);
});
test('minimum sell size failure preserves the position and avoids a fictitious exit', () => {
  const state = running(); advancePaper(state, { 'KRW-XRP': quote() }, { 'KRW-XRP': signal() }, NOW);
  assert.throws(() => closePaper(state, { 'KRW-XRP': quote(400) }, NOW), /5,000/);
  assert.equal(state.paper.trades.length, 1); assert.equal(Object.keys(state.paper.positions).length, 1);
});
test('24-hour completion locks new entries and quotes cannot backfill downtime', () => {
  const state = running(); advancePaper(state, {}, {}, NOW + RULES.experimentMs);
  assert.equal(state.control.locked, true); assert.equal(state.paper.trades.length, 0);
  assert.equal(dayKey(Date.UTC(2026, 8, 12, 16)), '2026-09-13');
});

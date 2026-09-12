import test from 'node:test';
import assert from 'node:assert/strict';
import { signalFromCandles, newState, setStrategy, advancePaper, activeRules, strategyPerformance, recordFill, RULES } from '../engine.mjs';
import { adaptiveFeedback } from '../strategies.mjs';
import { parseMarkets, rankMarkets } from '../market-universe.mjs';
import { applyPagesAction, validateSavedState, tradesCsv } from '../pages-state.mjs';

const NOW = Date.UTC(2026, 8, 12, 12, 0, 30), boundary = NOW - 30000;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function candles() {
  return Array.from({ length: 20 }, (_, i) => {
    const price = i === 19 ? 1007 : 1000 + i * .2;
    return { candle_date_time_utc: new Date(boundary - (20 - i) * 60000).toISOString().slice(0, 19), trade_price: price, opening_price: price - .1, high_price: price + .1, low_price: price - .2, candle_acc_trade_volume: i === 19 ? 200 : 100 };
  });
}
function quote(price = 1007, at = NOW) {
  return { at, bid: price, ask: price + .5, spread: .5 / (price + .5), levels: [{ ask_price: price + .5, ask_size: 100, bid_price: price, bid_size: 100 }] };
}
function scalpState() {
  const state = newState(NOW); setStrategy(state, 'scalp', NOW);
  state.control.running = true; state.control.startedAt = NOW;
  return state;
}
const sig = () => signalFromCandles(candles(), NOW, 'scalp');
function enter(state, quotes = { 'KRW-XRP': quote() }) { advancePaper(state, quotes, { 'KRW-XRP': sig() }, NOW); }

test('scalp signals need real closed OHLCV, increased volume and a breakout without hindsight', () => {
  const rows = candles(), signal = sig();
  assert.equal(signal.ready, true); assert.equal(signal.entry, true); near(signal.volumeRatio, 2);
  const future = { ...rows.at(-1), candle_date_time_utc: new Date(boundary).toISOString().slice(0, 19), trade_price: 999999, high_price: 999999, candle_acc_trade_volume: 999999 };
  assert.deepEqual(signalFromCandles([...rows, future], NOW, 'scalp'), signal);
  assert.equal(signalFromCandles(rows.filter((_, i) => i !== 12), NOW, 'scalp').ready, false);
  assert.equal(signalFromCandles(rows, NOW + 120000, 'scalp').ready, false);
  assert.equal(signalFromCandles(rows.map(c => ({ ...c, candle_acc_trade_volume: 100 })), NOW, 'scalp').entry, false);
  assert.equal(signalFromCandles(rows.map(c => ({ ...c, high_price: undefined })), NOW, 'scalp').ready, false);
});

test('scalp preserves the budget and records its own fee-adjusted five-minute time exit', () => {
  const state = scalpState(); enter(state);
  assert.equal(state.paper.trades.length, 1); assert.equal(state.paper.positions['KRW-XRP'].strategy, 'scalp');
  assert.ok(state.paper.cash >= 1000); assert.equal(activeRules(state).maxEntriesPerDay, 30);
  state.control.running = false;
  const later = NOW + 300001;
  advancePaper(state, { 'KRW-XRP': quote(1007, later) }, {}, later);
  assert.equal(state.paper.trades.length, 2); assert.match(state.paper.trades[1].reason, /5분/);
  assert.equal(state.paper.trades[1].strategy, 'scalp');
  assert.ok(state.paper.trades[1].returnRate < 0); assert.ok(state.paper.totalFees > 0);
  near(state.paper.cash - 10000, state.paper.realizedPnl);
});

test('scalp trailing exit uses observed net-profit peaks and survives save/restore', () => {
  let state = scalpState(); enter(state);
  advancePaper(state, { 'KRW-XRP': quote(1018, NOW + 10000) }, {}, NOW + 10000);
  assert.equal(state.paper.trades.length, 1);
  assert.ok(state.paper.positions['KRW-XRP'].peakNetReturn >= .006);
  state = validateSavedState(JSON.parse(JSON.stringify(state)));
  advancePaper(state, { 'KRW-XRP': quote(1013, NOW + 20000) }, {}, NOW + 20000);
  assert.equal(state.paper.trades.length, 2); assert.match(state.paper.trades[1].reason, /추적 청산/);
  assert.ok(state.paper.realizedPnl > 0);
});

test('scalp rejects chasing, failed breakouts and thin bid depth, then checks the next candidate', () => {
  for (const q of [quote(1030), quote(1000), { ...quote(), levels: [{ ask_price: 1007.5, ask_size: 100, bid_price: 1007, bid_size: .001 }, { ask_price: 1008, ask_size: 100, bid_price: 1000, bid_size: 100 }] }]) {
    const state = scalpState(); enter(state, { 'KRW-XRP': q }); assert.equal(state.paper.trades.length, 0);
  }
  const state = scalpState();
  advancePaper(state, { 'KRW-XRP': quote(1030), 'KRW-SOL': quote() }, { 'KRW-XRP': { ...sig(), score: 99 }, 'KRW-SOL': sig() }, NOW);
  assert.equal(state.paper.trades.length, 1); assert.equal(state.paper.trades[0].market, 'KRW-SOL');
});

test('strategy changes cannot alter a held trade, reset history, expand risk or revive an ended experiment', () => {
  const state = scalpState(); enter(state);
  assert.throws(() => setStrategy(state, 'trend', NOW), /보유분/);
  const before = structuredClone(state);
  assert.throws(() => setStrategy(state, 'toString', NOW)); assert.deepEqual(state, before);
  state.control.running = false;
  advancePaper(state, { 'KRW-XRP': quote(990, NOW + 10000) }, {}, NOW + 10000);
  const history = structuredClone(state.paper.trades), started = state.control.startedAt;
  applyPagesAction(state, '/api/strategy', { strategy: 'trend' }, {}, NOW + 20000);
  assert.deepEqual(state.paper.trades, history); assert.equal(state.control.startedAt, started); assert.equal(state.control.running, false);
  assert.equal(activeRules(state).lossRatio, RULES.lossRatio); assert.equal(activeRules(state).investmentRatio, RULES.investmentRatio);
  state.control.locked = true; assert.throws(() => setStrategy(state, 'scalp', NOW), /종료/);
});

const outcome = (market, returnRate, at, strategy = 'scalp') => ({ market, side: 'sell', returnRate, realizedPnl: returnRate * 9000, at, strategy });
test('feedback only uses closed scalp trades, needs three samples and bounds score adjustments', () => {
  const records = [outcome('KRW-XRP', .01, NOW - 3000), outcome('KRW-XRP', -.001, NOW - 2000), outcome('KRW-XRP', .01, NOW - 1000)];
  assert.equal(adaptiveFeedback(records.slice(0, 2), NOW).markets['KRW-XRP'].multiplier, 1);
  const result = adaptiveFeedback([...records, outcome('KRW-SOL', .1, NOW, 'trend'), { ...outcome('KRW-ETH', .9, NOW), side: 'buy' }], NOW);
  assert.equal(result.samples, 3); assert.equal(result.markets['KRW-SOL'], undefined);
  assert.ok(result.markets['KRW-XRP'].multiplier > 1 && result.markets['KRW-XRP'].multiplier <= 1.15);
  const high = adaptiveFeedback(Array.from({ length: 10 }, (_, i) => outcome('KRW-XRP', 100, NOW - i)), NOW);
  assert.equal(high.markets['KRW-XRP'].samples, 8); near(high.markets['KRW-XRP'].multiplier, 1.15);
  const low = adaptiveFeedback(Array.from({ length: 3 }, (_, i) => outcome('KRW-XRP', -100, NOW - i)), NOW);
  near(low.markets['KRW-XRP'].multiplier, .65);
});

test('loss streaks pause new entries for bounded durations, never block existing position exits', () => {
  const records = [outcome('KRW-XRP', -.006, NOW - 3000), outcome('KRW-XRP', -.006, NOW - 2000), outcome('KRW-SOL', -.006, NOW - 1000)];
  let result = adaptiveFeedback(records, NOW);
  assert.equal(result.paused, true); assert.equal(result.markets['KRW-XRP'].paused, true);
  result = adaptiveFeedback(records, NOW + 21 * 60000);
  assert.equal(result.paused, false); assert.equal(result.markets['KRW-XRP'].paused, false);
  const state = scalpState(); state.paper.trades = structuredClone(records); enter(state);
  assert.equal(state.paper.trades.length, 3);
  const held = scalpState(); enter(held); held.paper.trades.push(...records);
  advancePaper(held, { 'KRW-XRP': quote(990, NOW + 10000) }, {}, NOW + 10000);
  assert.equal(Object.keys(held.paper.positions).length, 0); assert.match(held.paper.trades.at(-1).reason, /손절/);
});

test('feedback changes candidate priority and persists solely through the trade ledger', () => {
  const state = scalpState();
  state.paper.trades = [outcome('KRW-SOL', .01, NOW - 3000), outcome('KRW-SOL', .01, NOW - 2000), outcome('KRW-SOL', .01, NOW - 1000)];
  const restored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(adaptiveFeedback(restored.paper.trades, NOW), adaptiveFeedback(state.paper.trades, NOW));
  advancePaper(restored, { 'KRW-XRP': quote(), 'KRW-SOL': quote() }, { 'KRW-XRP': { ...sig(), score: 1.05 }, 'KRW-SOL': { ...sig(), score: 1 } }, NOW);
  assert.equal(restored.paper.trades.at(-1).market, 'KRW-SOL');
});

test('scalp watchlist includes liquid volatile candidates without admitting market warnings', () => {
  const event = { warning: false, caution: { PRICE_FLUCTUATIONS: false, TRADING_VOLUME_SOARING: false, DEPOSIT_AMOUNT_SOARING: false, GLOBAL_PRICE_DIFFERENCES: false, CONCENTRATION_OF_SMALL_ACCOUNTS: false } };
  const catalog = parseMarkets(Array.from({ length: 20 }, (_, i) => ({ market: `KRW-T${i}`, market_event: { ...event, warning: i === 19 } })));
  const tickers = Object.fromEntries(catalog.map((m, i) => [m.code, { trade_price: 100, acc_trade_price_24h: (30 - i) * 1e9, high_price: i >= 15 ? 115 : 101, low_price: 100 }]));
  assert.equal(rankMarkets(catalog, tickers).watched.some(m => m.code === 'KRW-T18'), false);
  const selection = rankMarkets(catalog, tickers, [], 'scalp');
  for (let i = 0; i < 6; i++) assert.ok(selection.watched.some(m => m.code === `KRW-T${i}`));
  assert.equal(selection.watched.some(m => m.code === 'KRW-T18'), true);
  assert.equal(selection.watched.some(m => m.code === 'KRW-T19'), false);
});

test('performance and CSV report separate realized results, fees and reasons without counting unrealized gains', () => {
  const state = scalpState(); enter(state);
  let performance = strategyPerformance(state.paper);
  assert.equal(performance[1].closed, 0); assert.equal(performance[1].winRate, null); assert.equal(performance[1].netPnl, 0);
  advancePaper(state, { 'KRW-XRP': quote(1025, NOW + 10000) }, {}, NOW + 10000);
  performance = strategyPerformance(state.paper);
  assert.equal(performance[1].closed, 1); assert.equal(performance[0].closed, 0);
  near(performance[1].netPnl, state.paper.realizedPnl); near(performance[1].fees, state.paper.totalFees);
  assert.match(tradesCsv(state.paper, 'paper'), /단타 돌파/);
  const legacy = newState(NOW);
  recordFill(legacy.paper, { side: 'buy', market: 'KRW-XRP', quantity: 6, price: 1000, fee: 3 }, NOW);
  legacy.control.strategy = 'scalp';
  advancePaper(legacy, { 'KRW-XRP': quote(992, NOW + 10000) }, {}, NOW + 10000);
  assert.equal(legacy.paper.trades.length, 1, 'legacy position retains 1% stop rather than scalp 0.6%');
});

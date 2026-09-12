import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkets, rankMarkets, mergeCandles, nextCandleMarket, SCANNER } from '../market-universe.mjs';
import { newState, advancePaper, recordFill, closePaper, signalFromCandles } from '../engine.mjs';
import { applyPagesAction, validateSavedState } from '../pages-state.mjs';

const NOW = Date.UTC(2026, 8, 12, 12, 0, 30);
const raw = (code, overrides = {}) => ({ market: code, korean_name: code, market_event: { warning: false, caution: { PRICE_FLUCTUATIONS: false, TRADING_VOLUME_SOARING: false, DEPOSIT_AMOUNT_SOARING: false, GLOBAL_PRICE_DIFFERENCES: false, CONCENTRATION_OF_SMALL_ACCOUNTS: false } }, ...overrides });
const quote = () => ({ at: NOW, spread: .001, levels: [{ ask_price: 1001, ask_size: 100, bid_price: 1000, bid_size: 100 }] });

test('full KRW universe ranks liquidity, excludes all warnings and keeps held assets outside the top 12', () => {
  const rows = Array.from({ length: 16 }, (_, i) => raw(`KRW-T${i}`));
  rows[0].market_event.warning = true;
  rows[1].market_event.caution.PRICE_FLUCTUATIONS = true;
  rows[2].market_event = undefined;
  rows.push(raw('BTC-ETH'), raw('__proto__'), rows[4]);
  const catalog = parseMarkets(rows);
  assert.equal(catalog.length, 16);
  const tickers = Object.fromEntries(catalog.map((m, i) => [m.code, { trade_price: 1000, acc_trade_price_24h: (30 - i) * 1e9 }]));
  const selection = rankMarkets(catalog, tickers, ['KRW-T15', 'KRW-DELISTED']);
  assert.equal(selection.selected, 12); assert.equal(selection.excluded, 3); assert.equal(selection.watched.length, 14);
  assert.equal(selection.watched.find(m => m.code === 'KRW-T15').entryEligible, false);
  assert.equal(selection.watched.find(m => m.code === 'KRW-DELISTED').entryEligible, false);
  assert.ok(selection.all.find(m => m.code === 'KRW-T1').status.includes('가격 급등락'));
  assert.ok(!selection.watched.some(m => m.code === 'KRW-T0'));
  tickers['KRW-T3'].acc_trade_price_24h = 1;
  assert.ok(rankMarkets(catalog, tickers).all.find(m => m.code === 'KRW-T3').status.includes('10억'));
  assert.throws(() => parseMarkets([]));
});

test('dynamic candidates can paper trade, unselected signals cannot, and exits survive a catalog change', () => {
  const state = newState(NOW); state.control.running = true; state.control.startedAt = NOW;
  const candidates = [{ code: 'KRW-ADA', entryEligible: true }, { code: 'KRW-DOGE', entryEligible: false }];
  const signal = { ready: true, entry: true, score: 1, validUntil: NOW + 60000, candleAt: NOW - 60000 };
  advancePaper(state, { 'KRW-ADA': quote(), 'KRW-DOGE': quote() }, { 'KRW-ADA': signal, 'KRW-DOGE': { ...signal, score: 99 } }, NOW, candidates);
  assert.equal(state.paper.trades.length, 1); assert.equal(state.paper.trades[0].market, 'KRW-ADA');
  assert.ok(state.paper.cash >= 1000);
  closePaper(state, { 'KRW-ADA': quote() }, NOW);
  assert.equal(state.paper.trades.length, 2); assert.equal(Object.keys(state.paper.positions).length, 0);
  assert.throws(() => recordFill(state.manual, { market: 'KRW-UNKNOWN', side: 'buy', quantity: 1, price: 1, fee: 0 }, NOW));
});

test('new-symbol manual records restore and undo even when the symbol leaves the current catalog', () => {
  const state = newState(NOW), catalog = [{ code: 'KRW-ADA' }];
  applyPagesAction(state, '/api/manual', { market: 'KRW-ADA', side: 'buy', quantity: 6, price: 1000, fee: 3, reference: 'one', at: NOW }, {}, NOW, catalog);
  applyPagesAction(state, '/api/manual', { market: 'KRW-ADA', side: 'sell', quantity: 1, price: 1000, fee: .5, reference: 'two', at: NOW }, {}, NOW, []);
  assert.equal(validateSavedState(JSON.parse(JSON.stringify(state))).manual.positions['KRW-ADA'].quantity, 5);
  applyPagesAction(state, '/api/manual/undo', {}, {}, NOW, []);
  assert.equal(state.manual.positions['KRW-ADA'].quantity, 6);
  assert.equal(state.manual.trades.length, 1); assert.equal(state.paper.trades.length, 0);
});

test('stream updates replace duplicate minutes, REST cannot overwrite newer ticks, and unfinished candles stay excluded', () => {
  const boundary = Math.floor(NOW / 60000) * 60000;
  const rows = Array.from({ length: 30 }, (_, i) => ({ candle_date_time_utc: new Date(boundary - (30 - i) * 60000).toISOString().slice(0, 19), trade_price: 1000 + i, timestamp: boundary - (29 - i) * 60000 - 1 }));
  const live = { ...rows.at(-1), trade_price: 1030, timestamp: boundary };
  let merged = mergeCandles(rows, [live, { ...live, timestamp: boundary - 10, trade_price: 99999 }], NOW);
  assert.equal(merged.length, 30); assert.equal(merged.at(-1).trade_price, 1030);
  const signal = signalFromCandles(merged, NOW);
  merged = mergeCandles(merged, [{ candle_date_time_utc: new Date(boundary).toISOString().slice(0, 19), trade_price: 99999, timestamp: NOW }], NOW);
  assert.deepEqual(signalFromCandles(merged, NOW), signal);
  assert.equal(signalFromCandles(merged.filter((_, i) => i !== 20), NOW).ready, false);
});

test('REST bootstrap scheduling gives all 12 symbols a turn before refreshing any of them', () => {
  const markets = Array.from({ length: 12 }, (_, i) => ({ code: `KRW-T${i}` })), fetched = {};
  for (let i = 0; i < 12; i++) {
    const at = NOW + i * 12000, code = nextCandleMarket(markets, fetched, at);
    assert.equal(code, markets[i].code); fetched[code] = at;
  }
  assert.equal(nextCandleMarket(markets, fetched, NOW + 144000), undefined);
  assert.equal(nextCandleMarket(markets, fetched, NOW + SCANNER.refreshMs), markets[0].code);
});

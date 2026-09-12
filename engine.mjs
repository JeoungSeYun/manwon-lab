const randomUUID = () => globalThis.crypto.randomUUID();

export const MARKETS = [
  { code: 'KRW-BTC', symbol: 'BTC', name: '비트코인' },
  { code: 'KRW-ETH', symbol: 'ETH', name: '이더리움' },
  { code: 'KRW-XRP', symbol: 'XRP', name: '엑스알피' },
  { code: 'KRW-SOL', symbol: 'SOL', name: '솔라나' },
];
export const RULES = Object.freeze({
  capital: 10000, minCapital: 10000, maxCapital: 100000, investmentRatio: 0.9, lossRatio: 0.05, minOrder: 5000, feeRate: 0.0005,
  slippageRate: 0.0005, maxSpread: 0.0015, stopLoss: 0.01,
  takeProfit: 0.018, maxHoldMs: 30 * 60_000, cooldownMs: 10 * 60_000,
  maxEntriesPerDay: 5, quoteMaxAgeMs: 30_000,
  experimentMs: 24 * 60 * 60_000,
});
export const isMarketCode = market => typeof market === 'string' && /^KRW-[A-Z0-9]{1,20}$/.test(market);
const positive = value => Number.isFinite(value) && value > 0;
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const floorQty = q => Math.floor((q + 1e-14) * 1e8) / 1e8;
export const dayKey = now => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);

export function newLedger(capital = RULES.capital) {
  return { initialCapital: capital, cash: capital, positions: {}, trades: [], realizedPnl: 0, totalFees: 0 };
}
export function newState(now = Date.now()) {
  return {
    schema: 1, createdAt: now, paper: newLedger(), manual: newLedger(),
    control: { running: false, startedAt: null, locked: false, message: '모의매매 시작을 누르면 24시간 실험이 시작됩니다.', lastExitAt: 0, lastEntryCandle: {} },
    observations: [], events: [],
  };
}
export function addEvent(state, text, now = Date.now()) {
  state.events.push({ at: now, text });
  state.events = state.events.slice(-200);
}
export function isFresh(quote, now = Date.now()) {
  return !!quote && Number.isFinite(quote.at) && now - quote.at <= RULES.quoteMaxAgeMs && now - quote.at >= -5000;
}

// Only closed, continuous one-minute candles can drive a decision.
export function signalFromCandles(raw, now = Date.now()) {
  const candles = raw.map(c => ({ at: Date.parse(c.candle_date_time_utc + 'Z'), price: c.trade_price }))
    .filter(c => Number.isFinite(c.at) && positive(c.price) && c.at + 60_000 <= now)
    .sort((a, b) => a.at - b.at);
  const last = candles.at(-1);
  if (candles.length < 25 || !last || now - (last.at + 60_000) > 120_000) {
    return { ready: false, entry: false, reason: '마감된 1분봉을 수집하는 중입니다.' };
  }
  const recent = candles.slice(-25);
  if (recent.some((c, i) => i > 0 && c.at - recent[i - 1].at !== 60_000)) {
    return { ready: false, entry: false, reason: '캔들 공백이 있어 신호를 보류합니다.' };
  }
  const prices = recent.map(c => c.price);
  const fast = mean(prices.slice(-5));
  const slow = mean(prices.slice(-20));
  const momentum = last.price / prices.at(-6) - 1;
  const trend = fast / slow - 1;
  const entry = trend >= 0.0003 && momentum >= 0.0008 && momentum <= 0.008;
  return {
    ready: true, entry, exit: fast < slow, fast, slow, momentum, trend,
    candleAt: last.at, validUntil: last.at + 180_000,
    score: trend + momentum,
    reason: entry ? '이동평균과 5분 상승률 조건 충족' : momentum > 0.008 ? '5분 급등 과열 · 진입 보류' : '상승 추세 조건을 기다리는 중',
    prices: candles.slice(-40),
  };
}

// Walk displayed depth; never invent a fill when the book cannot cover it.
export function simulateFill(quote, side, amount, now = Date.now()) {
  if (!isFresh(quote, now)) throw new Error('시세가 30초 이상 지연되어 모의 체결을 보류합니다.');
  if (!positive(amount) || !['buy', 'sell'].includes(side)) throw new Error('체결 요청이 올바르지 않습니다.');
  const levels = quote.levels;
  if (!Array.isArray(levels) || !levels.length) throw new Error('호가 정보가 없습니다.');
  const slip = side === 'buy' ? 1 + RULES.slippageRate : 1 - RULES.slippageRate;
  let remaining = amount, quantity = 0, notional = 0;
  for (const level of levels) {
    const price = (side === 'buy' ? level.ask_price : level.bid_price) * slip;
    const size = side === 'buy' ? level.ask_size : level.bid_size;
    if (!positive(price) || !Number.isFinite(size) || size < 0) throw new Error('유효하지 않은 호가입니다.');
    const take = Math.min(size, side === 'buy' ? remaining / price : remaining);
    quantity += take;
    notional += take * price;
    remaining -= side === 'buy' ? take * price : take;
    if (remaining <= amount * 1e-10) break;
  }
  if (remaining > amount * 1e-9) throw new Error('호가 잔량이 부족해 모의 체결을 보류합니다.');
  if (side === 'buy') {
    const rounded = floorQty(quantity);
    notional *= rounded / quantity;
    quantity = rounded;
  }
  if (!positive(quantity)) throw new Error('체결 수량이 너무 작습니다.');
  return { quantity, notional, price: notional / quantity, fee: notional * RULES.feeRate };
}

export function recordFill(ledger, input, now = Date.now(), markets = MARKETS) {
  const { side, market, quantity, price, fee } = input;
  const known = markets.some(m => m.code === market) || (side === 'sell' && Object.hasOwn(ledger.positions, market));
  if (!isMarketCode(market) || !known || !['buy', 'sell'].includes(side)) throw new Error('종목 또는 매매 방향이 올바르지 않습니다.');
  if (!positive(quantity) || !positive(price) || !Number.isFinite(fee) || fee < 0) throw new Error('수량·가격은 양수, 수수료는 0 이상이어야 합니다.');
  const notional = quantity * price;
  if (!Number.isFinite(notional) || fee > notional) throw new Error('체결 금액 또는 수수료를 확인하세요.');
  const reference = typeof input.reference === 'string' ? input.reference.trim().slice(0, 100) : '';
  if (reference && ledger.trades.some(t => t.reference === reference)) throw new Error('이미 기록한 체결 ID입니다.');
  if (ledger.trades.length >= 10000) throw new Error('체결 기록 한도에 도달했습니다. CSV를 보관해 주세요.');
  const previous = ledger.positions[market];
  let realizedPnl = 0;
  if (side === 'buy') {
    if (notional + fee > ledger.cash + 1e-7) throw new Error('수수료를 포함하면 설정한 실험 잔액을 초과합니다.');
    ledger.cash = Math.max(0, ledger.cash - notional - fee);
    ledger.positions[market] = {
      quantity: (previous?.quantity ?? 0) + quantity,
      cost: (previous?.cost ?? 0) + notional + fee,
      openedAt: previous?.openedAt ?? now,
    };
  } else {
    if (!previous || quantity > previous.quantity + 1e-12) throw new Error('기록된 보유 수량보다 많이 매도할 수 없습니다.');
    const sold = Math.min(quantity, previous.quantity);
    const allocatedCost = previous.cost * (sold / previous.quantity);
    realizedPnl = notional - fee - allocatedCost;
    ledger.cash += notional - fee;
    const remaining = previous.quantity - sold;
    if (remaining < 1e-12) delete ledger.positions[market];
    else ledger.positions[market] = { ...previous, quantity: remaining, cost: previous.cost - allocatedCost };
    ledger.realizedPnl += realizedPnl;
  }
  ledger.totalFees += fee;
  const trade = { id: randomUUID(), reference, at: now, side, market, quantity, price, notional, fee, realizedPnl, reason: String(input.reason ?? '').slice(0, 160) };
  ledger.trades.push(trade);
  return trade;
}

export function valuation(ledger, quotes, now = Date.now()) {
  let value = ledger.cash, complete = true, stale = false, sellable = true;
  const positions = Object.entries(ledger.positions).map(([market, position]) => {
    const quote = quotes[market];
    let netValue = null;
    try {
      // Old quotes may be displayed as an explicitly stale estimate, never used for trading.
      const fill = simulateFill(quote, 'sell', position.quantity, quote?.at ?? now);
      netValue = fill.notional - fill.fee;
      sellable &&= fill.notional >= RULES.minOrder;
      value += netValue;
      stale ||= !isFresh(quote, now);
    } catch { complete = false; }
    return { market, ...position, netValue, pnl: netValue === null ? null : netValue - position.cost, stale: !isFresh(quote, now) };
  });
  return { initialCapital: ledger.initialCapital, equity: complete ? value : null, pnl: complete ? value - ledger.initialCapital : null, cash: ledger.cash, positions, complete, stale, sellable, realizedPnl: ledger.realizedPnl, totalFees: ledger.totalFees, trades: ledger.trades };
}

function paperExit(state, market, quote, reason, now) {
  const position = state.paper.positions[market];
  const fill = simulateFill(quote, 'sell', position.quantity, now);
  if (fill.notional < RULES.minOrder) throw new Error('평가금액이 최소 주문액 5,000원 미만입니다. 모의 매도 불가 상태로 보존합니다.');
  recordFill(state.paper, { side: 'sell', market, ...fill, reason }, now);
  state.control.lastExitAt = now;
  addEvent(state, `${market.slice(4)} 모의 매도 · ${reason}`, now);
}

export function closePaper(state, quotes, now = Date.now()) {
  for (const market of Object.keys(state.paper.positions)) paperExit(state, market, quotes[market], '사용자 모의 정리', now);
  state.control.running = false;
  state.control.message = '모의 보유분을 정리했습니다.';
}

export function advancePaper(state, quotes, signals, now = Date.now(), markets = MARKETS) {
  const control = state.control;
  const view = valuation(state.paper, quotes, now);
  const expired = control.startedAt !== null && now >= control.startedAt + RULES.experimentMs;
  if (expired || (view.complete && !view.stale && view.pnl <= -state.paper.initialCapital * RULES.lossRatio)) {
    control.locked = true;
    control.running = false;
    control.message = expired ? '24시간 실험 종료 · 보유분 정리' : '실험 원금 대비 손실 5% 도달 · 신규 진입 중단';
  }
  for (const [market, position] of Object.entries(state.paper.positions)) {
    const quote = quotes[market];
    if (!isFresh(quote, now)) { control.message = '시세 지연 · 모의 체결을 보류하고 있습니다.'; continue; }
    try {
      const fill = simulateFill(quote, 'sell', position.quantity, now);
      const ret = (fill.notional - fill.fee) / position.cost - 1;
      const signal = signals[market];
      const reason = control.locked ? control.message : ret <= -RULES.stopLoss ? '순손익 -1% 손절' : ret >= RULES.takeProfit ? '순손익 +1.8% 익절' : now - position.openedAt >= RULES.maxHoldMs ? '보유 30분 경과' : signal?.ready && signal.validUntil >= now && signal.exit ? '이동평균 추세 이탈' : null;
      if (reason) paperExit(state, market, quote, reason, now);
    } catch (error) { control.message = error.message; }
  }
  if (!control.running || control.locked || Object.keys(state.paper.positions).length) return;
  if (now - control.lastExitAt < RULES.cooldownMs) { control.message = '다음 진입까지 10분 대기 중입니다.'; return; }
  const entries = state.paper.trades.filter(t => t.side === 'buy' && dayKey(t.at) === dayKey(now)).length;
  if (entries >= RULES.maxEntriesPerDay) { control.message = '오늘의 신규 진입 한도 5회에 도달했습니다.'; return; }
  const candidates = markets.filter(m => m.entryEligible !== false).map(m => ({ market: m.code, signal: signals[m.code], quote: quotes[m.code] }))
    .filter(c => c.signal?.ready && c.signal.entry && c.signal.validUntil >= now && isFresh(c.quote, now) && c.quote.spread >= 0 && c.quote.spread <= RULES.maxSpread && c.signal.candleAt !== control.lastEntryCandle[c.market])
    .sort((a, b) => b.signal.score - a.signal.score);
  if (!candidates.length) { control.message = '진입 조건을 기다립니다. 조건이 없으면 거래하지 않습니다.'; return; }
  const { market, signal, quote } = candidates[0];
  try {
    const notional = Math.min(state.paper.initialCapital * RULES.investmentRatio, state.paper.cash) / (1 + RULES.feeRate);
    if (notional < RULES.minOrder) { control.running = false; control.message = '최소 주문액에 필요한 잔액이 부족합니다.'; return; }
    const fill = simulateFill(quote, 'buy', notional, now);
    if (fill.notional < RULES.minOrder) throw new Error('반올림 후 최소 주문액 미달');
    recordFill(state.paper, { side: 'buy', market, ...fill, reason: 'MA5 > MA20 · 5분 상승률 조건 충족' }, now, markets);
    control.lastEntryCandle[market] = signal.candleAt;
    control.message = `${market.slice(4)} 모의 보유 중 · 매도 조건 감시`;
    addEvent(state, `${market.slice(4)} 모의 매수 · 총 투입 ${Math.round(fill.notional + fill.fee).toLocaleString('ko-KR')}원`, now);
  } catch (error) { control.message = error.message; }
}

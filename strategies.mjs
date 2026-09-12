// Experimental, fixed rules. These values are hypotheses, not optimized profit claims.
export const STRATEGIES = Object.freeze({
  trend: Object.freeze({ id: 'trend', name: '추세 관찰', stopLoss: .01, takeProfit: .018, maxHoldMs: 30 * 60000, cooldownMs: 10 * 60000, maxEntriesPerDay: 5, maxSpread: .0015, trailingActivation: null, trailingDistance: null, maxRoundTripCost: null, maxChase: null }),
  scalp: Object.freeze({ id: 'scalp', name: '단타 돌파', stopLoss: .006, takeProfit: .012, maxHoldMs: 5 * 60000, cooldownMs: 60000, maxEntriesPerDay: 30, maxSpread: .0012, trailingActivation: .006, trailingDistance: .003, maxRoundTripCost: .0035, maxChase: .004 }),
});
export const strategyProfile = id => Object.hasOwn(STRATEGIES, id) ? STRATEGIES[id] : STRATEGIES.trend;
const mean = xs => xs.reduce((sum, x) => sum + x, 0) / xs.length;

export function adaptiveFeedback(trades, now) {
  const closed = trades.filter(t => t.side === 'sell' && t.strategy === 'scalp' && Number.isFinite(t.returnRate));
  const recent = closed.slice(-3);
  const pauseUntil = recent.length === 3 && recent.every(t => t.realizedPnl < 0) ? recent.at(-1).at + 15 * 60000 : 0;
  const markets = {};
  for (const market of new Set(closed.map(t => t.market))) {
    const sample = closed.filter(t => t.market === market).slice(-8);
    const averageReturn = mean(sample.map(t => Math.max(-.03, Math.min(.03, t.returnRate))));
    const multiplier = sample.length >= 3 ? Math.max(.65, Math.min(1.15, 1 + averageReturn * 20)) : 1;
    const lastTwo = sample.slice(-2);
    const cooldownUntil = lastTwo.length === 2 && lastTwo.every(t => t.realizedPnl < 0) ? lastTwo.at(-1).at + 20 * 60000 : 0;
    markets[market] = { market, samples: sample.length, averageReturn, multiplier, cooldownUntil, paused: cooldownUntil > now };
  }
  return { samples: closed.length, paused: pauseUntil > now, pauseUntil, markets, mode: 'bounded-feedback', description: '최근 최대 8회 청산을 반영 · 3회부터 점수 0.65~1.15배 · 종목 2연패 20분, 전체 3연패 15분 대기' };
}

export function scalpSignal(raw, now) {
  const unique = new Map();
  for (const c of raw) {
    const at = Date.parse(c.candle_date_time_utc + 'Z');
    if (!Number.isFinite(at) || at + 60000 > now) continue;
    unique.set(at, { at, price: c.trade_price, open: c.opening_price, high: c.high_price, low: c.low_price, volume: c.candle_acc_trade_volume });
  }
  const candles = [...unique.values()].sort((a, b) => a.at - b.at).slice(-25);
  const last = candles.at(-1);
  if (candles.length < 16 || !last || now - (last.at + 60000) > 65000) return { ready: false, entry: false, reason: '단타용 마감 1분봉 16개 준비 중' };
  const recent = candles.slice(-16);
  if (recent.some((c, i) => i > 0 && c.at - recent[i - 1].at !== 60000)) return { ready: false, entry: false, reason: '캔들 공백 · 단타 신호 보류' };
  if (recent.some(c => ![c.price, c.open, c.high, c.low, c.volume].every(Number.isFinite) || Math.min(c.price, c.open, c.high, c.low) <= 0 || c.volume < 0 || c.high < Math.max(c.price, c.open) || c.low > Math.min(c.price, c.open))) return { ready: false, entry: false, reason: '가격·거래량 데이터 확인 중' };
  const prior = recent.slice(0, -1), priorHigh = Math.max(...prior.slice(-5).map(c => c.high));
  const baselineVolume = mean(prior.slice(-10).map(c => c.volume));
  if (!(baselineVolume > 0)) return { ready: false, entry: false, reason: '비교 거래량 부족' };
  const volumeRatio = last.volume / baselineVolume;
  const momentum = last.price / recent.at(-4).price - 1;
  const minuteChange = last.price / recent.at(-2).price - 1;
  const breakout = last.price / priorHigh - 1;
  const closeStrength = last.high > last.low ? (last.price - last.low) / (last.high - last.low) : 0;
  const fast = mean(recent.slice(-3).map(c => c.price)), slow = mean(recent.slice(-10).map(c => c.price));
  const checks = [
    { label: '직전 5분 고점 돌파', passed: breakout >= .0001 },
    { label: '거래량 1.3배 이상', passed: volumeRatio >= 1.3 },
    { label: '3분 상승 0.15~2.5%', passed: momentum >= .0015 && momentum <= .025 },
    { label: '최근 1분 상승 0.05% 이상', passed: minuteChange >= .0005 },
    { label: '캔들 상단 35% 안에서 마감', passed: closeStrength >= .65 },
    { label: '3봉 평균 > 10봉 평균', passed: fast > slow },
  ];
  const entry = checks.every(c => c.passed);
  return { ready: true, entry, exit: fast < slow, fast, slow, trend: fast / slow - 1, momentum, momentumMinutes: 3, volumeRatio, breakout, priorHigh, lastClose: last.price, closeStrength, checks, candleAt: last.at, validUntil: last.at + 125000, score: Math.min(volumeRatio, 5) * .01 + momentum + Math.max(0, breakout), reason: entry ? '거래량 증가 · 5분 고점 돌파' : checks.filter(c => !c.passed).map(c => c.label).join(' · ') + ' 대기', prices: candles.map(c => ({ at: c.at, price: c.price })) };
}

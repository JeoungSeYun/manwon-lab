import { isMarketCode } from './engine.mjs';

export const SCANNER = Object.freeze({ limit: 12, minVolume24h: 1_000_000_000, refreshMs: 300_000, maxAgeMs: 600_000 });
const cautions = {
  PRICE_FLUCTUATIONS: '가격 급등락', TRADING_VOLUME_SOARING: '거래량 급증',
  DEPOSIT_AMOUNT_SOARING: '입금량 급증', GLOBAL_PRICE_DIFFERENCES: '국내외 가격차',
  CONCENTRATION_OF_SMALL_ACCOUNTS: '소수 계정 거래 집중',
};

export function parseMarkets(raw) {
  if (!Array.isArray(raw)) throw new Error('원화 종목 목록 형식 오류');
  const unique = new Map();
  for (const m of raw) {
    if (!isMarketCode(m.market)) continue;
    const reasons = [];
    const event = m.market_event;
    if (!event || typeof event.warning !== 'boolean' || !event.caution ||
      Object.keys(cautions).some(key => typeof event.caution[key] !== 'boolean')) reasons.push('시장경보 정보 미확인');
    if (event?.warning === true || m.market_warning === 'CAUTION') reasons.push('투자유의');
    for (const [key, active] of Object.entries(event?.caution || {})) if (active === true) reasons.push(cautions[key] || '시장 주의');
    unique.set(m.market, { code: m.market, symbol: m.market.slice(4), name: String(m.korean_name || m.market.slice(4)).slice(0, 80), reasons });
  }
  if (!unique.size) throw new Error('조회 가능한 원화 종목이 없습니다.');
  return [...unique.values()];
}

export function rankMarkets(catalog, tickers, heldCodes = [], strategy = 'trend') {
  const ranked = catalog.map(m => {
    const t = tickers[m.code], volume24h = t?.acc_trade_price_24h;
    const reasons = [...m.reasons];
    if (!Number.isFinite(volume24h) || !(t?.trade_price > 0)) reasons.push('거래대금 정보 미확인');
    else if (volume24h < SCANNER.minVolume24h) reasons.push('24시간 거래대금 10억 원 미만');
    const dayRange = Number.isFinite(t?.high_price) && Number.isFinite(t?.low_price) && t.low_price > 0 && t.high_price >= t.low_price ? (t.high_price - t.low_price) / t.low_price : 0;
    return { ...m, reasons, dayRange, volume24h: Number.isFinite(volume24h) ? volume24h : 0, price: t?.trade_price ?? null, change: t?.signed_change_rate ?? null };
  }).sort((a, b) => b.volume24h - a.volume24h || a.code.localeCompare(b.code));
  const pool = ranked.filter(m => !m.reasons.length).slice(0, strategy === 'scalp' ? 60 : ranked.length);
  const liquidCore = strategy === 'scalp' ? pool.slice(0, 6).map(m => m.code) : [];
  if (strategy === 'scalp') {
    const largest = pool[0]?.volume24h || 1;
    for (const m of pool) m.selectionScore = .45 * Math.log1p(m.volume24h) / Math.log1p(largest) + .55 * Math.min(m.dayRange / .15, 1);
    pool.sort((a, b) => b.selectionScore - a.selectionScore || b.volume24h - a.volume24h);
  }
  const selected = new Set(liquidCore);
  for (const m of pool) { if (selected.size >= SCANNER.limit) break; selected.add(m.code); }
  const held = new Set(heldCodes.filter(isMarketCode));
  const all = ranked.map(m => ({ ...m, selected: selected.has(m.code), held: held.has(m.code), entryEligible: selected.has(m.code), status: m.reasons.length ? m.reasons.join(' · ') : selected.has(m.code) ? '정밀 관찰' : strategy === 'scalp' ? '단타 후보 순위 대기' : '거래대금 순위 대기' }));
  const watched = all.filter(m => m.selected || m.held);
  for (const code of held) if (!all.some(m => m.code === code)) watched.push({ code, symbol: code.slice(4), name: code.slice(4), selected: false, held: true, entryEligible: false, reasons: ['현재 원화 목록에 없음'], status: '보유 기록 · 현재 원화 목록에 없음' });
  return { all, watched, selected: selected.size, eligible: ranked.filter(m => !m.reasons.length).length, excluded: ranked.filter(m => m.reasons.length).length };
}

// Upbit updates the same minute repeatedly. Keep its newest version; never fill missing minutes.
export function mergeCandles(existing, incoming, now = Date.now()) {
  const byMinute = new Map();
  for (const candle of [...existing, ...incoming]) {
    const at = Date.parse(candle.candle_date_time_utc + 'Z');
    if (!Number.isFinite(at) || at > now + 60_000 || !Number.isFinite(candle.trade_price) || candle.trade_price <= 0) continue;
    const previous = byMinute.get(at);
    if (!previous || (candle.timestamp ?? at) >= (previous.timestamp ?? at)) byMinute.set(at, candle);
  }
  return [...byMinute.entries()].sort((a, b) => a[0] - b[0]).slice(-90).map(([, candle]) => candle);
}

export function nextCandleMarket(markets, fetched, now) {
  return markets.filter(m => !fetched[m.code] || now - fetched[m.code] >= SCANNER.refreshMs)
    .sort((a, b) => (fetched[a.code] || 0) - (fetched[b.code] || 0))[0]?.code;
}

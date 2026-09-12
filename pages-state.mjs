import { MARKETS, RULES, STRATEGIES, setStrategy, newLedger, addEvent, recordFill, closePaper, isFresh, isMarketCode } from './engine.mjs';

export function validateSavedState(state) {
  if (state?.schema !== 1 || !state.control || !Array.isArray(state.observations) || !Array.isArray(state.events)) throw new Error('저장된 장부 형식을 확인할 수 없습니다. 기존 기록을 보존했습니다.');
  if (state.control.strategy !== undefined && !Object.hasOwn(STRATEGIES, state.control.strategy)) throw new Error('저장된 전략 설정을 확인할 수 없습니다.');
  for (const ledger of [state.paper, state.manual]) {
    if (!ledger || !Number.isInteger(ledger.initialCapital) || ledger.initialCapital < RULES.minCapital || ledger.initialCapital > RULES.maxCapital || !Number.isFinite(ledger.cash) || ledger.cash < 0 || !Array.isArray(ledger.trades) || !ledger.positions || !Number.isFinite(ledger.realizedPnl) || !Number.isFinite(ledger.totalFees)) throw new Error('저장된 장부의 금액이 올바르지 않습니다. 기존 기록을 보존했습니다.');
    for (const [code, p] of Object.entries(ledger.positions)) if (!isMarketCode(code) || !(p.quantity > 0) || !Number.isFinite(p.quantity) || !(p.cost > 0) || !Number.isFinite(p.cost) || !Number.isFinite(p.openedAt) || (p.strategy !== undefined && !Object.hasOwn(STRATEGIES, p.strategy)) || (p.peakNetReturn !== undefined && !Number.isFinite(p.peakNetReturn))) throw new Error('저장된 보유 기록을 확인할 수 없습니다.');
  }
  return state;
}

export function applyPagesAction(state, endpoint, body, quotes, now, markets = MARKETS) {
  if (endpoint === '/api/capital') {
    const capital = Number(body.capital);
    if (!Number.isInteger(capital) || capital < RULES.minCapital || capital > RULES.maxCapital || capital % 1000 !== 0) throw new Error('실험 원금은 1만~10만 원 사이, 1,000원 단위로 설정하세요.');
    if (state.capitalLocked || state.control.startedAt || state.paper.trades.length || state.manual.trades.length) throw new Error('실험 시작 후 원금을 변경할 수 없습니다.');
    state.paper = newLedger(capital); state.manual = newLedger(capital);
    state.observations = [{ at: now, paper: capital, manual: capital }];
    addEvent(state, `실험 원금 ${capital.toLocaleString('ko-KR')}원으로 설정`, now);
  } else if (endpoint === '/api/strategy') {
    setStrategy(state, body.strategy, now);
  } else if (endpoint === '/api/control') {
    if (body.action === 'start') {
      if (state.control.locked || (state.control.startedAt && now >= state.control.startedAt + RULES.experimentMs)) throw new Error('이 24시간 실험은 종료되었습니다.');
      if (!Object.values(quotes).some(q => isFresh(q, now))) throw new Error('실시간 시세를 연결한 후 시작할 수 있습니다.');
      state.control.running = true; state.control.startedAt ??= now; state.capitalLocked = true;
      state.control.message = '진입 조건을 기다리는 중입니다.';
      addEvent(state, '브라우저 자동 모의매매 시작 · 실제 주문 없음', now);
    } else if (body.action === 'pause') {
      state.control.running = false;
      state.control.message = '신규 진입 일시정지 · 보유분의 매도 조건은 감시합니다.';
      addEvent(state, '신규 모의 진입 일시정지', now);
    } else if (body.action === 'close') closePaper(state, quotes, now);
    else throw new Error('지원하지 않는 동작입니다.');
  } else if (endpoint === '/api/manual') {
    const at = Number(body.at);
    if (!Number.isFinite(at) || at < state.createdAt - 365 * 86400_000 || at > now + 60_000) throw new Error('체결 시각을 확인하세요.');
    if (state.manual.trades.length && at < state.manual.trades.at(-1).at) throw new Error('오래된 체결부터 시간순으로 입력하세요.');
    if (typeof body.reference !== 'string' || !body.reference.trim()) throw new Error('체결 입력 ID가 필요합니다.');
    recordFill(state.manual, { ...body, quantity: Number(body.quantity), price: Number(body.price), fee: Number(body.fee), reason: '사용자 입력 실거래 · 거래소 자동 대조 없음' }, at, markets);
    state.capitalLocked = true;
    addEvent(state, `${body.market.slice(4)} 실거래 체결 기록`, now);
  } else if (endpoint === '/api/manual/undo') {
    const removed = state.manual.trades.at(-1);
    if (!removed) throw new Error('취소할 입력이 없습니다.');
    const ledger = newLedger(state.manual.initialCapital);
    const historicalMarkets = [...new Set(state.manual.trades.map(t => t.market))].map(code => ({ code }));
    for (const trade of state.manual.trades.slice(0, -1)) recordFill(ledger, trade, trade.at, historicalMarkets).id = trade.id;
    state.manual = ledger; state.corrections ??= []; state.corrections.push({ at: now, removed });
    addEvent(state, '마지막 입력 취소 · 실제 주문에는 영향 없음', now);
  } else throw new Error('지원하지 않는 동작입니다.');
}

export function tradesCsv(ledger, mode) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+@\t\r]/.test(text) || (text.startsWith('-') && !Number.isFinite(Number(text)))) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const header = ['구분', '시각', '종목', '매매', '수량', '체결가', '거래금액', '수수료', '실현손익', '체결ID', '전략', '체결사유'];
  const rows = ledger.trades.map(t => [mode === 'manual' ? '사용자 입력 실거래' : '모의거래', new Date(t.at).toISOString(), t.market, t.side, t.quantity, t.price, t.notional, t.fee, t.realizedPnl, t.reference, mode === 'manual' ? '수동 기록' : STRATEGIES[t.strategy || 'trend']?.name || '미확인', t.reason]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

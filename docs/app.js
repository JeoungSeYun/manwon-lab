const $ = id => document.getElementById(id);
const pagesMode = document.querySelector('meta[name="lab-runtime"]')?.content === 'browser';
const pages = pagesMode ? new (await import('./browser-runtime.mjs')).BrowserRuntime() : null;
let state = null, mode = 'paper', busy = false, disconnected = false, toastTimer;
const won = (v, decimals = 0) => v === null || !Number.isFinite(v) ? '—' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
const signed = (v, decimals = 0) => v === null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + won(Math.abs(v), decimals);
const clock = at => at ? new Date(at).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const shortClock = at => at ? new Date(at).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—';
const date = at => new Date(at).toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' });
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function tone(element, value) { element.classList.toggle('positive', value > 0); element.classList.toggle('negative', value < 0); }
function toast(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
}
function defaultTime() {
  const now = new Date();
  $('fill-form').elements.at.value = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function render() {
  if (!state) return;
  const ledger = state[mode], manual = mode === 'manual', control = state.control;
  const scalp = (control.strategy || 'trend') === 'scalp';
  $('tab-paper').classList.toggle('active', !manual); $('tab-paper').setAttribute('aria-selected', String(!manual));
  $('tab-manual').classList.toggle('active', manual); $('tab-manual').setAttribute('aria-selected', String(manual));
  $('mode-description').textContent = manual ? '사용자 입력 체결 · 거래소 자동 대조 없음' : '실시간 시세 · 가상 자금 · 실제 주문 없음';
  $('notice').textContent = manual ? '직접 거래한 체결만 기록하세요. 실현손익은 입력 기준, 보유분은 시세 추정입니다. 실거래에는 이 도구의 자동 손절·중단 규칙이 적용되지 않습니다.' : '업비트의 실제 호가로 가상 체결을 계산합니다. 이 화면의 모의 수익은 실제 수익이 아닙니다.';
  $('notice').classList.toggle('manual', manual);
  $('valuation-tag').textContent = manual ? '수동 기록' : '모의';
  $('equity').textContent = '₩' + won(ledger.equity);
  $('capital-label').textContent = `실험 원금 ₩${won(ledger.initialCapital)}${ledger.stale ? ' · 이전 시세 기준' : !ledger.complete ? ' · 보유분 시세 대기' : ''}`;
  $('pnl').textContent = signed(ledger.pnl) + (ledger.pnl === null ? '' : '원'); tone($('pnl'), ledger.pnl);
  $('return-rate').textContent = ledger.pnl === null ? '평가에 필요한 시세를 기다립니다.' : `${signed(ledger.pnl / ledger.initialCapital * 100, 3)}% · 예상 매도비용 반영`;
  $('realized').textContent = signed(ledger.realizedPnl, 2) + '원'; tone($('realized'), ledger.realizedPnl);
  const sales = ledger.trades.filter(t => t.side === 'sell');
  $('trade-count').textContent = `매도 ${sales.length}건 · 매수 ${ledger.trades.length - sales.length}건`;
  $('fees').textContent = won(ledger.totalFees, 2) + '원';
  $('fees-detail').textContent = manual ? '사용자가 입력한 실제 수수료 합계' : '모의 수수료 편도 0.05% 가정';
  $('chart-legend').textContent = manual ? '입력 장부 평가액' : '모의 평가액';
  $('chart-caption').textContent = manual ? '입력 장부를 평가한 시점 · 과거 수익을 소급 생성하지 않습니다.' : pages ? '실제 수집한 시점만 표시 · 페이지가 닫혀 있으면 기록되지 않습니다.' : '실제 수집한 시점만 표시 · 서버 종료 중에는 기록되지 않습니다.';
  $('cash-label').textContent = `대기 현금 ₩${won(ledger.cash, 2)}`;
  $('positions').innerHTML = ledger.positions.length ? ledger.positions.map(p => `<div class="position-row"><div><strong>${esc(p.market.slice(4))}</strong><small>${won(p.quantity, 8)}개</small></div><div><strong>₩${won(p.netValue, 2)}</strong><small>예상 매도비용 차감${p.stale ? ' · 시세 지연' : ''}</small></div><div><strong class="${p.pnl > 0 ? 'positive' : p.pnl < 0 ? 'negative' : ''}">${signed(p.pnl, 2)}원</strong><small>원가 ₩${won(p.cost, 2)}${p.netValue !== null && p.netValue < 5000 ? ' · 최소 주문액 미달 가능' : ''}</small></div></div>`).join('') : '<div class="position-empty">보유 중인 코인이 없습니다. 현금으로 대기 중입니다.</div>';
  $('market-cards').innerHTML = state.markets.map(m => {
    const q = m.quote, s = m.signal, fresh = q && state.now - q.at <= state.rules.quoteMaxAgeMs && !disconnected;
    const ready = s.ready && s.validUntil >= state.now && fresh;
    const feedback = scalp ? state.feedback?.markets[m.code] : null;
    const paused = scalp && (state.feedback?.paused || feedback?.paused);
    const entry = !paused && m.entryEligible !== false && !state.universe?.entryPaused && ready && s.entry && q.spread <= state.rules.maxSpread;
    const label = m.entryEligible === false ? '보유분 감시' : !fresh ? '시세 대기' : paused ? '연속 손실 대기' : state.universe?.entryPaused ? '후보 정보 확인 중' : !ready ? '신호 대기' : entry ? '진입 후보 · 비용 확인' : q.spread > state.rules.maxSpread ? '호가 간격 초과' : '관찰 중';
    const icon = {BTC:'₿',ETH:'Ξ',XRP:'×',SOL:'≋'}[m.symbol] || m.symbol.slice(0, 2);
    return `<article class="market-card"><div class="coin-header"><span class="coin-icon ${esc(m.symbol)}">${esc(icon)}</span><div><div class="coin-symbol">${esc(m.symbol)}</div><div class="coin-name">${esc(m.name)}</div></div></div><div class="coin-price">₩${q ? won(q.price, q.price < 100 ? 2 : 0) : '—'}</div><div class="coin-change ${q?.change > 0 ? 'positive' : q?.change < 0 ? 'negative' : ''}">${q ? signed(q.change * 100, 2) + '%' : '—'} <span>전일 대비</span></div><div class="coin-signal ${entry ? 'ready' : ''}" title="${esc(m.entryEligible === false ? m.status : s.reason)}">${label}</div><div class="coin-detail">호가 간격 ${q ? won(q.spread * 100, 3) + '%' : '—'}<br>${scalp ? '3' : '5'}분 변화 ${ready ? signed(s.momentum * 100, 3) + '%' : '—'}${scalp ? '<br>거래량 ' + (ready ? won(s.volumeRatio, 2) + '배' : '준비 중') + '<br>피드백 ×' + won(feedback?.multiplier ?? 1, 2) + ' · ' + (feedback?.samples ?? 0) + '회' : ''}${Number.isFinite(m.volume24h) ? '<br>24h 거래대금 ' + won(m.volume24h / 100000000, 1) + '억 원' : ''}</div>${scalp && s.checks ? '<div class="signal-checks">' + s.checks.map(c => `<span class="${c.passed ? 'positive' : ''}">${c.passed ? '✓' : '·'} ${esc(c.label)}</span>`).join('') + '</div>' : ''}</article>`;
  }).join('') || `<div class="market-loading">${state.universe?.updatedAt ? '현재 필터를 통과한 관찰 종목이 없습니다. 다음 목록 갱신을 기다립니다.' : '업비트 원화 종목과 거래대금을 조회하는 중입니다.'}</div>`;
  const universe = state.universe;
  $('market-count').textContent = universe ? `원화 ${universe.total}개 조회 · ${universe.selected}개 정밀 관찰` : `${state.markets.length}개 원화 마켓`;
  $('scanner-summary').textContent = universe ? `${universe.updatedAt ? (universe.selectionLabel || '거래대금') + ' 기준 ' + universe.selected + '개 · 신호 준비 ' + universe.ready + '/' + universe.selected + ' · 필터 제외 ' + universe.excluded + '개 · ' + clock(universe.updatedAt) + ' 선정' : '전체 원화 종목의 투자유의·주의 여부와 24시간 거래대금을 확인합니다.'} / 5분마다 재선정 · 거래대금 10억 원 이상 · 처음 약 3분 준비` : '마감된 1분봉과 실시간 호가로 진입 조건을 관찰합니다.';
  $('market-directory').hidden = !universe;
  if (universe && $('market-directory').open) renderDirectory();
  const manualMarkets = [...new Map([...(universe?.all || state.markets), ...state.markets].map(m => [m.code, m])).values()];
  const select = $('fill-form').elements.market, optionsKey = manualMarkets.map(m => m.code).sort().join(',');
  if (select.dataset.optionsKey !== optionsKey && manualMarkets.length) {
    const selected = select.value;
    select.innerHTML = manualMarkets.sort((a, b) => a.symbol.localeCompare(b.symbol)).map(m => `<option value="${esc(m.code)}">${esc(m.name)} ${esc(m.symbol)}</option>`).join('');
    if (manualMarkets.some(m => m.code === selected)) select.value = selected;
    select.dataset.optionsKey = optionsKey;
  }
  $('manual-panel').hidden = !manual;
  $('control-panel').hidden = manual;
  $('export').href = pages ? '#export' : '/api/export?mode=' + mode;
  $('journal-count').textContent = ledger.trades.length + '건';
  $('trades-empty').hidden = ledger.trades.length > 0;
  $('trades-empty-copy').textContent = manual ? '업비트에서 직접 거래한 체결 내역을 위 양식에 입력해 주세요.' : '조건이 맞을 때만 진입합니다. 기다리는 시간도 실험의 일부입니다.';
  $('trades').innerHTML = [...ledger.trades].reverse().slice(0, 100).map(t => `<tr title="${esc(t.reason)}"><td>${clock(t.at)}<small>${date(t.at)}</small></td><td>${esc(t.market.slice(4))}<span class="trade-side ${t.side}">${t.side === 'buy' ? '매수' : '매도'}</span><small>${won(t.quantity, 8)}개</small></td><td class="numeric">${won(t.notional, 2)}원<small>@ ${won(t.price, 2)}</small></td><td class="numeric">${won(t.fee, 2)}</td><td class="numeric ${t.realizedPnl > 0 ? 'positive' : t.realizedPnl < 0 ? 'negative' : ''}">${t.side === 'sell' ? signed(t.realizedPnl, 2) : '—'}</td></tr>`).join('');
  $('rule-budget').textContent = won(ledger.initialCapital * state.rules.investmentRatio) + '원';
  $('rule-loss').textContent = '−' + won(ledger.initialCapital * state.rules.lossRatio) + '원 (5%)';
  renderStrategy(manual, scalp);
  if (document.activeElement !== $('capital-input') && !$('capital-input').dataset.dirty) $('capital-input').value = ledger.initialCapital;
  for (const el of $('capital-form').elements) el.disabled = !state.capitalEditable || busy;
  document.querySelectorAll('[data-capital]').forEach(b => b.classList.toggle('selected', Number(b.dataset.capital) === Number($('capital-input').value)));
  $('capital-help').textContent = state.capitalEditable ? '가상 자금과 수동 장부의 기준액입니다. 입금이나 출금은 발생하지 않습니다.' : '실험이 시작되어 원금을 고정했습니다. 수익률 계산의 기준을 유지합니다.';
  $('run-status').textContent = control.locked ? '종료' : control.running ? '실행 중' : control.startedAt ? '일시정지' : '대기';
  $('run-status').classList.toggle('running', control.running);
  $('run-message').textContent = control.message;
  $('run-button').textContent = control.running ? '신규 진입 일시정지  Ⅱ' : control.startedAt ? '모의매매 재개  →' : '모의매매 시작  →';
  $('run-button').disabled = busy || disconnected || state.readOnly || control.locked || (!control.running && (!state.feed.ok || Number($('capital-input').value) !== ledger.initialCapital || $('strategy-select').value !== (control.strategy || 'trend')));
  $('close-button').disabled = busy || disconnected || state.readOnly || !state.paper.positions.length || !state.feed.ok;
  $('undo').disabled = busy || disconnected || state.readOnly || !state.manual.trades.length;
  $('fill-form').querySelector('button[type="submit"]').disabled = busy || disconnected || state.readOnly;
  $('events').innerHTML = state.events.length ? [...state.events].reverse().slice(0, 7).map(e => `<div class="event"><time>${date(e.at)} ${clock(e.at)}</time><p>${esc(e.text)}</p></div>`).join('') : '<p class="help">시작 전입니다. 실험을 시작하면 실행 기록이 남습니다.</p>';
  renderConnection(); renderCountdown(); drawChart();
}

function renderStrategy(manual, scalp) {
  const rules = state.rules, control = state.control, select = $('strategy-select');
  if (!select.dataset.dirty) select.value = control.strategy || 'trend';
  const editable = !!state.strategies && !state.readOnly && !state.paper.positions.length && !control.locked && !busy && !disconnected;
  for (const element of $('strategy-form').elements) element.disabled = !editable;
  $('strategy-title').textContent = (rules.name || '추세 관찰') + ' · 모의';
  $('strategy-help').textContent = state.paper.positions.length ? '모의 보유분을 정리하면 전략을 변경할 수 있습니다.' : control.locked ? '종료된 실험의 기록을 보존합니다.' : '적용 후 시작·재개를 누르세요. 기존 거래·남은 시간·원금은 유지됩니다.';
  $('strategy-description').textContent = scalp ? '1분봉 거래량 증가와 고점 돌파를 포착합니다. 잦은 매매의 비용과 손실을 함께 기록합니다.' : '이동평균과 5분 상승률을 사용하는 추세 규칙입니다. 수익 안정성이 검증된 전략은 아닙니다.';
  $('rule-exit').textContent = `−${won(rules.stopLoss * 100, 1)}% / +${won(rules.takeProfit * 100, 1)}%`;
  $('rule-trailing').textContent = scalp ? '+0.6%부터 · 고점 −0.3%p' : '사용 안 함';
  $('rule-timing').textContent = `${rules.maxHoldMs / 60000}분 / ${rules.cooldownMs / 60000}분`;
  $('rule-entries').textContent = `최대 ${rules.maxEntriesPerDay}회 · KST`;
  $('strategy-conditions').textContent = scalp ? '연속 마감 1분봉 16개가 필요합니다. 직전 5분 고점보다 0.01% 이상 높은 종가, 직전 10분 평균 대비 거래량 1.3배, 3분 상승 0.15~2.5%, 최근 1분 상승 0.05% 이상, 캔들 상단 35% 마감, 3봉 평균 > 10봉 평균이 진입 조건입니다. 호가 간격 0.12%, 예상 왕복 비용 0.35%를 넘으면 대기합니다. 신호 뒤 0.4% 넘게 오른 가격은 추격하지 않습니다.' : '마감 1분봉 25개가 연속으로 있어야 합니다. 5봉 평균이 20봉 평균보다 0.03% 이상 높고, 최근 5분 상승률이 0.08~0.8%이며, 호가 간격이 0.15% 이하일 때 진입합니다.';
  $('performance-panel').hidden = manual || !state.performance;
  $('performance-cards').innerHTML = (state.performance || []).map(p => `<article><strong>${esc(p.name)}</strong><div class="performance-pnl ${p.netPnl > 0 ? 'positive' : p.netPnl < 0 ? 'negative' : ''}">${signed(p.netPnl, 2)}원</div><p>청산 ${p.closed}회 · 승률 ${p.winRate === null ? '—' : won(p.winRate * 100, 1) + '%'}</p><p>평균 순손익 ${p.averageNet === null ? '—' : signed(p.averageNet, 2) + '원'}<br>누적 수수료 ${won(p.fees, 2)}원</p></article>`).join('');
  $('feedback-panel').hidden = manual || !state.feedback;
  const feedback = state.feedback;
  if (feedback) {
    $('feedback-summary').textContent = !scalp ? '단타 모드에서 적용됩니다. 아래 기록은 기존 단타 청산 결과입니다.' : feedback.paused ? `3회 연속 손실 · 신규 진입 ${Math.max(0, Math.ceil((feedback.pauseUntil - state.now) / 60000))}분 대기` : `단타 청산 ${feedback.samples}회 반영 · 종목별 3회부터 후보 점수를 조정합니다.`;
    const records = Object.values(feedback.markets);
    $('feedback-markets').innerHTML = records.length ? records.map(f => `<div><strong>${esc(f.market.slice(4))}</strong><span>×${won(f.multiplier, 2)} · ${f.samples}회${f.paused ? ' · ' + Math.ceil((f.cooldownUntil - state.now) / 60000) + '분 대기' : ''}</span></div>`).join('') : '<p class="help">완료된 단타 기록이 없습니다. 아직 점수 보정은 적용되지 않았습니다.</p>';
  }
}

function renderDirectory() {
  const query = $('market-search').value.trim().toLocaleLowerCase();
  const rows = (state?.universe?.all || []).filter(m => `${m.name} ${m.symbol}`.toLocaleLowerCase().includes(query));
  $('directory-count').textContent = `${rows.length}개 · 현재가와 거래대금은 목록 조회 시점 기준입니다. 정밀 관찰 카드의 시세는 실시간입니다.`;
  $('directory-rows').innerHTML = rows.map(m => `<tr><td>${esc(m.symbol)}<small>${esc(m.name)}</small></td><td class="numeric">₩${won(m.price, m.price < 100 ? 2 : 0)}</td><td class="numeric">${won(m.volume24h / 100000000, 1)}억 원</td><td class="${m.selected ? 'positive' : ''}">${esc(m.status)}</td></tr>`).join('') || '<tr><td colspan="4">검색 결과가 없습니다.</td></tr>';
}

function renderConnection() {
  const ok = state?.feed.ok && !disconnected;
  $('connection').classList.toggle('ok', !!ok);
  $('connection').querySelector('span').textContent = disconnected ? '서버 연결 끊김' : ok ? `UPBIT LIVE · ${clock(state.feed.lastSuccess)}` : '시세 연결 대기';
  const error = disconnected ? '로컬 서버에 연결할 수 없습니다. 화면은 마지막 수신 상태입니다. 서버를 다시 실행해 주세요.' : state?.feed.storageError || state?.feed.error || '';
  $('error-banner').textContent = error;
  $('error-banner').hidden = !error;
}
function renderCountdown() {
  if (!state) return;
  const remaining = state.control.startedAt ? Math.max(0, state.control.startedAt + state.rules.experimentMs - Date.now() - (state.feed.clockOffsetMs || 0)) : state.rules.experimentMs;
  const sec = Math.floor(remaining / 1000);
  $('countdown').textContent = [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map(v => String(v).padStart(2, '0')).join(':');
}

function drawChart() {
  if (!state) return;
  const canvas = $('chart'), box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const w = box.width, h = box.height, padding = { left: 13, right: 69, top: 22, bottom: 16 };
  const capital = state[mode].initialCapital;
  const records = state.observations.filter(p => Number.isFinite(p.at));
  const numbers = records.map(p => p[mode]).filter(Number.isFinite);
  const lo = Math.min(capital, ...numbers), hi = Math.max(capital, ...numbers);
  const margin = Math.max(capital * .003, (hi - lo) * .25);
  const min = lo - margin, max = hi + margin;
  const start = records[0]?.at ?? Date.now(), end = Math.max(records.at(-1)?.at ?? start, start + 60_000);
  const x = at => padding.left + (at - start) / (end - start) * (w - padding.left - padding.right);
  const y = val => padding.top + (max - val) / (max - min) * (h - padding.top - padding.bottom);
  ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let i = 0; i < 5; i++) {
    const val = min + (max - min) * i / 4, yy = y(val);
    ctx.strokeStyle = '#30362f'; ctx.lineWidth = .7; ctx.beginPath(); ctx.moveTo(padding.left, yy); ctx.lineTo(w - padding.right + 7, yy); ctx.stroke();
    ctx.fillStyle = '#818d79'; ctx.fillText(won(val), w - padding.right + 15, yy);
  }
  ctx.setLineDash([4, 5]); ctx.strokeStyle = '#758b64'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padding.left, y(capital)); ctx.lineTo(w - padding.right, y(capital)); ctx.stroke(); ctx.setLineDash([]);
  $('chart-empty').hidden = records.length > 1;
  $('chart-empty').textContent = records.length === 1 ? '첫 관측을 기록했습니다. 다음 갱신을 기다립니다.' : '시세를 연결하면 실험 기록이 쌓입니다.';
  if (numbers.length) {
    ctx.strokeStyle = '#b7f179'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    let segment = [];
    const paint = () => {
      if (!segment.length) return;
      ctx.beginPath(); segment.forEach((p, i) => { if (i) ctx.lineTo(x(p.at), y(p[mode])); else ctx.moveTo(x(p.at), y(p[mode])); }); ctx.stroke();
      ctx.lineTo(x(segment.at(-1).at), h - padding.bottom); ctx.lineTo(x(segment[0].at), h - padding.bottom); ctx.closePath();
      const gradient = ctx.createLinearGradient(0, padding.top, 0, h); gradient.addColorStop(0, '#b7f17922'); gradient.addColorStop(1, '#b7f17900'); ctx.fillStyle = gradient; ctx.fill();
      segment = [];
    };
    let previous;
    for (const point of records) {
      if (!Number.isFinite(point[mode]) || (previous && point.at - previous.at > 90_000)) paint();
      if (Number.isFinite(point[mode])) segment.push(point);
      previous = point;
    }
    paint();
    const last = records.at(-1);
    if (Number.isFinite(last[mode])) { ctx.fillStyle = '#b7f179'; ctx.beginPath(); ctx.arc(x(last.at), y(last[mode]), 3.4, 0, Math.PI * 2); ctx.fill(); }
  }
  $('chart-start').textContent = records.length ? shortClock(start) : '—';
  $('chart-end').textContent = records.length ? shortClock(records.at(-1).at) : '—';
}

async function load() {
  try {
    if (pages) state = pages.snapshot();
    else {
      const response = await fetch('/api/state', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('서버 응답 오류');
      state = await response.json();
    }
    disconnected = false; render();
  } catch {
    disconnected = true; renderConnection();
    $('run-button').disabled = true; $('close-button').disabled = true;
  } finally { setTimeout(load, 3000); }
}
async function post(endpoint, payload) {
  if (busy || !state) return false;
  busy = true; render();
  try {
    if (pages) { state = pages.action(endpoint, payload); return true; }
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lab-Token': state.token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '요청 실패');
    state = body; disconnected = false; return true;
  } catch (error) { toast(error.message, true); return false; }
  finally { busy = false; render(); }
}
function setMode(next) { mode = next; render(); }
$('tab-paper').addEventListener('click', () => setMode('paper'));
$('tab-manual').addEventListener('click', () => setMode('manual'));
$('run-button').addEventListener('click', async () => {
  const action = state.control.running ? 'pause' : 'start';
  if (await post('/api/control', { action })) toast(action === 'start' ? '자동 모의매매를 시작했습니다. 실제 주문은 없습니다.' : '신규 진입을 멈췄습니다. 기존 모의 보유분은 계속 감시합니다.');
});
$('close-button').addEventListener('click', async () => {
  if (await post('/api/control', { action: 'close' })) toast('모의 보유분을 정리했습니다.');
});
$('capital-input').addEventListener('input', () => { $('capital-input').dataset.dirty = 'true'; render(); });
document.querySelectorAll('[data-capital]').forEach(button => button.addEventListener('click', () => {
  $('capital-input').value = button.dataset.capital; $('capital-input').dataset.dirty = 'true'; render();
}));
$('capital-form').addEventListener('submit', async e => {
  e.preventDefault(); const capital = Number($('capital-input').value);
  if (await post('/api/capital', { capital })) { delete $('capital-input').dataset.dirty; render(); toast(`실험 원금을 ${won(capital)}원으로 설정했습니다.`); }
});
$('strategy-select').addEventListener('change', () => { $('strategy-select').dataset.dirty = 'true'; render(); });
$('strategy-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (await post('/api/strategy', { strategy: $('strategy-select').value })) {
    delete $('strategy-select').dataset.dirty; render(); toast('전략을 적용했습니다. 모의매매 시작·재개를 눌러 실행하세요.');
  }
});
function renderFormEstimate() {
  const fields = $('fill-form').elements;
  const notional = Number(fields.price.value) * Number(fields.quantity.value), fee = Number(fields.fee.value);
  const total = fields.side.value === 'buy' ? notional + fee : notional - fee;
  $('form-estimate').textContent = notional > 0 ? `${fields.side.value === 'buy' ? '기록할 총 지출' : '기록할 순입금'} ${won(total, 2)}원 · 거래금액 ${won(notional, 2)}원 ${fields.side.value === 'buy' ? '+' : '−'} 수수료 ${won(fee, 2)}원` : '가격과 수량을 입력하면 기록할 금액을 확인할 수 있습니다.';
}
$('fill-form').addEventListener('input', () => { delete $('fill-form').dataset.submissionId; renderFormEstimate(); });
$('fill-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fields = $('fill-form').elements;
  $('fill-form').dataset.submissionId ||= crypto.randomUUID();
  const payload = { market: fields.market.value, side: fields.side.value, quantity: Number(fields.quantity.value), price: Number(fields.price.value), fee: Number(fields.fee.value), at: new Date(fields.at.value).getTime(), reference: fields.reference.value.trim() || $('fill-form').dataset.submissionId };
  if (await post('/api/manual', payload)) {
    $('fill-form').reset(); delete $('fill-form').dataset.submissionId; defaultTime(); renderFormEstimate(); toast('입력한 실거래 체결을 저장했습니다.');
  }
});
$('undo').addEventListener('click', async () => {
  if (!confirm('마지막 실거래 입력을 장부에서 취소할까요? 업비트의 실제 주문은 취소되지 않습니다.')) return;
  if (await post('/api/manual/undo', {})) toast('마지막 입력을 취소했습니다. 수정 이력은 보관됩니다.');
});
window.addEventListener('resize', drawChart);
$('market-directory').addEventListener('toggle', () => { if ($('market-directory').open) renderDirectory(); });
$('market-search').addEventListener('input', renderDirectory);
if (pages) $('export').addEventListener('click', e => { e.preventDefault(); pages.download(mode); });
setInterval(renderCountdown, 1000);
defaultTime(); load();

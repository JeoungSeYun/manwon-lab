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
    const entry = ready && s.entry && q.spread <= state.rules.maxSpread;
    const label = !fresh ? '시세 대기' : !ready ? '신호 대기' : entry ? '진입 조건 충족' : q.spread > state.rules.maxSpread ? '호가 간격 초과' : '관찰 중';
    return `<article class="market-card"><div class="coin-header"><span class="coin-icon ${m.symbol}">${{BTC:'₿',ETH:'Ξ',XRP:'×',SOL:'≋'}[m.symbol]}</span><div><div class="coin-symbol">${m.symbol}</div><div class="coin-name">${m.name}</div></div></div><div class="coin-price">₩${q ? won(q.price, q.price < 100 ? 2 : 0) : '—'}</div><div class="coin-change ${q?.change > 0 ? 'positive' : q?.change < 0 ? 'negative' : ''}">${q ? signed(q.change * 100, 2) + '%' : '—'} <span>전일 대비</span></div><div class="coin-signal ${entry ? 'ready' : ''}" title="${esc(s.reason)}">${label}</div><div class="coin-detail">호가 간격 ${q ? won(q.spread * 100, 3) + '%' : '—'}<br>5분 변화 ${ready ? signed(s.momentum * 100, 3) + '%' : '—'}</div></article>`;
  }).join('');
  $('manual-panel').hidden = !manual;
  $('control-panel').hidden = manual;
  $('export').href = pages ? '#export' : '/api/export?mode=' + mode;
  $('journal-count').textContent = ledger.trades.length + '건';
  $('trades-empty').hidden = ledger.trades.length > 0;
  $('trades-empty-copy').textContent = manual ? '업비트에서 직접 거래한 체결 내역을 위 양식에 입력해 주세요.' : '조건이 맞을 때만 진입합니다. 기다리는 시간도 실험의 일부입니다.';
  $('trades').innerHTML = [...ledger.trades].reverse().slice(0, 100).map(t => `<tr title="${esc(t.reason)}"><td>${clock(t.at)}<small>${date(t.at)}</small></td><td>${esc(t.market.slice(4))}<span class="trade-side ${t.side}">${t.side === 'buy' ? '매수' : '매도'}</span><small>${won(t.quantity, 8)}개</small></td><td class="numeric">${won(t.notional, 2)}원<small>@ ${won(t.price, 2)}</small></td><td class="numeric">${won(t.fee, 2)}</td><td class="numeric ${t.realizedPnl > 0 ? 'positive' : t.realizedPnl < 0 ? 'negative' : ''}">${t.side === 'sell' ? signed(t.realizedPnl, 2) : '—'}</td></tr>`).join('');
  $('rule-budget').textContent = won(ledger.initialCapital * state.rules.investmentRatio) + '원';
  $('rule-loss').textContent = '−' + won(ledger.initialCapital * state.rules.lossRatio) + '원 (5%)';
  if (document.activeElement !== $('capital-input') && !$('capital-input').dataset.dirty) $('capital-input').value = ledger.initialCapital;
  for (const el of $('capital-form').elements) el.disabled = !state.capitalEditable || busy;
  document.querySelectorAll('[data-capital]').forEach(b => b.classList.toggle('selected', Number(b.dataset.capital) === Number($('capital-input').value)));
  $('capital-help').textContent = state.capitalEditable ? '가상 자금과 수동 장부의 기준액입니다. 입금이나 출금은 발생하지 않습니다.' : '실험이 시작되어 원금을 고정했습니다. 수익률 계산의 기준을 유지합니다.';
  $('run-status').textContent = control.locked ? '종료' : control.running ? '실행 중' : control.startedAt ? '일시정지' : '대기';
  $('run-status').classList.toggle('running', control.running);
  $('run-message').textContent = control.message;
  $('run-button').textContent = control.running ? '신규 진입 일시정지  Ⅱ' : control.startedAt ? '모의매매 재개  →' : '모의매매 시작  →';
  $('run-button').disabled = busy || disconnected || state.readOnly || control.locked || (!control.running && (!state.feed.ok || Number($('capital-input').value) !== ledger.initialCapital));
  $('close-button').disabled = busy || disconnected || state.readOnly || !state.paper.positions.length || !state.feed.ok;
  $('undo').disabled = busy || disconnected || state.readOnly || !state.manual.trades.length;
  $('fill-form').querySelector('button[type="submit"]').disabled = busy || disconnected || state.readOnly;
  $('events').innerHTML = state.events.length ? [...state.events].reverse().slice(0, 7).map(e => `<div class="event"><time>${date(e.at)} ${clock(e.at)}</time><p>${esc(e.text)}</p></div>`).join('') : '<p class="help">시작 전입니다. 실험을 시작하면 실행 기록이 남습니다.</p>';
  renderConnection(); renderCountdown(); drawChart();
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
if (pages) $('export').addEventListener('click', e => { e.preventDefault(); pages.download(mode); });
setInterval(renderCountdown, 1000);
defaultTime(); load();

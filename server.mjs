import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { MARKETS, RULES, newState, newLedger, addEvent, signalFromCandles, recordFill, valuation, advancePaper, closePaper, isFresh } from './engine.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.LAB_DATA_DIR ? path.resolve(process.env.LAB_DATA_DIR) : path.join(ROOT, 'data');
const FILE = path.join(DATA, 'experiment.json');
const PORT = Number(process.env.PORT || 8787);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('PORT는 1024~65535여야 합니다.');
fs.mkdirSync(DATA, { recursive: true });
let state = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : newState();
if (state.schema !== 1 || !state.paper || !state.manual || !state.control || !Array.isArray(state.observations)) throw new Error('저장 파일 형식 오류. 기존 데이터를 보존하고 종료합니다.');
for (const ledger of [state.paper, state.manual]) {
  if (!Number.isFinite(ledger.cash) || ledger.cash < 0 || !Array.isArray(ledger.trades) || !ledger.positions) throw new Error('저장된 장부가 유효하지 않습니다. 기존 데이터를 보존하고 종료합니다.');
}
if (state.control.running) {
  state.control.running = false;
  state.control.message = '서버가 재시작되어 신규 진입을 멈췄습니다. 기존 모의 보유분의 매도 조건은 감시합니다.';
  addEvent(state, '서버 재시작 · 중단된 시간의 거래는 재현하지 않습니다.');
}
function save() {
  const temp = FILE + '.tmp';
  const fd = fs.openSync(temp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, FILE);
}
save();
const token = randomBytes(24).toString('hex');
let quotes = {}, signals = {}, lastSuccess = null, lastCandleFetch = 0;
let feedError = '', storageError = '', failures = 0, refreshing = false, timer;
let exchangeOffsetMs = 0;
const marketNow = () => Date.now() + exchangeOffsetMs;

async function publicApi(endpoint) {
  // Deliberately only public GET endpoints. No credentials or order endpoints.
  if (!/^\/(ticker\?|orderbook\?|candles\/minutes\/1\?)/.test(endpoint)) throw new Error('허용되지 않은 API 경로');
  const sentAt = Date.now();
  const response = await fetch('https://api.upbit.com/v1' + endpoint, {
    method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`업비트 시세 응답 ${response.status}`);
  // Account for normal PC clock skew using the public HTTP Date header.
  // Keep the 30-second quote-age rule; do not change the system clock.
  const receivedAt = Date.now();
  const exchangeDate = Date.parse(response.headers.get('date'));
  if (Number.isFinite(exchangeDate)) {
    const offset = exchangeDate + (receivedAt - sentAt) / 2 - receivedAt;
    if (Math.abs(offset) > 5 * 60_000) throw new Error('PC와 시세 서버의 시간 차이가 5분을 초과합니다. 컴퓨터 시각을 확인해 주세요.');
    exchangeOffsetMs = Math.round(offset);
  }
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('업비트 시세 응답 형식 오류');
  return data;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const markets = MARKETS.map(m => m.code).join(',');
    const [tickers, books] = await Promise.all([
      publicApi('/ticker?markets=' + markets), publicApi('/orderbook?markets=' + markets + '&count=30'),
    ]);
    const now = marketNow();
    const next = {};
    for (const m of MARKETS) {
      const ticker = tickers.find(t => t.market === m.code);
      const book = books.find(b => b.market === m.code);
      const top = book?.orderbook_units?.[0];
      if (!ticker || !top || !(ticker.trade_price > 0) || !(top.ask_price >= top.bid_price && top.bid_price > 0) || !Number.isFinite(book.timestamp)) throw new Error(`${m.symbol} 호가 데이터 오류`);
      next[m.code] = { at: book.timestamp, receivedAt: now, price: ticker.trade_price, change: ticker.signed_change_rate, volume24h: ticker.acc_trade_price_24h, bid: top.bid_price, ask: top.ask_price, spread: (top.ask_price - top.bid_price) / top.ask_price, levels: book.orderbook_units };
    }
    quotes = next;
    if (!MARKETS.every(m => isFresh(quotes[m.code], now))) throw new Error('업비트 호가 시간이 30초 이상 지연되었습니다. 컴퓨터 시각도 확인해 주세요.');
    lastSuccess = now;
    feedError = '';
    failures = 0;
    // Protect an open paper position before waiting on slower candle requests.
    if (!storageError) advancePaper(state, quotes, signals, now);
    if (now - lastCandleFetch >= 60_000) {
      for (const m of MARKETS) {
        try {
          const candles = await publicApi('/candles/minutes/1?market=' + m.code + '&count=45');
          signals[m.code] = signalFromCandles(candles, marketNow());
        } catch (error) {
          signals[m.code] = { ready: false, entry: false, reason: '캔들 조회 실패 · 다음 갱신 대기' };
        }
      }
      lastCandleFetch = marketNow();
    }
    if (!storageError) advancePaper(state, quotes, signals, marketNow());
  } catch (error) {
    feedError = `${error.message}${error.cause?.code ? ' (' + error.cause.code + ')' : ''}`;
    failures += 1;
  } finally {
    const now = marketNow();
    const paper = valuation(state.paper, quotes, now);
    const manual = valuation(state.manual, quotes, now);
    const last = state.observations.at(-1);
    if (!last || now - last.at >= 10_000) {
      state.observations.push({ at: now, paper: paper.stale ? null : paper.equity, manual: manual.stale ? null : manual.equity });
      state.observations = state.observations.slice(-10000);
    }
    try { save(); storageError = ''; }
    catch (error) {
      state.control.running = false;
      storageError = '저장 실패 · 신규 모의 진입을 중단했습니다. 디스크를 확인해 주세요.';
      console.error(storageError, error.code);
    }
    refreshing = false;
    timer = setTimeout(refresh, Math.min(60_000, 10_000 * 2 ** Math.min(failures, 3)));
  }
}

function snapshot() {
  const now = marketNow();
  return {
    app: '만원 실험실', version: '1.0.0', now, token, rules: RULES,
    capitalEditable: !state.capitalLocked && !state.control.startedAt && !state.paper.trades.length && !state.manual.trades.length,
    feed: { ok: !feedError && lastSuccess !== null && now - lastSuccess < 30_000 && MARKETS.every(m => isFresh(quotes[m.code], now)), lastSuccess, error: feedError, storageError, refreshing, clockOffsetMs: exchangeOffsetMs },
    markets: MARKETS.map(m => ({ ...m, quote: quotes[m.code] ? { ...quotes[m.code], levels: undefined } : null, signal: signals[m.code] ?? { ready: false, entry: false, reason: '시세 연결 중' } })),
    control: state.control,
    paper: valuation(state.paper, quotes, now), manual: valuation(state.manual, quotes, now),
    observations: state.observations, events: state.events,
  };
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cache-Control': 'no-store',
};
function json(res, status, body) { res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 16000) throw new Error('입력 데이터가 너무 큽니다.'); }
  return JSON.parse(body || '{}');
}
function mutate(fn) {
  if (storageError) throw new Error(storageError);
  const before = structuredClone(state);
  try { fn(); save(); }
  catch (error) { state = before; throw error; }
}
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+@\t\r]/.test(text) || (text.startsWith('-') && !Number.isFinite(Number(text)))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const server = http.createServer(async (req, res) => {
  try {
    const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
    if (!hosts.includes(req.headers.host)) return json(res, 403, { error: '로컬 호스트만 허용됩니다.' });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const mode = url.searchParams.get('mode') === 'manual' ? 'manual' : 'paper';
      const header = ['구분', '기록시각', '종목', '매매', '수량', '체결가', '거래금액', '수수료', '실현손익', '체결ID', '설명'];
      const rows = state[mode].trades.map(t => [mode === 'manual' ? '사용자 입력 실거래' : '모의거래', new Date(t.at).toISOString(), t.market, t.side, t.quantity, t.price, t.notional, t.fee, t.realizedPnl, t.reference, t.reason]);
      res.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="manwon-${mode}.csv"` });
      return res.end('\uFEFF' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n'));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if ((origin && !hosts.map(h => 'http://' + h).includes(origin)) || req.headers['x-lab-token'] !== token || req.headers['content-type'] !== 'application/json') return json(res, 403, { error: '페이지를 새로고침한 뒤 다시 시도하세요.' });
      const body = await readBody(req);
      const now = marketNow();
      if (url.pathname === '/api/capital') {
        mutate(() => {
          const capital = Number(body.capital);
          if (!Number.isInteger(capital) || capital < RULES.minCapital || capital > RULES.maxCapital || capital % 1000 !== 0) throw new Error('실험 원금은 1만~10만 원 사이에서 1,000원 단위로 설정해 주세요.');
          if (state.capitalLocked || state.control.startedAt || state.paper.trades.length || state.manual.trades.length) throw new Error('실험 시작 후에는 원금을 변경할 수 없습니다.');
          state.paper = newLedger(capital);
          state.manual = newLedger(capital);
          state.observations = [{ at: now, paper: capital, manual: capital }];
          addEvent(state, `실험 원금 ${capital.toLocaleString('ko-KR')}원으로 설정`, now);
        });
      } else if (url.pathname === '/api/control') {
        mutate(() => {
          if (body.action === 'start') {
            if (state.control.locked) throw new Error('이 실험은 종료되었습니다. 기록은 계속 확인할 수 있습니다.');
            if (!lastSuccess || feedError || !MARKETS.every(m => isFresh(quotes[m.code], now))) throw new Error('실시간 호가 연결 후 시작할 수 있습니다.');
            if (state.control.startedAt && now >= state.control.startedAt + RULES.experimentMs) throw new Error('24시간 실험 기간이 끝났습니다.');
            state.control.running = true;
            state.capitalLocked = true;
            state.control.startedAt ??= now;
            state.control.message = '진입 조건을 기다리는 중입니다.';
            addEvent(state, '자동 모의매매 시작 · 실제 주문은 전송되지 않습니다.', now);
          } else if (body.action === 'pause') {
            state.control.running = false;
            state.control.message = '신규 진입 일시정지 · 기존 모의 보유분의 매도 조건은 계속 감시합니다.';
            addEvent(state, '신규 모의 진입 일시정지', now);
          } else if (body.action === 'close') {
            closePaper(state, quotes, now);
          } else throw new Error('지원하지 않는 동작입니다.');
        });
      } else if (url.pathname === '/api/manual') {
        mutate(() => {
          const at = Number(body.at);
          if (!Number.isFinite(at) || at < state.createdAt - 365 * 86400_000 || at > now + 60_000) throw new Error('체결 시각을 확인하세요.');
          if (state.manual.trades.length && at < state.manual.trades.at(-1).at) throw new Error('체결 내역은 오래된 순서대로 입력해 주세요.');
          if (typeof body.reference !== 'string' || !body.reference.trim()) throw new Error('입력 요청 ID가 필요합니다. 페이지를 새로고침해 주세요.');
          recordFill(state.manual, { ...body, quantity: Number(body.quantity), price: Number(body.price), fee: Number(body.fee), reason: '사용자가 입력한 실거래 체결 · 거래소 대조 전' }, at);
          state.capitalLocked = true;
          addEvent(state, `${body.market.slice(4)} 실거래 체결을 사용자가 기록했습니다.`, now);
        });
      } else if (url.pathname === '/api/manual/undo') {
        mutate(() => {
          const removed = state.manual.trades.at(-1);
          if (!removed) throw new Error('취소할 입력이 없습니다.');
          const remaining = state.manual.trades.slice(0, -1);
          const ledger = newLedger(state.manual.initialCapital);
          for (const t of remaining) { const replayed = recordFill(ledger, t, t.at); replayed.id = t.id; }
          state.manual = ledger;
          state.corrections ??= [];
          state.corrections.push({ at: now, removed });
          addEvent(state, '마지막 실거래 입력 취소 · 거래소 주문에는 영향이 없습니다.', now);
        });
      } else return json(res, 404, { error: '경로를 찾을 수 없습니다.' });
      return json(res, 200, snapshot());
    }
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, type] = files[url.pathname];
      const content = fs.readFileSync(path.join(ROOT, 'public', file));
      res.writeHead(200, { ...securityHeaders, 'Content-Type': type + '; charset=utf-8' });
      return res.end(content);
    }
    return json(res, 404, { error: '경로를 찾을 수 없습니다.' });
  } catch (error) { return json(res, 400, { error: error.message }); }
});
server.on('error', error => { console.error('서버 실행 실패:', error.message); process.exitCode = 1; clearTimeout(timer); });
server.listen(PORT, '127.0.0.1', () => { console.log(`만원 실험실 http://127.0.0.1:${PORT}`); console.log('업비트 공개 시세 GET 전용 · 실제 주문 기능 없음'); refresh(); });
function shutdown() { clearTimeout(timer); try { save(); } catch {} server.close(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

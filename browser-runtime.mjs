import { RULES, newState, addEvent, signalFromCandles, valuation, advancePaper, isFresh } from './engine.mjs';
import { applyPagesAction, tradesCsv, validateSavedState } from './pages-state.mjs';
import { SCANNER, parseMarkets, rankMarkets, mergeCandles, nextCandleMarket } from './market-universe.mjs';

const STORAGE_KEY = 'manwon-lab-pages-v1';
const REQUEST_INTERVAL = 12000;

export class BrowserRuntime {
  constructor() {
    this.state = newState(); this.quotes = {}; this.tickers = {}; this.signals = {}; this.candleFetched = {};
    this.catalog = []; this.scanTickers = {}; this.selection = rankMarkets([], {}); this.candles = {}; this.bootstrapped = {}; this.candleErrors = {};
    this.catalogFetched = 0; this.tickersFetched = 0; this.nextCatalogAt = 0; this.scanError = ''; this.subscribedKey = '';
    this.readOnly = true; this.feedError = ''; this.storageError = ''; this.offset = 0;
    this.socket = null; this.apiBusy = false; this.nextRequestAt = 0; this.reconnectAt = 0; this.retries = 0;
    this.lastSave = 0; this.lastMessage = 0; this.lastPing = 0; this.timer = null;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) this.state = validateSavedState(JSON.parse(saved));
    } catch (error) { this.storageError = error.message; return; }
    if (!navigator.locks) { this.storageError = '이 브라우저는 장부 중복 실행 방지 기능을 지원하지 않습니다. 최신 Chrome, Edge 또는 Safari를 사용하세요.'; return; }
    window.addEventListener('storage', event => {
      if (event.key === STORAGE_KEY && event.newValue && this.readOnly) {
        try { this.state = validateSavedState(JSON.parse(event.newValue)); } catch { this.storageError = '다른 탭의 저장 기록을 읽을 수 없습니다.'; }
      }
    });
    navigator.locks.request(STORAGE_KEY, { ifAvailable: true }, async lock => {
      if (!lock) { this.storageError = '이 사이트가 다른 탭에서 실행 중입니다. 한 탭만 열어 두고 이 페이지를 새로고침하세요.'; return; }
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) this.state = validateSavedState(JSON.parse(saved));
      } catch (error) { this.storageError = error.message; return; }
      this.readOnly = false;
      if (this.state.control.running) {
        this.state.control.running = false;
        this.state.control.message = '페이지를 다시 열어 신규 진입을 멈췄습니다. 모의매매 재개를 눌러 계속할 수 있습니다.';
        addEvent(this.state, '페이지 재접속 · 닫혀 있던 시간의 거래는 만들지 않습니다.');
      }
      if (!this.save()) return;
      this.timer = setInterval(() => this.tick(), 1000); this.tick();
      // The browser releases this exclusive lock when this document closes.
      await new Promise(resolve => { this.releaseLock = resolve; });
    }).catch(error => { this.storageError = '브라우저 장부 실행 실패: ' + error.message; });
    window.addEventListener('pagehide', () => {
      clearInterval(this.timer); this.timer = null;
      this.socket?.close(); this.socket = null;
      if (!this.readOnly) this.save(); this.releaseLock?.();
    });
    window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  }
  now() { return Date.now() + this.offset; }
  save() {
    if (this.readOnly || this.storageError) return false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); this.lastSave = Date.now(); return true;
    } catch {
      this.state.control.running = false;
      this.storageError = '브라우저 저장 공간을 사용할 수 없어 모의매매를 중단했습니다. 기록을 CSV로 보관해 주세요.';
      return false;
    }
  }
  refreshSelection() {
    this.selection = rankMarkets(this.catalog, this.scanTickers, [...Object.keys(this.state.paper.positions), ...Object.keys(this.state.manual.positions)]);
  }
  scanReady() { return !this.scanError && this.catalogFetched > 0 && Date.now() - this.catalogFetched <= SCANNER.maxAgeMs && Date.now() - this.tickersFetched <= SCANNER.maxAgeMs && this.tickersFetched >= this.catalogFetched; }
  streamMarkets() { return this.selection.watched.filter(m => this.catalog.some(c => c.code === m.code)); }
  subscribe(socket) {
    const codes = this.streamMarkets().map(m => m.code).sort();
    if (!codes.length) return;
    socket.send(JSON.stringify([{ ticket: crypto.randomUUID() }, { type: 'ticker', codes }, { type: 'orderbook', codes }, { type: 'candle.1m', codes }, { format: 'DEFAULT' }]));
    this.subscribedKey = codes.join(',');
    this.nextRequestAt = Date.now() + REQUEST_INTERVAL;
  }
  connect() {
    this.nextRequestAt = Date.now() + REQUEST_INTERVAL;
    this.feedError = '업비트 실시간 시세에 연결하는 중입니다.';
    const socket = new WebSocket('wss://api.upbit.com/websocket/v1');
    this.socket = socket; socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      this.subscribe(socket);
      this.lastMessage = Date.now(); this.lastPing = Date.now(); this.retries = 0;
    };
    socket.onmessage = event => {
      try {
        const data = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
        this.lastMessage = Date.now();
        if (data.error) throw new Error(data.error.message || '시세 요청 실패');
        const code = data.code || data.market;
        if (!this.streamMarkets().some(m => m.code === code)) return;
        // Realtime stream timestamps provide a bounded estimate of PC clock skew.
        if (Number.isFinite(data.timestamp) && (data.stream_type === 'REALTIME' || data.timestamp > Date.now())) {
          const offset = data.timestamp - Date.now();
          if (Math.abs(offset) < 5 * 60_000) this.offset = Math.round(offset);
        }
        if (data.type === 'ticker') this.tickers[code] = data;
        if (data.type === 'candle.1m') this.candles[code] = mergeCandles(this.candles[code] || [], [data], this.now());
        if (data.type === 'orderbook') {
          const top = data.orderbook_units?.[0], ticker = this.tickers[code];
          if (!top || !(top.ask_price >= top.bid_price && top.bid_price > 0) || !Number.isFinite(data.timestamp)) return;
          this.quotes[code] = { at: data.timestamp, receivedAt: this.now(), bid: top.bid_price, ask: top.ask_price, price: ticker?.trade_price ?? (top.ask_price + top.bid_price) / 2, change: ticker?.signed_change_rate ?? 0, volume24h: ticker?.acc_trade_price_24h ?? 0, spread: (top.ask_price - top.bid_price) / top.ask_price, levels: data.orderbook_units };
        }
        this.feedError = '';
      } catch (error) { this.feedError = error.message; }
    };
    socket.onerror = () => { this.feedError = '시세 연결이 끊겼습니다. 연결 복구를 기다리는 중입니다.'; };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.subscribedKey = ''; this.bootstrapped = {}; this.candleFetched = {};
      this.reconnectAt = Date.now() + Math.min(120000, 15000 * 2 ** Math.min(this.retries++, 3));
      this.feedError = '실시간 연결을 복구하는 중입니다. 오래된 호가로는 모의 체결하지 않습니다.';
    };
  }
  async request(path) {
    this.apiBusy = true; this.nextRequestAt = Date.now() + REQUEST_INTERVAL;
    try {
      const response = await fetch(`https://api.upbit.com/v1/${path}`, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        if (response.status === 418 || response.status === 429) this.nextRequestAt = Date.now() + (response.status === 418 ? 300000 : 60000);
        throw new Error(`업비트 응답 ${response.status} · 재조회 대기`);
      }
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('업비트 응답 형식 오류');
      return data;
    }
    finally { this.apiBusy = false; }
  }
  async fetchCatalog() {
    this.nextCatalogAt = Date.now() + 60000;
    try {
      this.catalog = parseMarkets(await this.request('market/all?is_details=true'));
      this.catalogFetched = Date.now(); this.nextCatalogAt = Date.now() + SCANNER.refreshMs;
      this.scanError = ''; this.refreshSelection();
    } catch (error) { this.scanError = '원화 종목 목록 갱신 실패: ' + error.message; }
  }
  async fetchTickers() {
    try {
      const rows = await this.request('ticker/all?quote_currencies=KRW');
      const tickers = Object.fromEntries(rows.filter(t => this.catalog.some(m => m.code === t.market)).map(t => [t.market, t]));
      if (!Object.keys(tickers).length) throw new Error('원화 거래대금 정보가 없습니다.');
      this.scanTickers = tickers; this.tickers = { ...tickers }; this.tickersFetched = Date.now(); this.scanError = ''; this.refreshSelection();
    } catch (error) { this.scanError = '전체 거래대금 갱신 실패: ' + error.message; }
  }
  async fetchCandle(market) {
    this.candleFetched[market] = Date.now();
    try {
      const rows = await this.request(`candles/minutes/1?market=${encodeURIComponent(market)}&count=45`);
      this.candles[market] = mergeCandles(this.candles[market] || [], rows, this.now());
      this.bootstrapped[market] = true; delete this.candleErrors[market];
    } catch (error) {
      this.candleErrors[market] = error.message; this.bootstrapped[market] = false;
      this.candleFetched[market] = Date.now() - SCANNER.refreshMs + 60000;
    }
  }
  tick() {
    if (this.readOnly || this.storageError) return;
    const localNow = Date.now(), now = this.now();
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (localNow - this.lastMessage > 45000) this.socket.close();
      else if (localNow - this.lastPing > 30000) { this.socket.send('PING'); this.lastPing = localNow; }
    }
    if (!this.apiBusy && localNow >= this.nextRequestAt) {
      if (localNow >= this.nextCatalogAt) void this.fetchCatalog();
      else if (this.catalog.length && this.tickersFetched < this.catalogFetched) void this.fetchTickers();
      else if (this.streamMarkets().length && !this.socket && localNow >= this.reconnectAt) this.connect();
      else if (this.socket?.readyState === WebSocket.OPEN) {
        const key = this.streamMarkets().map(m => m.code).sort().join(',');
        if (key && key !== this.subscribedKey) this.subscribe(this.socket);
        else {
          const code = nextCandleMarket(this.streamMarkets(), this.candleFetched, localNow);
          if (code) void this.fetchCandle(code);
        }
      }
    }
    for (const m of this.selection.watched) {
      if (this.bootstrapped[m.code]) this.signals[m.code] = signalFromCandles(this.candles[m.code] || [], now);
      else this.signals[m.code] = { ready: false, entry: false, reason: this.candleErrors[m.code] || '1분봉 준비 중 · 전체 12종목은 첫 연결 후 약 3분 소요' };
    }
    const before = this.state.paper.trades.length;
    advancePaper(this.state, this.quotes, this.signals, now, this.scanReady() ? this.selection.watched : []);
    if (this.state.paper.trades.length !== before) this.refreshSelection();
    if (localNow - this.lastSave >= 10000 || this.state.paper.trades.length !== before) {
      const paper = valuation(this.state.paper, this.quotes, now), manual = valuation(this.state.manual, this.quotes, now);
      this.state.observations.push({ at: now, paper: paper.stale ? null : paper.equity, manual: manual.stale ? null : manual.equity });
      this.state.observations = this.state.observations.slice(-8640);
      this.save();
    }
  }
  snapshot() {
    const now = this.now();
    const fresh = this.selection.watched.some(m => isFresh(this.quotes[m.code], now));
    return {
      app: '만원 실험실', version: '1.2.0-pages', now, token: 'browser-only', rules: RULES, readOnly: this.readOnly,
      capitalEditable: !this.readOnly && !this.state.capitalLocked && !this.state.control.startedAt && !this.state.paper.trades.length && !this.state.manual.trades.length,
      feed: { ok: fresh && !this.feedError && !this.storageError, lastSuccess: fresh ? Math.max(...Object.values(this.quotes).map(q => q.at)) : null, error: this.scanError || this.feedError, storageError: this.storageError, refreshing: this.apiBusy, clockOffsetMs: this.offset },
      universe: { total: this.catalog.length, eligible: this.selection.eligible, excluded: this.selection.excluded, selected: this.selection.selected, ready: this.selection.watched.filter(m => m.selected && this.signals[m.code]?.ready && this.signals[m.code].validUntil >= now).length, updatedAt: this.tickersFetched ? this.tickersFetched + this.offset : null, error: this.scanError, entryPaused: !this.scanReady(), all: this.selection.all },
      markets: this.selection.watched.map(m => ({ ...m, quote: this.quotes[m.code] ? { ...this.quotes[m.code], ...this.tickers[m.code] && { price: this.tickers[m.code].trade_price, change: this.tickers[m.code].signed_change_rate }, levels: undefined } : null, signal: this.signals[m.code] ?? { ready: false, entry: false, reason: '1분봉 준비 중 · 전체 12종목은 첫 연결 후 약 3분 소요' } })),
      control: this.state.control, paper: valuation(this.state.paper, this.quotes, now), manual: valuation(this.state.manual, this.quotes, now), observations: this.state.observations, events: this.state.events,
    };
  }
  action(endpoint, body) {
    if (this.readOnly || this.storageError) throw new Error(this.storageError || '다른 탭이 실행 중입니다.');
    const before = structuredClone(this.state);
    try {
      applyPagesAction(this.state, endpoint, body, this.quotes, this.now(), this.catalog);
      if (!this.save()) throw new Error(this.storageError);
      this.refreshSelection();
    } catch (error) { this.state = before; if (this.storageError) this.state.control.running = false; throw error; }
    return this.snapshot();
  }
  download(mode) {
    const csv = tradesCsv(this.state[mode], mode);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `manwon-${mode}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

import { BTC, type MarketVenue } from './coins.ts';
import { BookConnector, type Market } from './connector.ts';

/**
 * The nine exchanges added for coverage, each with its spot book and its perpetual (Gate, MEXC, HTX, WhiteBIT, Crypto.com, BingX, KuCoin,
 * Bitfinex, Bitstamp). One socket carries the book and the trades. A size the venue counts in contracts is stored that way and valued with
 * `contract` (coins per contract); a trade is emitted in coins. The old feed-manager adapters for the same names stay off, so a book is not
 * opened twice.
 */

const num = (value: unknown): number => Number(value);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const btc = (venue: MarketVenue): Market => ({ coin: 'BTC', ...BTC.markets[venue]! });
/** A stamp in seconds, milliseconds, microseconds or nanoseconds, as milliseconds. */
const msOf = (value: number): number => !Number.isFinite(value) || value <= 0 ? NaN : value > 1e16 ? value / 1e6 : value > 1e14 ? value / 1e3 : value < 1e11 ? value * 1000 : value;

abstract class ListedBook extends BookConnector {
  declare protected readonly market: Market;
  /** Coins per contract (1 where the venue sizes in coins). */
  readonly contract: number;
  constructor(market: Market) { super(market); this.contract = market.contract ?? 1; }
  get symbol(): string { return this.market.symbol; }
  protected override usdOf(price: number, size: number) { return price * size * this.contract; }
}

const sideOf = (value: unknown): 'buy' | 'sell' | null => {
  const text = String(value ?? '').toLowerCase();
  return text === 'buy' ? 'buy' : text === 'sell' ? 'sell' : null;
};

/** Price and size from a row that is either `[price, size]` or `{p, s}`. */
function levelsOf(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(row => {
    const price = Array.isArray(row) ? num(row[0]) : num(record(row)?.p ?? record(row)?.price);
    const size = Array.isArray(row) ? num(row[1]) : num(record(row)?.s ?? record(row)?.size);
    return Number.isFinite(price) && price > 0 && Number.isFinite(size) && size >= 0 ? [[price, size] as [number, number]] : [];
  });
}

/** Gzipped text, in the browser and in Node (both have `DecompressionStream`). */
export async function gunzipText(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// ---- Gate -----------------------------------------------------------------------------------------------------------------------------

/**
 * Gate's USDT books. The spot push is a full book each time (`spot.order_book`); the perpetual's `futures.order_book` with interval `0`
 * is too (`event: "all"`), and its sizes are contracts of 0.0001 BTC. A futures trade's `size` is a signed contract count (positive bought).
 */
abstract class GateBook extends ListedBook {
  protected abstract readonly bookChannel: string;
  protected abstract readonly tradeChannel: string;
  protected abstract readonly level: string;
  #ping = '';
  protected open(send: (p: unknown) => void) {
    const time = Math.floor(Date.now() / 1000);
    send({ time, channel: this.bookChannel, event: 'subscribe', payload: [this.symbol, this.level, this.bookChannel.startsWith('spot') ? '100ms' : '0'] });
    send({ time, channel: this.tradeChannel, event: 'subscribe', payload: [this.symbol] });
    this.#ping = this.bookChannel.startsWith('spot') ? 'spot.ping' : 'futures.ping';
  }
  override keepalive() { return { everyMs: 15_000, frame: () => ({ time: Math.floor(Date.now() / 1000), channel: this.#ping }) }; }
  onMessage(text: string) {
    const m = record(JSON.parse(text)); if (!m) return;
    if (m.channel === this.#ping || String(m.channel ?? '').endsWith('.pong')) return;
    if (m.event === 'subscribe') { const status = record(m.result)?.status; if (status && status !== 'success') this.fail(`subscription refused: ${String(status)}`.slice(0, 160)); return; }
    if (m.channel === this.bookChannel && (m.event === 'update' || m.event === 'all')) {
      const d = record(m.result); if (!d || (d.s !== undefined && d.s !== this.symbol) || (d.contract !== undefined && d.contract !== this.symbol)) return;
      this.replace(this.bids, levelsOf(d.bids)); this.replace(this.asks, levelsOf(d.asks)); this.touch(); return;
    }
    if (m.channel !== this.tradeChannel || m.event !== 'update') return;
    for (const item of Array.isArray(m.result) ? m.result : [m.result]) {
      const d = record(item); if (!d) continue;
      if (d.currency_pair !== undefined && d.currency_pair !== this.symbol) continue;
      if (d.contract !== undefined && d.contract !== this.symbol) continue;
      const price = num(d.price), t = msOf(num(d.create_time_ms));
      if (d.size !== undefined) {
        const size = num(d.size); if (!(price > 0) || size === 0 || !Number.isFinite(t)) continue;
        const amount = Math.abs(size) * this.contract;
        this.emitTrade({ tradeId: String(d.id), side: size > 0 ? 'buy' : 'sell', price, amount, notionalUsd: price * amount, t });
      } else {
        const amount = num(d.amount), side = sideOf(d.side);
        if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.id), side, price, amount, notionalUsd: price * amount, t });
      }
    }
  }
}
export class GatePerpConnector extends GateBook {
  readonly id = 'gateio'; readonly name = 'Gate.io'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  protected readonly bookChannel = 'futures.order_book'; protected readonly tradeChannel = 'futures.trades'; protected readonly level = '100';
  constructor(market: Market = btc('gateio')) { super(market); }
  protected url() { return 'wss://fx-ws.gateio.ws/v4/ws/usdt'; }
}
export class GateSpotConnector extends GateBook {
  readonly id = 'gateiospot'; readonly name = 'Gate.io spot'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  protected readonly bookChannel = 'spot.order_book'; protected readonly tradeChannel = 'spot.trades'; protected readonly level = '100';
  constructor(market: Market = btc('gateiospot')) { super(market); }
  protected url() { return 'wss://api.gateio.ws/ws/v4/'; }
}

// ---- MEXC spot ------------------------------------------------------------------------------------------------------------------------

/**
 * MEXC spot's public socket pushes protobuf, not JSON (the subscribe ack stays JSON). The limited depth is a full book each push, so the
 * page never needs the REST snapshot the incremental channel does. `tradeType` 1 bought and 2 sold.
 */
const MEXC_DEPTH = 303, MEXC_DEALS = 314;

function readVarint(buf: Uint8Array, at: number): [number, number] {
  let result = 0, shift = 0;
  while (at < buf.length && shift <= 35) {
    const byte = buf[at++]!;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, at];
    shift += 7;
  }
  throw new Error('truncated protobuf');
}
function protobuf(buf: Uint8Array): Map<number, Array<number | Uint8Array>> {
  const out = new Map<number, Array<number | Uint8Array>>();
  let at = 0;
  while (at < buf.length) {
    const [key, next] = readVarint(buf, at); at = next;
    const field = key >>> 3, wire = key & 7;
    let value: number | Uint8Array;
    if (wire === 0) { const [n, n2] = readVarint(buf, at); at = n2; value = n; }
    else if (wire === 2) { const [len, n2] = readVarint(buf, at); at = n2; if (at + len > buf.length) throw new Error('truncated protobuf'); value = buf.subarray(at, at + len); at += len; }
    else if (wire === 5) { at += 4; continue; }
    else if (wire === 1) { at += 8; continue; }
    else throw new Error(`protobuf wire ${wire}`);
    const list = out.get(field); if (list) list.push(value); else out.set(field, [value]);
  }
  return out;
}
const textOf = (value: number | Uint8Array | undefined): string => value instanceof Uint8Array ? new TextDecoder().decode(value) : '';
const bytesOf = (value: number | Uint8Array | undefined): Uint8Array | null => value instanceof Uint8Array ? value : null;
function mexcLevel(buf: Uint8Array): [number, number] | null {
  const fields = protobuf(buf), price = num(textOf(fields.get(1)?.[0])), qty = num(textOf(fields.get(2)?.[0]));
  return price > 0 && qty >= 0 && Number.isFinite(qty) ? [price, qty] : null;
}
/** The JSON the connector reads, from one protobuf push. Exported so a test can check a frame without a socket. */
export function mexcSpotJson(buf: Uint8Array): string {
  const wrap = protobuf(buf), channel = textOf(wrap.get(1)?.[0]);
  const depth = bytesOf(wrap.get(MEXC_DEPTH)?.[0]), deals = bytesOf(wrap.get(MEXC_DEALS)?.[0]);
  const body: Record<string, unknown> = { channel, symbol: textOf(wrap.get(3)?.[0]) };
  if (depth) {
    const fields = protobuf(depth);
    body.bids = (fields.get(2) ?? []).flatMap(item => { const row = bytesOf(item); return row ? [mexcLevel(row)] : []; }).filter(row => row !== null);
    body.asks = (fields.get(1) ?? []).flatMap(item => { const row = bytesOf(item); return row ? [mexcLevel(row)] : []; }).filter(row => row !== null);
  }
  if (deals) {
    body.deals = (protobuf(deals).get(1) ?? []).flatMap(item => {
      const row = bytesOf(item); if (!row) return [];
      const fields = protobuf(row), kind = fields.get(3)?.[0];
      return [{ price: textOf(fields.get(1)?.[0]), quantity: textOf(fields.get(2)?.[0]), tradeType: typeof kind === 'number' ? kind : 0, time: typeof fields.get(4)?.[0] === 'number' ? fields.get(4)![0] : 0, tradeId: textOf(fields.get(5)?.[0]) }];
    });
  }
  return JSON.stringify(body);
}

export class MexcSpotConnector extends ListedBook {
  readonly id = 'mexcspot'; readonly name = 'MEXC spot'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  constructor(market: Market = btc('mexcspot')) { super(market); }
  protected url() { return 'wss://wbs-api.mexc.com/ws'; }
  protected open(send: (p: unknown) => void) {
    send({ method: 'SUBSCRIPTION', params: [`spot@public.limit.depth.v3.api.pb@${this.symbol}@20`, `spot@public.aggre.deals.v3.api.pb@100ms@${this.symbol}`] });
  }
  override keepalive() { return { everyMs: 15_000, frame: () => ({ method: 'PING' }) }; }
  override decode(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (!(data instanceof ArrayBuffer)) return null;
    const bytes = new Uint8Array(data);
    if (bytes[0] === 0x7b) return new TextDecoder().decode(bytes); // a JSON ack, sent as binary by some runtimes
    return mexcSpotJson(bytes);
  }
  onMessage(text: string) {
    const m = record(JSON.parse(text)); if (!m) return;
    if (m.channel === 'pong' || m.msg === 'PONG') return;
    if (typeof m.code === 'number' && m.code !== 0) { this.fail(`subscription refused: ${String(m.msg ?? m.code)}`.slice(0, 160)); return; }
    if (m.symbol !== undefined && m.symbol !== this.symbol) return;
    if (Array.isArray(m.bids) && Array.isArray(m.asks)) { this.replace(this.bids, levelsOf(m.bids)); this.replace(this.asks, levelsOf(m.asks)); this.touch(); }
    if (!Array.isArray(m.deals)) return;
    for (const item of m.deals) {
      const d = record(item); if (!d) continue;
      const price = num(d.price), amount = num(d.quantity), t = msOf(num(d.time)), side = d.tradeType === 1 ? 'buy' : d.tradeType === 2 ? 'sell' : null;
      if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.tradeId), side, price, amount, notionalUsd: price * amount, t });
    }
  }
}

// ---- HTX ------------------------------------------------------------------------------------------------------------------------------

/** HTX (Huobi) gzipped full books. Spot sizes are BTC. The linear perpetual's book is contracts of 0.001 BTC; a trade also names `quantity` in BTC. */
abstract class HtxBook extends ListedBook {
  protected abstract readonly prefix: string;
  protected url(): string { return this.prefix; }
  protected open(send: (p: unknown) => void) {
    const pair = this.marketType === 'spot' ? this.symbol.toLowerCase() : this.symbol;
    send({ sub: `market.${pair}.depth.step0`, id: 'depth' });
    send({ sub: `market.${pair}.trade.detail`, id: 'trades' });
  }
  override decode(data: unknown): string | null | Promise<string | null> {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return gunzipText(data);
    return null;
  }
  onMessage(text: string) {
    const m = record(JSON.parse(text)); if (!m) return;
    if (typeof m.ping === 'number') { this.send({ pong: m.ping }); return; }
    if (m.status === 'error') { this.fail(`subscription refused: ${String(m['err-msg'] ?? m['err-code'] ?? '')}`.slice(0, 160)); return; }
    const ch = String(m.ch ?? ''); if (!ch.startsWith('market.')) return;
    const tick = record(m.tick); if (!tick) return;
    if (ch.endsWith('.depth.step0')) { this.replace(this.bids, levelsOf(tick.bids)); this.replace(this.asks, levelsOf(tick.asks)); this.touch(); return; }
    if (!ch.endsWith('.trade.detail') || !Array.isArray(tick.data)) return;
    for (const item of tick.data) {
      const d = record(item); if (!d) continue;
      const price = num(d.price), coins = num(d.quantity) > 0 ? num(d.quantity) : num(d.amount) * this.contract, t = msOf(num(d.ts)), side = sideOf(d.direction);
      if (side && price > 0 && coins > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.tradeId ?? d.id), side, price, amount: coins, notionalUsd: price * coins, t });
    }
  }
}
export class HtxPerpConnector extends HtxBook {
  readonly id = 'htx'; readonly name = 'HTX'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  protected readonly prefix = 'wss://api.hbdm.com/linear-swap-ws';
  constructor(market: Market = btc('htx')) { super(market); }
}
export class HtxSpotConnector extends HtxBook {
  readonly id = 'htxspot'; readonly name = 'HTX spot'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  protected readonly prefix = 'wss://api.huobi.pro/ws';
  constructor(market: Market = btc('htxspot')) { super(market); }
}

// ---- WhiteBIT -------------------------------------------------------------------------------------------------------------------------

/**
 * WhiteBIT's depth is one socket for spot and for the perpetual (`BTC_PERP`). The first push is a full book, later ones are changes
 * (a size of 0 removes a level) chained on `update_id`. The first trades push repeats recent fills, so one older than a few seconds is
 * left out: counting it again would reprint the last minute on every reconnect.
 */
abstract class WhitebitBook extends ListedBook {
  #seq = -1;
  protected url() { return 'wss://wss.whitebit.com/ws'; }
  protected open(send: (p: unknown) => void) {
    send({ id: 1, method: 'depth_subscribe', params: [this.symbol, 100, '0', true] });
    send({ id: 2, method: 'trades_subscribe', params: [this.symbol] });
  }
  override keepalive() { return { everyMs: 20_000, frame: () => ({ id: 0, method: 'ping', params: [] }) }; }
  protected override reset() { super.reset(); this.#seq = -1; }
  onMessage(text: string) {
    const m = record(JSON.parse(text)); if (!m) return;
    if (m.error) { this.fail(`subscription refused: ${String(record(m.error)?.message ?? m.error)}`.slice(0, 160)); return; }
    if (m.method === 'depth_update' && Array.isArray(m.params)) {
      const [full, data, market] = m.params as [unknown, unknown, unknown];
      if (market !== this.symbol) return;
      const d = record(data); if (!d || typeof full !== 'boolean') return;
      const seq = num(d.update_id);
      if (!Number.isFinite(seq)) return;
      if (full) { this.replace(this.bids, levelsOf(d.bids)); this.replace(this.asks, levelsOf(d.asks)); this.#seq = seq; this.touch(); return; }
      if (num(d.past_update_id) !== this.#seq) { this.fail(`sequence gap ${this.#seq} -> ${seq}`); return; }
      this.apply(this.bids, levelsOf(d.bids)); this.apply(this.asks, levelsOf(d.asks)); this.#seq = seq; this.touch(); return;
    }
    if (m.method !== 'trades_update' || !Array.isArray(m.params) || m.params[0] !== this.symbol || !Array.isArray(m.params[1])) return;
    const fresh = Date.now() - 5_000;
    for (const item of m.params[1] as unknown[]) {
      const d = record(item); if (!d) continue;
      const price = num(d.price), amount = num(d.amount), t = msOf(num(d.time)), side = sideOf(d.type);
      if (side && price > 0 && amount > 0 && Number.isFinite(t) && t >= fresh) this.emitTrade({ tradeId: String(d.id), side, price, amount, notionalUsd: price * amount, t });
    }
  }
}
export class WhitebitPerpConnector extends WhitebitBook {
  readonly id = 'whitebit'; readonly name = 'WhiteBIT'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('whitebit')) { super(market); }
}
export class WhitebitSpotConnector extends WhitebitBook {
  readonly id = 'whitebitspot'; readonly name = 'WhiteBIT spot'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  constructor(market: Market = btc('whitebitspot')) { super(market); }
}

// ---- Crypto.com -----------------------------------------------------------------------------------------------------------------------

/**
 * Crypto.com's book channel in `SNAPSHOT` mode resends the whole top of the book (sizes in coins, on the spot pair and the perpetual).
 * The subscribe reply (`id` 1) repeats recent trades; later trade pushes use `id` -1 and are the ones that count.
 */
abstract class CryptocomBook extends ListedBook {
  protected url() { return 'wss://stream.crypto.com/exchange/v1/market'; }
  protected open(send: (p: unknown) => void) {
    send({ id: 1, method: 'subscribe', params: { channels: [`book.${this.symbol}.50`, `trade.${this.symbol}`], book_subscription_type: 'SNAPSHOT', book_update_frequency: 100 } });
  }
  onMessage(text: string) {
    const m = record(JSON.parse(text)); if (!m) return;
    if (m.method === 'public/heartbeat') { this.send({ id: m.id, method: 'public/respond-heartbeat' }); return; }
    if (typeof m.code === 'number' && m.code !== 0) { this.fail(`subscription refused: ${String(m.message ?? m.code)}`.slice(0, 160)); return; }
    const result = record(m.result); if (!result || result.instrument_name !== this.symbol) return;
    const row = record(Array.isArray(result.data) ? result.data[0] : undefined);
    if (result.channel === 'book' && row) { this.replace(this.bids, levelsOf(row.bids)); this.replace(this.asks, levelsOf(row.asks)); this.touch(); return; }
    if (result.channel === 'book.update' && row) {
      const update = record(row.update) ?? row;
      this.apply(this.bids, levelsOf(update.bids)); this.apply(this.asks, levelsOf(update.asks)); this.touch(); return;
    }
    if (result.channel !== 'trade' || m.id === 1 || !Array.isArray(result.data)) return;
    for (const item of result.data) {
      const d = record(item); if (!d || d.i !== this.symbol) continue;
      const price = num(d.p), amount = num(d.q), t = msOf(num(d.t)), side = sideOf(d.s);
      if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.d), side, price, amount, notionalUsd: price * amount, t });
    }
  }
}
export class CryptocomPerpConnector extends CryptocomBook {
  readonly id = 'cryptocom'; readonly name = 'Crypto.com'; readonly quote = 'USD'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('cryptocom')) { super(market); }
}
export class CryptocomSpotConnector extends CryptocomBook {
  readonly id = 'cryptocomspot'; readonly name = 'Crypto.com spot'; readonly quote = 'USD'; readonly marketType = 'spot' as const;
  constructor(market: Market = btc('cryptocomspot')) { super(market); }
}

// ---- BingX ----------------------------------------------------------------------------------------------------------------------------

/** BingX gzipped full depth and trades. `m` true means the buyer was the maker, so the taker sold. Sizes are coins on both markets. */
abstract class BingxBook extends ListedBook {
  protected abstract readonly endpoint: string;
  protected url() { return this.endpoint; }
  protected open(send: (p: unknown) => void) {
    send({ id: 'depth', reqType: 'sub', dataType: `${this.symbol}@depth50` });
    send({ id: 'trades', reqType: 'sub', dataType: `${this.symbol}@trade` });
  }
  override decode(data: unknown): string | null | Promise<string | null> {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return gunzipText(data);
    return null;
  }
  onMessage(text: string) {
    const trimmed = text.trim();
    if (trimmed === 'Ping' || trimmed.toLowerCase() === 'ping') { this.send('Pong'); return; }
    const m = record(JSON.parse(trimmed)); if (!m) return;
    if (typeof m.code === 'number' && m.code !== 0) { this.fail(`subscription refused: ${String(m.msg ?? m.code)}`.slice(0, 160)); return; }
    const kind = String(m.dataType ?? '');
    if (kind.endsWith('@depth50')) {
      const d = record(m.data); if (!d) return;
      this.replace(this.bids, levelsOf(d.bids)); this.replace(this.asks, levelsOf(d.asks)); this.touch(); return;
    }
    if (!kind.endsWith('@trade')) return;
    for (const item of Array.isArray(m.data) ? m.data : m.data ? [m.data] : []) {
      const d = record(item); if (!d || (d.s !== undefined && d.s !== this.symbol)) continue;
      const price = num(d.p), amount = num(d.q), t = msOf(num(d.T));
      if (!(price > 0) || !(amount > 0) || !Number.isFinite(t)) continue;
      this.emitTrade({ tradeId: String(d.t), side: d.m === true ? 'sell' : 'buy', price, amount, notionalUsd: price * amount, t });
    }
  }
}
export class BingxPerpConnector extends BingxBook {
  readonly id = 'bingx'; readonly name = 'BingX'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  protected readonly endpoint = 'wss://open-api-swap.bingx.com/swap-market';
  constructor(market: Market = btc('bingx')) { super(market); }
}
export class BingxSpotConnector extends BingxBook {
  readonly id = 'bingxspot'; readonly name = 'BingX spot'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  protected readonly endpoint = 'wss://open-api-ws.bingx.com/market';
  constructor(market: Market = btc('bingxspot')) { super(market); }
}

// ---- KuCoin ---------------------------------------------------------------------------------------------------------------------------

/**
 * KuCoin's public push sockets need no token, so a page can open them (the older bullet token answers only KuCoin's own site). Depth 50 is
 * a full book each push. The perpetual's sizes are contracts of 0.001 BTC. A trade's `M` is nanoseconds and its `q` is contracts there.
 */
abstract class KucoinBook extends ListedBook {
  protected abstract readonly endpoint: string;
  protected abstract readonly tradeType: 'SPOT' | 'FUTURES';
  protected url() { return this.endpoint; }
  protected open(send: (p: unknown) => void) {
    const id = String(Date.now());
    send({ id, action: 'SUBSCRIBE', channel: 'obu', tradeType: this.tradeType, symbol: this.symbol, depth: '50', rpiFilter: 0 });
    send({ id: `${id}t`, action: 'SUBSCRIBE', channel: 'trade', tradeType: this.tradeType, symbol: this.symbol });
  }
  override keepalive() { return { everyMs: 15_000, frame: () => ({ id: String(Date.now()), type: 'ping' }) }; }
  onMessage(text: string) {
    const m = record(JSON.parse(text)); if (!m || m.type === 'pong' || m.message === 'welcome') return;
    if (m.result === false) { this.fail(`subscription refused: ${String(m.message ?? '')}`.slice(0, 160)); return; }
    if (m.result === true) return;
    const topic = String(m.T ?? ''), d = record(m.d); if (!d || d.s !== this.symbol) return;
    if (topic === `obu.${this.tradeType}`) {
      if (m.t !== 'snapshot' || String(m.dp) !== '50') return;
      this.replace(this.bids, levelsOf(d.b)); this.replace(this.asks, levelsOf(d.a)); this.touch(); return;
    }
    if (topic !== `trade.${this.tradeType}`) return;
    const price = num(d.p), raw = num(d.q), t = msOf(num(d.M)), side = sideOf(d.S);
    if (!side || !(price > 0) || !(raw > 0) || !Number.isFinite(t)) return;
    const amount = raw * this.contract;
    this.emitTrade({ tradeId: String(d.ti ?? d.E), side, price, amount, notionalUsd: price * amount, t });
  }
}
export class KucoinPerpConnector extends KucoinBook {
  readonly id = 'kucoin'; readonly name = 'KuCoin'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  protected readonly endpoint = 'wss://x-push-futures.kucoin.com';
  protected readonly tradeType = 'FUTURES' as const;
  constructor(market: Market = btc('kucoin')) { super(market); }
}
export class KucoinSpotConnector extends KucoinBook {
  readonly id = 'kucoinspot'; readonly name = 'KuCoin spot'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  protected readonly endpoint = 'wss://x-push-spot.kucoin.com';
  protected readonly tradeType = 'SPOT' as const;
  constructor(market: Market = btc('kucoinspot')) { super(market); }
}

// ---- Bitfinex -------------------------------------------------------------------------------------------------------------------------

/**
 * Bitfinex's book and trades share one socket and are told apart by the channel id from the subscribe reply. A positive amount is a bid
 * or a buy. The trades channel first sends its recent fills as one list; those already happened. `te` is a new execution (`tu` repeats it).
 */
abstract class BitfinexBook extends ListedBook {
  #channels = new Map<number, 'book' | 'trades'>();
  #seenBook = false;
  protected url() { return 'wss://api-pub.bitfinex.com/ws/2'; }
  protected open(send: (p: unknown) => void) {
    send({ event: 'subscribe', channel: 'book', symbol: this.symbol, prec: 'P0', freq: 'F0', len: '100' });
    send({ event: 'subscribe', channel: 'trades', symbol: this.symbol });
  }
  protected override reset() { super.reset(); this.#channels.clear(); this.#seenBook = false; }
  #apply(price: number, count: number, amount: number) {
    const side = amount > 0 ? this.bids : this.asks, size = Math.abs(amount);
    if (!(price > 0)) return;
    if (count === 0 || size === 0) side.delete(price); else side.set(price, size);
  }
  onMessage(text: string) {
    const m = JSON.parse(text) as unknown;
    if (!Array.isArray(m)) {
      const d = record(m); if (!d) return;
      if (d.event === 'error') { this.fail(`subscription refused: ${String(d.msg ?? d.code ?? '')}`.slice(0, 160)); return; }
      if (d.event === 'subscribed' && d.symbol === this.symbol && (d.channel === 'book' || d.channel === 'trades') && typeof d.chanId === 'number') this.#channels.set(d.chanId, d.channel);
      return;
    }
    const kind = this.#channels.get(num(m[0])); if (!kind || m[1] === 'hb') return;
    if (kind === 'trades') {
      if (m[1] === 'te' && Array.isArray(m[2])) {
        const [id, time, amount, price] = m[2] as unknown[], size = Math.abs(num(amount)), px = num(price), t = msOf(num(time));
        if (size > 0 && px > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(id), side: num(amount) > 0 ? 'buy' : 'sell', price: px, amount: size, notionalUsd: px * size, t });
      }
      return;
    }
    if (m[1] === 'cs') return;
    if (Array.isArray(m[1]) && Array.isArray(m[1][0])) {
      this.bids.clear(); this.asks.clear();
      for (const row of m[1] as unknown[]) if (Array.isArray(row)) this.#apply(num(row[0]), num(row[1]), num(row[2]));
      this.#seenBook = true; this.touch(); return;
    }
    if (!this.#seenBook || !Array.isArray(m[1])) return;
    this.#apply(num(m[1][0]), num(m[1][1]), num(m[1][2])); this.touch();
  }
}
export class BitfinexPerpConnector extends BitfinexBook {
  readonly id = 'bitfinex'; readonly name = 'Bitfinex'; readonly quote = 'USDT'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('bitfinex')) { super(market); }
}
export class BitfinexSpotConnector extends BitfinexBook {
  readonly id = 'bitfinexspot'; readonly name = 'Bitfinex spot'; readonly quote = 'USD'; readonly marketType = 'spot' as const;
  constructor(market: Market = btc('bitfinexspot')) { super(market); }
}

// ---- Bitstamp -------------------------------------------------------------------------------------------------------------------------

/** Bitstamp's full book and live trades, the same socket for the spot pair and the perpetual (`btcusd-perp`). `type` 0 bought and 1 sold. */
abstract class BitstampBook extends ListedBook {
  protected url() { return 'wss://ws.bitstamp.net/'; }
  #book = ''; #trades = '';
  protected open(send: (p: unknown) => void) {
    this.#book = `order_book_${this.symbol}`; this.#trades = `live_trades_${this.symbol}`;
    send({ event: 'bts:subscribe', data: { channel: this.#book } });
    send({ event: 'bts:subscribe', data: { channel: this.#trades } });
  }
  override keepalive() { return { everyMs: 20_000, frame: () => ({ event: 'bts:heartbeat' }) }; }
  onMessage(text: string) {
    const m = record(JSON.parse(text)); if (!m) return;
    if (m.event === 'bts:error') { this.fail(`subscription refused: ${String(m.message ?? '')}`.slice(0, 160)); return; }
    if (m.event === 'bts:request_reconnect') { this.fail('reconnect requested'); return; }
    const d = record(m.data); if (!d) return;
    if (m.channel === this.#book && m.event === 'data') { this.replace(this.bids, levelsOf(d.bids)); this.replace(this.asks, levelsOf(d.asks)); this.touch(); return; }
    if (m.channel !== this.#trades || m.event !== 'trade') return;
    const price = num(d.price), amount = num(d.amount), t = msOf(num(d.microtimestamp)), side = d.type === 0 ? 'buy' : d.type === 1 ? 'sell' : null;
    if (side && price > 0 && amount > 0 && Number.isFinite(t)) this.emitTrade({ tradeId: String(d.id), side, price, amount, notionalUsd: price * amount, t });
  }
}
export class BitstampPerpConnector extends BitstampBook {
  readonly id = 'bitstamp'; readonly name = 'Bitstamp'; readonly quote = 'USD'; readonly marketType = 'perpetual' as const;
  constructor(market: Market = btc('bitstamp')) { super(market); }
}
export class BitstampSpotConnector extends BitstampBook {
  readonly id = 'bitstampspot'; readonly name = 'Bitstamp spot'; readonly quote = 'USD'; readonly marketType = 'spot' as const;
  constructor(market: Market = btc('bitstampspot')) { super(market); }
}

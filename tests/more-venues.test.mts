import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_VENUES } from '../src/shared/venues.ts';
import { familyKey } from '../src/app/cvd/families.ts';
import { markOf } from '../src/app/venue-marks.ts';
import { BookConnector, type TradeEvent } from '../src/shared/connector.ts';
import { FlowSources } from '../src/server/v2/flow-sources.mts';
import { CONNECTOR_FACTORIES } from '../src/server/v2/connectors.mts';
import { RECOMMENDED_EXTRA_VENUES } from '../src/server/v2/venues.mts';
import {
  BingxPerpConnector, BingxSpotConnector, BitfinexPerpConnector, BitfinexSpotConnector, BitstampPerpConnector, BitstampSpotConnector,
  CryptocomPerpConnector, CryptocomSpotConnector, GatePerpConnector, GateSpotConnector, HtxPerpConnector, HtxSpotConnector,
  KucoinPerpConnector, KucoinSpotConnector, MexcSpotConnector, WhitebitPerpConnector, WhitebitSpotConnector, gunzipText, mexcSpotJson,
} from '../src/shared/more-venues.ts';

type Inside = { url(): string; open(send: (p: unknown) => void): void; usdOf(price: number, size: number): number; keepalive(): { frame: () => unknown } | null };
const inside = (c: BookConnector): Inside => c as unknown as Inside;
const trades = (c: BookConnector): TradeEvent[] => { const out: TradeEvent[] = []; c.onTrade = t => { out.push(t); }; return out; };
const msg = (value: unknown): string => JSON.stringify(value);
const live = (c: BookConnector): void => { c.state = 'connecting'; };

function varint(n: number): number[] {
  const out: number[] = [];
  let v = Math.floor(n);
  while (v > 127) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v & 0x7f);
  return out;
}
const bytes = (field: number, data: Uint8Array): number[] => [...varint((field << 3) | 2), ...varint(data.length), ...data];
const str = (field: number, text: string): number[] => bytes(field, new TextEncoder().encode(text));
const numField = (field: number, n: number): number[] => [...varint(field << 3), ...varint(n)];
const packed = (parts: number[]): Uint8Array => Uint8Array.from(parts);

test('Gate replaces the whole book, and a futures trade is a signed contract count', () => {
  const perp = new GatePerpConnector(), got = trades(perp);
  assert.equal(perp.instrumentId, 'gateio:BTC_USDT'); assert.equal(inside(perp).usdOf(80_000, 10_000), 80_000, '10,000 contracts are one BTC');
  const sent: unknown[] = []; inside(perp).open(p => sent.push(p));
  assert.equal((sent[0] as { channel: string }).channel, 'futures.order_book');
  assert.deepEqual((sent[0] as { payload: unknown }).payload, ['BTC_USDT', '100', '0']);
  assert.deepEqual((sent[1] as { payload: unknown }).payload, ['BTC_USDT']);
  live(perp);
  perp.onMessage(msg({ channel: 'futures.order_book', event: 'all', result: { contract: 'BTC_USDT', bids: [{ p: '80000', s: '10000' }], asks: [{ p: '80001', s: '5000' }] } }));
  const book = perp.valued(Date.now())!;
  assert.equal(book.bids.usd[0], 80_000);
  perp.onMessage(msg({ channel: 'futures.trades', event: 'update', result: [{ id: 7, size: 50, price: '80000', contract: 'BTC_USDT', create_time_ms: 1_700_000_000_000 }, { id: 8, size: -20, price: '80001', contract: 'ETH_USDT', create_time_ms: 1_700_000_000_001 }] }));
  assert.deepEqual(got.map(t => [t.tradeId, t.side, t.amount, t.notionalUsd]), [['7', 'buy', 0.005, 400]]);

  const spot = new GateSpotConnector(), spotTrades = trades(spot);
  live(spot);
  spot.onMessage(msg({ channel: 'spot.order_book', event: 'update', result: { s: 'BTC_USDT', bids: [['80000', '0.5']], asks: [['80001', '0.25']] } }));
  assert.equal(spot.valued(Date.now())!.bids.usd[0], 40_000);
  spot.onMessage(msg({ channel: 'spot.trades', event: 'update', result: { id: 9, side: 'sell', amount: '0.1', price: '80000', currency_pair: 'BTC_USDT', create_time_ms: '1700000000000.123' } }));
  assert.deepEqual(spotTrades.map(t => [t.side, t.amount, t.notionalUsd]), [['sell', 0.1, 8_000]]);
});

test('MEXC spot reads a protobuf depth and a deal, and leaves a refused subscription', () => {
  const level = (price: string, qty: string): Uint8Array => packed([...str(1, price), ...str(2, qty)]);
  const deal = packed([...str(1, '80000'), ...str(2, '0.02'), ...numField(3, 2), ...numField(4, 1_700_000_000_000), ...str(5, 'd1')]);
  const depth = packed([...bytes(1, level('80001', '0.4')), ...bytes(2, level('80000', '0.5'))]);
  const frame = packed([...str(1, 'spot@public.limit.depth.v3.api.pb@BTCUSDT@20'), ...str(3, 'BTCUSDT'), ...bytes(303, depth), ...bytes(314, packed(bytes(1, deal)))]);
  const c = new MexcSpotConnector(), got = trades(c);
  assert.equal(c.instrumentId, 'mexcspot:BTCUSDT');
  const sent: unknown[] = []; inside(c).open(p => sent.push(p));
  assert.deepEqual((sent[0] as { params: string[] }).params, ['spot@public.limit.depth.v3.api.pb@BTCUSDT@20', 'spot@public.aggre.deals.v3.api.pb@100ms@BTCUSDT']);
  live(c);
  c.onMessage(mexcSpotJson(frame));
  const book = c.valued(Date.now())!;
  assert.equal(book.bids.usd[0], 40_000); assert.equal(book.asks.lo[0], 80_001);
  assert.deepEqual(got.map(t => [t.tradeId, t.side, t.amount]), [['d1', 'sell', 0.02]]);
  c.onMessage(msg({ code: 1, msg: 'no' }));
  assert.equal(c.state, 'error'); c.stop();
});

test('HTX answers a ping, and the perpetual trade is the coin quantity rather than the contract amount', async () => {
  const perp = new HtxPerpConnector(), got = trades(perp);
  assert.equal(inside(perp).usdOf(80_000, 1_000), 80_000, '1,000 contracts are one BTC');
  const gzipped = await new Response(new Blob([JSON.stringify({ ping: 42 })]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  assert.equal(await gunzipText(gzipped), '{"ping":42}');
  assert.equal(await perp.decode(gzipped), '{"ping":42}');
  live(perp);
  perp.onMessage(msg({ ch: 'market.BTC-USDT.depth.step0', tick: { bids: [[80_000, 1_000]], asks: [[80_001, 500]] } }));
  assert.equal(perp.valued(Date.now())!.bids.usd[0], 80_000);
  perp.onMessage(msg({ ch: 'market.BTC-USDT.trade.detail', tick: { data: [{ id: 3, price: 80_000, amount: 200, quantity: 0.2, direction: 'buy', ts: 1_700_000_000_000 }] } }));
  assert.deepEqual(got.map(t => [t.amount, t.notionalUsd]), [[0.2, 16_000]]);
  const spot = new HtxSpotConnector();
  const sent: unknown[] = []; inside(spot).open(p => sent.push(p));
  assert.deepEqual(sent, [{ sub: 'market.btcusdt.depth.step0', id: 'depth' }, { sub: 'market.btcusdt.trade.detail', id: 'trades' }]);
});

test('WhiteBIT chains the book on its update id and drops the trades it repeats from before', () => {
  const c = new WhitebitPerpConnector(), got = trades(c);
  assert.equal(c.instrumentId, 'whitebit:BTC_PERP');
  live(c);
  const now = Date.now();
  c.onMessage(msg({ method: 'depth_update', params: [true, { update_id: 10, bids: [['80000', '1']], asks: [['80001', '1']] }, 'BTC_PERP'] }));
  c.onMessage(msg({ method: 'depth_update', params: [false, { update_id: 11, past_update_id: 10, bids: [['80000', '0'], ['79900', '0.5']], asks: [] }, 'BTC_PERP'] }));
  assert.equal(c.valued(Date.now())!.bids.lo[0], 79_900, 'a size of 0 removes the near bid');
  c.onMessage(msg({ method: 'trades_update', params: ['BTC_PERP', [
    { id: 1, price: '80000', amount: '0.1', type: 'buy', time: Math.floor((now - 60_000) / 1000) },
    { id: 2, price: '80000', amount: '0.2', type: 'sell', time: now / 1000 },
  ]] }));
  assert.deepEqual(got.map(t => [t.tradeId, t.side, t.amount]), [['2', 'sell', 0.2]]);
  c.onMessage(msg({ method: 'depth_update', params: [false, { update_id: 13, past_update_id: 10, bids: [], asks: [] }, 'BTC_PERP'] }));
  assert.equal(c.state, 'error'); assert.match(c.lastError ?? '', /sequence gap 11 -> 13/);
  c.stop();
  assert.equal(new WhitebitSpotConnector().symbol, 'BTC_USDT');
});

test('Crypto.com counts a live trade and not the ones in the subscribe reply', () => {
  const c = new CryptocomPerpConnector(), got = trades(c);
  assert.equal(c.instrumentId, 'cryptocom:BTCUSD-PERP'); assert.equal(c.quote, 'USD');
  const sent: unknown[] = []; inside(c).open(p => sent.push(p));
  assert.deepEqual((sent[0] as { params: { channels: string[] } }).params.channels, ['book.BTCUSD-PERP.50', 'trade.BTCUSD-PERP']);
  live(c);
  c.onMessage(msg({ id: 1, result: { instrument_name: 'BTCUSD-PERP', channel: 'trade', data: [{ d: 'old', p: '80000', q: '1', s: 'BUY', t: 1_700_000_000_000, i: 'BTCUSD-PERP' }] } }));
  c.onMessage(msg({ id: -1, result: { instrument_name: 'BTCUSD-PERP', channel: 'book', data: [{ bids: [['80000', '0.5', 1]], asks: [['80010', '0.25', 1]] }] } }));
  assert.equal(c.valued(Date.now())!.bids.usd[0], 40_000);
  c.onMessage(msg({ id: -1, result: { instrument_name: 'BTCUSD-PERP', channel: 'book.update', data: [{ update: { bids: [['80000', '0']], asks: [] } }] } }));
  assert.equal(c.valued(Date.now()), null, 'the only bid was removed');
  c.onMessage(msg({ id: -1, result: { instrument_name: 'BTCUSD-PERP', channel: 'trade', data: [{ d: 'new', p: '80000', q: '0.1', s: 'SELL', t: 1_700_000_000_001, i: 'BTCUSD-PERP' }] } }));
  assert.deepEqual(got.map(t => [t.tradeId, t.side, t.notionalUsd]), [['new', 'sell', 8_000]]);
  assert.equal(new CryptocomSpotConnector().symbol, 'BTC_USD');
});

test('BingX reads a taker sell from the maker flag, whether the trade arrives as one object or a list', () => {
  const perp = new BingxPerpConnector(), got = trades(perp);
  assert.equal(perp.quote, 'USDT'); assert.equal(inside(perp).url(), 'wss://open-api-swap.bingx.com/swap-market');
  live(perp);
  perp.onMessage(msg({ dataType: 'BTC-USDT@depth50', data: { bids: [['80000', '0.5']], asks: [['80001', '0.25']] } }));
  assert.equal(perp.valued(Date.now())!.asks.usd[0], 20_000.25);
  perp.onMessage(msg({ dataType: 'BTC-USDT@trade', data: [{ p: '80000', q: '0.0009', T: 1_700_000_000_000, m: true, t: 'a', s: 'BTC-USDT' }] }));
  assert.deepEqual(got.map(t => [t.side, t.amount]), [['sell', 0.0009]]);
  const spot = new BingxSpotConnector(), spotTrades = trades(spot);
  assert.equal(inside(spot).url(), 'wss://open-api-ws.bingx.com/market');
  live(spot);
  spot.onMessage('Ping');
  spot.onMessage(msg({ dataType: 'BTC-USDT@trade', data: { p: '80000', q: '0.1', T: 1_700_000_000_000, m: false, t: 'b', s: 'BTC-USDT' } }));
  assert.deepEqual(spotTrades.map(t => [t.side, t.amount]), [['buy', 0.1]]);
});

test('KuCoin reads the public push book and counts a futures trade in coins', () => {
  const perp = new KucoinPerpConnector(), got = trades(perp);
  assert.equal(perp.instrumentId, 'kucoin:XBTUSDTM');
  assert.equal(inside(perp).url(), 'wss://x-push-futures.kucoin.com');
  assert.equal(inside(new KucoinSpotConnector()).url(), 'wss://x-push-spot.kucoin.com');
  const sent: { channel: string; symbol: string; depth?: string; tradeType: string }[] = [];
  inside(perp).open(p => sent.push(p as { channel: string; symbol: string; depth?: string; tradeType: string }));
  assert.deepEqual(sent.map(s => [s.channel, s.tradeType, s.symbol, s.depth]), [['obu', 'FUTURES', 'XBTUSDTM', '50'], ['trade', 'FUTURES', 'XBTUSDTM', undefined]]);
  assert.equal((inside(perp).keepalive()?.frame() as { type: string }).type, 'ping');
  live(perp);
  perp.onMessage(msg({ sessionId: 's', message: 'welcome', pingInterval: 18000 }));
  perp.onMessage(msg({ id: '1', result: true }));
  perp.onMessage(msg({ type: 'pong', id: '1p' }));
  perp.onMessage(msg({ T: 'obu.FUTURES', dp: '50', t: 'snapshot', d: { s: 'XBTUSDTM', b: [['80000', '1000']], a: [['80001', '500']] } }));
  assert.equal(perp.valued(Date.now())!.bids.usd[0], 80_000, '1,000 contracts are one BTC');
  perp.onMessage(msg({ T: 'obu.FUTURES', dp: 'increment', t: 'delta', d: { s: 'XBTUSDTM', b: [['1', '1']], a: [['2', '1']] } }));
  assert.equal(perp.valued(Date.now())!.bids.lo[0], 80_000, 'a delta is not the depth-50 book');
  perp.onMessage(msg({ T: 'trade.FUTURES', d: { S: 'buy', q: '2', p: '80000', ti: 'k1', s: 'XBTUSDTM', M: 1_700_000_000_000_000_000 } }));
  assert.deepEqual(got.map(t => [t.tradeId, t.amount, t.notionalUsd]), [['k1', 0.002, 160]]);
  perp.onMessage(msg({ id: '1', result: false, message: 'no' }));
  assert.equal(perp.state, 'error');
  perp.stop();
  const spot = new KucoinSpotConnector(), spotTrades = trades(spot);
  const spotSent: { tradeType: string; symbol: string }[] = [];
  inside(spot).open(p => spotSent.push(p as { tradeType: string; symbol: string }));
  assert.deepEqual(spotSent.map(s => [s.tradeType, s.symbol]), [['SPOT', 'BTC-USDT'], ['SPOT', 'BTC-USDT']]);
  live(spot);
  spot.onMessage(msg({ T: 'trade.SPOT', d: { S: 'sell', q: '0.1', p: '80000', ti: 's1', s: 'BTC-USDT', M: 1_700_000_000_000_000_000 } }));
  assert.deepEqual(spotTrades.map(t => [t.side, t.amount]), [['sell', 0.1]]);
});

test('Bitfinex counts an execution once and keeps the book by price, count and signed amount', () => {
  const c = new BitfinexPerpConnector(), got = trades(c);
  assert.equal(c.instrumentId, 'bitfinex:tBTCF0:USTF0'); assert.equal(c.quote, 'USDT');
  const sent: unknown[] = []; inside(c).open(p => sent.push(p));
  assert.equal((sent[0] as { symbol: string }).symbol, 'tBTCF0:USTF0');
  live(c);
  c.onMessage(msg({ event: 'subscribed', channel: 'book', chanId: 11, symbol: 'tBTCF0:USTF0' }));
  c.onMessage(msg({ event: 'subscribed', channel: 'trades', chanId: 22, symbol: 'tBTCF0:USTF0' }));
  c.onMessage(msg([22, [[1, 1_700_000_000_000, 0.5, 80_000]]]));
  c.onMessage(msg([11, [[80_000, 2, 0.5], [80_010, 1, -0.25]]]));
  assert.equal(c.valued(Date.now())!.bids.usd[0], 40_000);
  c.onMessage(msg([11, [80_000, 0, 1]]));
  assert.equal(c.valued(Date.now()), null, 'the only bid was removed');
  c.onMessage(msg([11, [79_000, 1, 0.1]]));
  c.onMessage(msg([22, 'te', [9, 1_700_000_000_001, -0.2, 80_010]]));
  c.onMessage(msg([22, 'tu', [9, 1_700_000_000_001, -0.2, 80_010]]));
  c.onMessage(msg([22, 'hb']));
  assert.equal(c.valued(Date.now())!.bids.lo[0], 79_000);
  assert.deepEqual(got.map(t => [t.tradeId, t.side, t.amount]), [['9', 'sell', 0.2]]);
  assert.equal(new BitfinexSpotConnector().symbol, 'tBTCUSD');
});

test('Bitstamp keeps the hyphen in the perpetual channel and reads a buy from type 0', () => {
  const perp = new BitstampPerpConnector(), got = trades(perp);
  assert.equal(perp.instrumentId, 'bitstamp:btcusd-perp'); assert.equal(perp.marketType, 'perpetual');
  const sent: { event: string; data: { channel: string } }[] = [];
  inside(perp).open(p => sent.push(p as { event: string; data: { channel: string } }));
  assert.deepEqual(sent.map(s => s.data.channel), ['order_book_btcusd-perp', 'live_trades_btcusd-perp']);
  live(perp);
  perp.onMessage(msg({ event: 'data', channel: 'order_book_btcusd-perp', data: { bids: [['80000', '0.5']], asks: [['80001', '0.25']] } }));
  assert.equal(perp.valued(Date.now())!.bids.usd[0], 40_000);
  perp.onMessage(msg({ event: 'trade', channel: 'live_trades_btcusd-perp', data: { id: 4, price: '80000', amount: '0.1', type: 0, microtimestamp: '1700000000000000' } }));
  perp.onMessage(msg({ event: 'trade', channel: 'live_trades_btcusd', data: { id: 5, price: '1', amount: '1', type: 1, microtimestamp: '1700000000000000' } }));
  assert.deepEqual(got.map(t => [t.tradeId, t.side, t.notionalUsd, t.t]), [['4', 'buy', 8_000, 1_700_000_000_000]]);
  const spot = new BitstampSpotConnector();
  const spotSent: { data: { channel: string } }[] = [];
  inside(spot).open(p => spotSent.push(p as { data: { channel: string } }));
  assert.deepEqual(spotSent.map(s => s.data.channel), ['order_book_btcusd', 'live_trades_btcusd']);
});

test('the nine exchanges are recommended in the browser and on the server, and the server opens no second trade socket', () => {
  const ids = ['gateio', 'gateiospot', 'mexc', 'mexcspot', 'htx', 'htxspot', 'whitebit', 'whitebitspot', 'cryptocom', 'cryptocomspot', 'bingx', 'bingxspot', 'kucoin', 'kucoinspot', 'bitfinex', 'bitfinexspot', 'bitstamp', 'bitstampspot'];
  for (const id of ids) {
    const venue = BROWSER_VENUES.find(v => v.id === id);
    assert.equal(venue?.recommended, true, id);
    assert.equal(venue?.probe, null, id);
    assert.ok(RECOMMENDED_EXTRA_VENUES.includes(id), id);
    assert.equal(CONNECTOR_FACTORIES[id]!().id, id);
  }
  assert.equal(BROWSER_VENUES.filter(v => v.recommended).length, 32);
  assert.equal(familyKey('gateiospot'), 'gateio');
  assert.equal(familyKey('bingxspot'), 'bingx');
  assert.equal(markOf('bingx').text, 'BN');
  assert.equal(markOf('bingxspot').spot, true);
  const sources = new FlowSources(() => {});
  try {
    sources.sync(new Set(ids.map(id => BROWSER_VENUES.find(v => v.id === id)!.make().book.instrumentId)));
    assert.deepEqual(sources.active, []);
  } finally { sources.close(); }
});

test('a slow gzipped frame cannot land after a newer one, and a frame already in flight is dropped once the connection ends', async () => {
  class Held extends BookConnector {
    readonly id = 'held'; readonly name = 'Held'; readonly symbol = 'BTC'; readonly quote = 'USD'; readonly marketType = 'perpetual' as const;
    seen: string[] = [];
    protected url() { return 'wss://example.invalid/held'; }
    protected open() { /* the test never opens a socket */ }
    override decode(data: unknown): string | Promise<string> {
      const text = String(data);
      if (text === 'sync') return text;
      return new Promise(resolve => setTimeout(() => resolve(text), text === 'slow' ? 30 : 0));
    }
    onMessage(text: string) { this.seen.push(text); }
  }
  const c = new Held();
  c.state = 'live';
  c.receive('sync');
  assert.deepEqual(c.seen, ['sync'], 'a text frame is still applied before receive returns');
  c.receive('slow');
  c.receive('fast');
  assert.deepEqual(c.seen, ['sync'], 'the frame that decompresses first waits for the one that arrived before it');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(c.seen, ['sync', 'slow', 'fast']);

  const dropped = new Held();
  dropped.state = 'live';
  dropped.receive('slow');
  dropped.stop();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(dropped.seen, [], 'gunzip finishing after the socket was closed does not change the book');
});

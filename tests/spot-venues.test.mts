import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_VENUES, BitgetConnector, BitgetSpotConnector, BybitSpotConnector, HyperliquidSpotConnector, KrakenPerpConnector, KrakenSpotConnector, OkxConnector, OkxSpotConnector, restoreSelection } from '../src/shared/venues.ts';
import { krakenBookChecksum } from '../src/adapters/kraken.mts';
import type { BookConnector, TradeEvent } from '../src/shared/connector.ts';
import { fetchCandles } from '../src/shared/history.ts';
import { FlowSources } from '../src/server/v2/flow-sources.mts';
import { CONNECTOR_FACTORIES } from '../src/server/v2/connectors.mts';
import { RECOMMENDED_EXTRA_VENUES } from '../src/server/v2/venues.mts';

type Inside = { url(): string; open(send: (p: unknown) => void): void; usdOf(price: number, size: number): number };
const inside = (c: BookConnector): Inside => c as unknown as Inside;
const trades = (c: BookConnector): TradeEvent[] => { const out: TradeEvent[] = []; c.onTrade = t => { out.push(t); }; return out; };
const msg = (value: unknown): string => JSON.stringify(value);

test('OKX spot sizes are BTC, not contracts, while the swap keeps its contract size', () => {
  const spot = new OkxSpotConnector(), swap = new OkxConnector();
  assert.equal(spot.instrumentId, 'okxspot:BTC-USDT'); assert.equal(spot.marketType, 'spot');
  const got = trades(spot);
  spot.onMessage(msg({ arg: { channel: 'trades', instId: 'BTC-USDT' }, data: [{ tradeId: '1', px: '80000', sz: '0.5', side: 'sell', ts: '1700000000000' }] }));
  assert.deepEqual(got.map(t => [t.side, t.amount, t.notionalUsd]), [['sell', 0.5, 40_000]], '0.5 BTC is $40,000, not $400');
  assert.equal(inside(spot).usdOf(80_000, 1), 80_000, 'a book level of 1 BTC');
  assert.equal(inside(swap).usdOf(80_000, 1), 800, 'the swap: one contract is 0.01 BTC');
  const sent: unknown[] = []; inside(spot).open(p => sent.push(p));
  assert.deepEqual(sent, [{ op: 'subscribe', args: [{ channel: 'books', instId: 'BTC-USDT' }, { channel: 'trades', instId: 'BTC-USDT' }] }]);
});

test('Bybit spot is the spot stream, and its seq names the order its fills belong to', () => {
  const c = new BybitSpotConnector();
  assert.equal(c.instrumentId, 'bybitspot:BTCUSDT'); assert.equal(inside(c).url(), 'wss://stream.bybit.com/v5/public/spot');
  const got = trades(c);
  c.onMessage(msg({ topic: 'publicTrade.BTCUSDT', data: [{ i: 'a', T: 1700000000000, p: '80000', v: '0.25', S: 'Buy', seq: 77 }, { i: 'b', T: 1700000000000, p: '80001', v: '0.25', S: 'Buy', seq: 77 }] }));
  assert.deepEqual(got.map(t => [t.tradeId, t.side, t.notionalUsd, t.order]), [['a', 'buy', 20_000, '77'], ['b', 'buy', 20_000.25, '77']]);
});

test('Bitget leaves out the trades it sends as a snapshot on subscribing, on spot and on the perpetual', () => {
  for (const c of [new BitgetSpotConnector(), new BitgetConnector()]) {
    const got = trades(c);
    c.onMessage(msg({ action: 'snapshot', arg: { channel: 'trade' }, data: [{ tradeId: 'old', price: '80000', size: '1', side: 'buy', ts: '1700000000000' }] }));
    c.onMessage(msg({ action: 'update', arg: { channel: 'trade' }, data: [{ tradeId: 'new', price: '80000', size: '0.1', side: 'sell', ts: '1700000000001' }] }));
    assert.deepEqual(got.map(t => t.tradeId), ['new'], c.id);
  }
  const sent: unknown[] = []; inside(new BitgetSpotConnector()).open(p => sent.push(p));
  assert.deepEqual(sent, [{ op: 'subscribe', args: [{ instType: 'SPOT', channel: 'books', instId: 'BTCUSDT' }, { instType: 'SPOT', channel: 'trade', instId: 'BTCUSDT' }] }]);
});

test('the three spot markets are recommended, in the browser and on the server, and each is a connector the server can make', () => {
  for (const id of ['bybitspot', 'okxspot', 'bitgetspot']) {
    const venue = BROWSER_VENUES.find(v => v.id === id);
    assert.ok(venue?.recommended, id); assert.equal(venue.kind, 'spot');
    assert.ok(RECOMMENDED_EXTRA_VENUES.includes(id), id); assert.ok(CONNECTOR_FACTORIES[id], id);
    assert.equal(CONNECTOR_FACTORIES[id]!().marketType, 'spot');
  }
});

test('a saved venue choice gains the recommended venues added since it was made, and keeps out one it had seen and left out', () => {
  const venues = [{ id: 'binance', recommended: true }, { id: 'coinbase', recommended: true }, { id: 'okxspot', recommended: true }, { id: 'small', recommended: false }];
  assert.equal(restoreSelection(null, null, venues), null, 'no saved choice: the recommended set');
  assert.deepEqual(restoreSelection(['binance'], null, venues), ['binance', 'okxspot'], 'a save from before the list was kept knew the first eight');
  assert.deepEqual(restoreSelection(['binance'], ['binance', 'coinbase', 'okxspot', 'small'], venues), ['binance'], 'seen and left out: stays out');
  assert.deepEqual(restoreSelection(['binance', 'okxspot'], ['binance', 'coinbase'], venues), ['binance', 'okxspot'], 'never twice');
});

test('the server opens no second socket for the spot venues: their connector venues carry their own trades', () => {
  const sources = new FlowSources(() => {});
  try {
    sources.sync(new Set(['bybitspot:BTCUSDT', 'okxspot:BTC-USDT', 'bitgetspot:BTCUSDT', 'hyperliquidspot:@142', 'kraken:PF_XBTUSD', 'krakenspot:BTC/USD']));
    assert.deepEqual(sources.active, []);
  } finally { sources.close(); }
});

test('Hyperliquid spot subscribes to the UBTC/USDC pair and ignores another coin on the same socket', () => {
  const c = new HyperliquidSpotConnector();
  assert.equal(c.instrumentId, 'hyperliquidspot:@142'); assert.equal(c.marketType, 'spot'); assert.equal(c.quote, 'USDC');
  const sent: unknown[] = []; inside(c).open(p => sent.push(p));
  assert.deepEqual(sent, [{ method: 'subscribe', subscription: { type: 'l2Book', coin: '@142' } }, { method: 'subscribe', subscription: { type: 'trades', coin: '@142' } }]);
  const got = trades(c);
  c.onMessage(msg({ channel: 'l2Book', data: { coin: 'BTC', levels: [[{ px: '1', sz: '1' }], [{ px: '2', sz: '1' }]] } }));
  c.onMessage(msg({ channel: 'l2Book', data: { coin: '@142', levels: [[{ px: '80000', sz: '0.5', n: 1 }], [{ px: '80001', sz: '0.25', n: 1 }]] } }));
  c.onMessage(msg({ channel: 'trades', data: [{ coin: '@142', side: 'A', px: '80000', sz: '0.1', time: 1700000000000, tid: 7, hash: '0xabc' }, { coin: 'BTC', side: 'B', px: '1', sz: '1', time: 1700000000000, tid: 8, hash: '0xdef' }] }));
  assert.deepEqual(got.map(t => [t.instrumentId, t.side, t.notionalUsd, t.order]), [['hyperliquidspot:@142', 'sell', 8000, '0xabc']]);
  const venue = BROWSER_VENUES.find(v => v.id === 'hyperliquidspot');
  assert.equal(venue?.recommended, true); assert.equal(venue?.kind, 'spot');
  assert.ok(RECOMMENDED_EXTRA_VENUES.includes('hyperliquidspot')); assert.equal(CONNECTOR_FACTORIES.hyperliquidspot!().marketType, 'spot');
});

test('spot candles: OKX spot volume is the coin column, and Bitget spot names its intervals its own way', async () => {
  const asked: string[] = [];
  const okx = await fetchCandles('okxspot:BTC-USDT', 60_000, 0, 120_000, async url => { asked.push(url); return { data: [['60000', '1', '2', '0.5', '1.5', '3.25', '260000', '260000', '1']] }; });
  assert.equal(okx[0]?.[5], 3.25, 'BTC, not USDT');
  assert.match(asked[0]!, /instId=BTC-USDT&/);
  await fetchCandles('bitgetspot:BTCUSDT', 60_000, 0, 120_000, async url => { asked.push(url); return { data: [] }; });
  assert.match(asked.find(u => u.includes('bitget')) ?? '', /spot\/market\/candles\?symbol=BTCUSDT&granularity=1min&/);
  await fetchCandles('bybitspot:BTCUSDT', 60_000, 0, 120_000, async url => { asked.push(url); return { result: { list: [] } }; });
  assert.match(asked.find(u => u.includes('bybit')) ?? '', /category=spot&symbol=BTCUSDT&interval=1&/);
  await fetchCandles('hyperliquidspot:@142', 60_000, 0, 120_000, async (_url, init) => { asked.push(init?.body ?? ''); return [{ t: 60_000, o: '1', h: '2', l: '0.5', c: '1.5', v: '3' }]; });
  assert.match(asked.at(-1) ?? '', /"coin":"@142"/);
  const kraken = await fetchCandles('krakenspot:BTC/USD', 60_000, 0, 120_000, async url => { asked.push(url); return { error: [], result: { 'BTC/USD': [[60, '1', '2', '0.5', '1.5', '1.2', '0.25', 3]], last: 60 } }; });
  assert.equal(kraken[0]?.[5], 0.25, 'BTC, the volume column');
  assert.match(asked.at(-1) ?? '', /pair=BTC%2FUSD&interval=1&since=/);
});

/** A Kraken spot book frame. `book` is the book after the frame (the checksum is of that, not of the changes alone). */
function krakenBook(type: 'snapshot' | 'update', bids: [string, string][], asks: [string, string][], book: { bids: [string, string][]; asks: [string, string][] } = { bids, asks }): string {
  const level = ([price, qty]: [string, string]) => ({ price, qty, numericPrice: Number(price), numericQty: Number(qty) });
  const checksum = krakenBookChecksum({ bids: book.bids.map(level), asks: book.asks.map(level) });
  const side = (rows: [string, string][]) => rows.map(([price, qty]) => `{"price":${price},"qty":${qty}}`).join(',');
  return `{"channel":"book","type":"${type}","data":[{"symbol":"BTC/USD","bids":[${side(bids)}],"asks":[${side(asks)}],"checksum":${checksum}}]}`;
}

test('Kraken spot keeps the book by its checksum, and Kraken\'s perpetual chains on the sequence and skips the trade snapshot', () => {
  const spot = new KrakenSpotConnector();
  assert.equal(spot.instrumentId, 'krakenspot:BTC/USD'); assert.equal(spot.marketType, 'spot'); assert.equal(spot.quote, 'USD');
  const got = trades(spot);
  spot.state = 'connecting';
  spot.onMessage(krakenBook('update', [['100', '1']], []));
  assert.equal(spot.valued(Date.now()), null, 'an update before the snapshot is not a book');
  spot.onMessage(krakenBook('snapshot', [['81621.2', '0.5'], ['81600.0', '1.25']], [['81621.3', '0.25']]));
  const book = spot.valued(Date.now())!;
  assert.equal(book.bids.lo[0], 81621.2); assert.equal(book.bids.usd[0], 81621.2 * 0.5);
  assert.equal(book.asks.usd[0], 81621.3 * 0.25);
  spot.onMessage(krakenBook('update', [['81621.2', '0']], [['81630.0', '2']], { bids: [['81600.0', '1.25']], asks: [['81621.3', '0.25'], ['81630.0', '2']] }));
  const next = spot.valued(Date.now())!;
  assert.equal(next.bids.lo[0], 81600); assert.equal(next.asks.lo[1], 81630);
  spot.onMessage('{"channel":"trade","type":"update","data":[{"symbol":"BTC/USD","side":"sell","price":80000.0,"qty":0.1,"trade_id":9,"timestamp":"2026-10-23T13:21:33.764Z"},{"symbol":"ETH/USD","side":"buy","price":1,"qty":1,"trade_id":10,"timestamp":"2026-10-23T13:21:33.764Z"}]}');
  assert.deepEqual(got.map(t => [t.instrumentId, t.side, t.amount, t.notionalUsd]), [['krakenspot:BTC/USD', 'sell', 0.1, 8000]]);
  spot.onMessage(krakenBook('update', [['81600.0', '9']], [], { bids: [['81600.0', '9']], asks: [['81621.3', '0.25'], ['81630.0', '2']] }).replace(/"checksum":\d+/, '"checksum":1'));
  assert.equal(spot.state, 'error'); assert.match(spot.lastError ?? '', /checksum/);

  const perp = new KrakenPerpConnector(), perpTrades = trades(perp);
  assert.equal(perp.instrumentId, 'kraken:PF_XBTUSD'); assert.equal(perp.marketType, 'perpetual');
  assert.equal(BROWSER_VENUES.find(v => v.id === 'kraken')!.probe, null, 'the futures REST API cannot be read from a page');
  perp.state = 'connecting';
  perp.onMessage(msg({ feed: 'book', product_id: 'PF_XBTUSD', side: 'buy', seq: 2, price: 80_000, qty: 1 }));
  assert.equal(perp.valued(Date.now()), null, 'no snapshot yet');
  perp.onMessage(msg({ feed: 'book_snapshot', product_id: 'PF_XBTUSD', seq: 10, bids: [{ price: 80_000, qty: 0.5 }, { price: 79_000, qty: 1 }], asks: [{ price: 80_001, qty: 0.25 }, { price: 80_010, qty: 1 }] }));
  perp.onMessage(msg({ feed: 'trade_snapshot', product_id: 'PF_XBTUSD', trades: [{ feed: 'trade', product_id: 'PF_XBTUSD', uid: 'old', side: 'buy', qty: 1, price: 80_000, time: 1 }] }));
  perp.onMessage(msg({ feed: 'book', product_id: 'PF_XBTUSD', side: 'sell', seq: 11, price: 80_001, qty: 0 }));
  perp.onMessage(msg({ feed: 'book', product_id: 'PI_XBTUSD', side: 'buy', seq: 12, price: 1, qty: 5 }));
  perp.onMessage(msg({ feed: 'trade', product_id: 'PF_XBTUSD', uid: 'new', side: 'buy', type: 'fill', qty: 0.2, price: 80_000, time: 1_700_000_000_000 }));
  const held = perp.valued(Date.now())!;
  assert.deepEqual([...held.asks.lo], [80_010], 'the near ask was removed and the further one stays');
  assert.equal(held.bids.usd[0], 80_000 * 0.5, 'a quantity is BTC');
  assert.deepEqual(perpTrades.map(t => [t.tradeId, t.notionalUsd]), [['new', 16_000]], 'the snapshot of recent fills is not counted');
  perp.onMessage(msg({ feed: 'book', product_id: 'PF_XBTUSD', side: 'buy', seq: 13, price: 70_000, qty: 1 }));
  assert.equal(perp.state, 'error'); assert.match(perp.lastError ?? '', /sequence gap 11 -> 13/);
  assert.ok(RECOMMENDED_EXTRA_VENUES.includes('kraken') && RECOMMENDED_EXTRA_VENUES.includes('krakenspot'));
  assert.equal(CONNECTOR_FACTORIES.kraken!().marketType, 'perpetual');
  assert.equal(CONNECTOR_FACTORIES.krakenspot!().instrumentId, 'krakenspot:BTC/USD');
});

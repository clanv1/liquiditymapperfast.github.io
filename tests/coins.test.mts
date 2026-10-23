import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BTC, COIN_VENUES, KEEP_MARKETS, MARKET_LISTS, MIN_MARKETS, ONLY_BTC, buildCatalogue, fetchLists, instrumentIdFor, parseCatalogue, scaleOf, steadyTier, tierFor, unitOf, type Catalogue, type CoinVenue, type ListRow } from '../src/shared/coins.ts';
import { CoinList } from '../src/server/v2/coin-list.mts';

const NOW = Date.UTC(2026, 9, 7, 12);
const row = (coin: string, price: number, volumeUsd = 1e6, listing: Partial<ListRow['listing']> = {}): ListRow => ({ coin, price, volumeUsd, listing: { symbol: `${coin}USDT`, unit: 1, ...listing } });
/** Every market lists BTC and the given coins at their price (a market can be left out of a coin, or given another price). */
function lists(coins: Record<string, { price: number; on?: readonly CoinVenue[]; off?: readonly CoinVenue[]; at?: Partial<Record<CoinVenue, number>> }>, btcVolume = 1e10): Record<CoinVenue, ListRow[]> {
  const out = {} as Record<CoinVenue, ListRow[]>;
  for (const v of COIN_VENUES) {
    out[v] = [row('BTC', 80_000, btcVolume / COIN_VENUES.length)];
    for (const [coin, c] of Object.entries(coins)) if ((c.on ?? COIN_VENUES).includes(v) && !(c.off ?? []).includes(v)) out[v].push(row(coin, c.at?.[v] ?? c.price, 1e8 / COIN_VENUES.length));
  }
  return out;
}
const coinOf = (c: Catalogue, name: string) => c.coins.find(x => x.coin === name);

test('a listing in thousands is named for the coin and carries its unit; only the markets that write it so are read that way', () => {
  assert.deepEqual(unitOf('1000PEPE', 'binance'), ['PEPE', 1000]);
  assert.deepEqual(unitOf('1000000MOG', 'bitget'), ['MOG', 1_000_000]);
  assert.deepEqual(unitOf('kPEPE', 'hyperliquid'), ['PEPE', 1000]);
  assert.deepEqual(unitOf('kPEPE', 'binance'), ['kPEPE', 1], 'the k prefix is Hyperliquid\'s');
  assert.deepEqual(unitOf('SHIB1000', 'bybit'), ['SHIB', 1000]);
  assert.deepEqual(unitOf('SHIB1000', 'okx'), ['SHIB1000', 1], 'the suffix is Bybit\'s');
  assert.deepEqual(unitOf('1INCH', 'binance'), ['1INCH', 1], 'a name that starts with a digit is not a unit');
});

test('each market\'s list is read into coin, listing, price of one coin and volume', () => {
  const read = (v: CoinVenue, ...answers: unknown[]): ListRow[] => MARKET_LISTS[v].read(answers, NOW);
  assert.deepEqual(read('binance', [{ symbol: '1000PEPEUSDT', lastPrice: '0.004', quoteVolume: '5000', closeTime: NOW }, { symbol: 'OLDUSDT', lastPrice: '1', quoteVolume: '0', closeTime: NOW - 9e9 }]),
    [{ coin: 'PEPE', listing: { symbol: '1000PEPEUSDT', unit: 1000 }, price: 0.004 / 1000, volumeUsd: 5000 }], 'a settled contract is left out');
  const okx = read('okx', { data: [{ instId: 'DOGE-USDT-SWAP', last: '0.1', volCcy24h: '1000' }, { instId: 'XYZ-USDT-SWAP', last: '1', volCcy24h: '1' }] },
    { data: [{ instId: 'DOGE-USDT-SWAP', state: 'live', ctVal: '1000', ctValCcy: 'DOGE' }, { instId: 'XYZ-USDT-SWAP', state: 'live', ctVal: '1', ctValCcy: 'USDT' }] });
  assert.deepEqual(okx, [{ coin: 'DOGE', listing: { symbol: 'DOGE-USDT-SWAP', contract: 1000, unit: 1 }, price: 0.1, volumeUsd: 100 }], 'a swap is kept only with a contract size in its own coin');
  assert.deepEqual(read('hyperliquid', [{ universe: [{ name: 'kPEPE' }, { name: 'GONE', isDelisted: true }] }, [{ markPx: '0.004', dayNtlVlm: '9' }, { markPx: '1', dayNtlVlm: '1' }]]),
    [{ coin: 'PEPE', listing: { symbol: 'kPEPE', unit: 1000 }, price: 0.004 / 1000, volumeUsd: 9 }]);
  const deribit = read('deribit', { result: [{ instrument_name: 'ETH-PERPETUAL', base_currency: 'ETH', mark_price: 2500, volume_usd: 7 }, { instrument_name: 'ETH-27MAR26', base_currency: 'ETH', mark_price: 2500 }] },
    { result: [{ instrument_name: '1000PEPE_USDC-PERPETUAL', base_currency: '1000PEPE', mark_price: 0.004, volume_usd: 3 }] });
  assert.deepEqual(deribit, [{ coin: 'ETH', listing: { symbol: 'ETH-PERPETUAL', inverse: true, unit: 1 }, price: 2500, volumeUsd: 7 }, { coin: 'PEPE', listing: { symbol: '1000PEPE_USDC-PERPETUAL', unit: 1000 }, price: 0.004 / 1000, volumeUsd: 3 }], 'dated futures are left out');
  assert.deepEqual(read('coinbase', { 'SOL-USD': { stats_24hour: { last: '100', volume: '2' } }, 'SOL-EUR': { stats_24hour: { last: '90', volume: '2' } } }), [{ coin: 'SOL', listing: { symbol: 'SOL-USD', unit: 1 }, price: 100, volumeUsd: 200 }]);
});

test('another coin is never listed, however many markets name it', () => {
  const nine = buildCatalogue(lists({ AAA: { price: 2, off: ['deribit', 'coinbase'] }, BBB: { price: 3, off: ['deribit', 'coinbase', 'hyperliquid'] } }), null, NOW).catalogue;
  assert.equal(MIN_MARKETS, 9); assert.equal(KEEP_MARKETS, 8);
  assert.deepEqual(nine.coins.map(c => c.coin), ['BTC']);
  const later = buildCatalogue(lists({ AAA: { price: 2 }, BBB: { price: 3 }, LIT: { price: 1, at: { binancespot: 0.21 } } }), nine, NOW + 86_400_000).catalogue;
  assert.deepEqual(later.coins.map(c => c.coin), ['BTC']);
  assert.deepEqual(later.coins[0]!.markets, BTC.markets);
});

test('a market whose list fails is named, and the catalogue stays BTC with the built-in markets', () => {
  const first = buildCatalogue(lists({ AAA: { price: 2 } }), null, NOW).catalogue;
  const fresh = lists({ AAA: { price: 2 } }) as Partial<Record<CoinVenue, ListRow[] | null>>;
  fresh.binance = null; fresh.bybit = null;
  const { catalogue, notes } = buildCatalogue(fresh, first, NOW + 86_400_000);
  assert.deepEqual(catalogue.coins.map(c => c.coin), ['BTC']);
  assert.deepEqual(catalogue.coins[0]!.markets, BTC.markets);
  assert.equal(catalogue.lists.binance, NOW, 'the unread list keeps the time it was last read');
  assert.equal(catalogue.lists.okx, NOW + 86_400_000);
  assert.ok(notes.some(n => n.startsWith('binance: list not read')));
});

test('with too few lists the previous catalogue stands, and it is still only BTC', () => {
  const first = buildCatalogue(lists({ AAA: { price: 2 }, BBB: { price: 3 }, CCC: { price: 4 } }), null, NOW).catalogue;
  const few = lists({ AAA: { price: 2 } }) as Partial<Record<CoinVenue, ListRow[] | null>>;
  for (const v of COIN_VENUES.slice(0, 6)) few[v] = null;
  const kept = buildCatalogue(few, first, NOW + 1);
  assert.equal(kept.fresh, false);
  assert.equal(kept.catalogue.builtAt, first.builtAt);
  assert.deepEqual(kept.catalogue.coins.map(c => c.coin), ['BTC']);
  const none = buildCatalogue(few, null, NOW + 1);
  assert.equal(none.fresh, false, 'with nothing before it, too few lists is still no day\'s list');
  assert.deepEqual(none.catalogue.coins.map(c => c.coin), ['BTC']);
  assert.equal(buildCatalogue(lists({ AAA: { price: 2 } }), null, NOW).fresh, true);
  const again = buildCatalogue(lists({ AAA: { price: 2 } }), first, NOW + 1);
  assert.equal(again.fresh, true);
  assert.deepEqual(again.catalogue.coins.map(c => c.coin), ['BTC']);
  assert.ok(kept.notes.some(n => /previous catalogue stands/.test(n)));
});

test('BTC is first and always the built-in listing, whatever the lists say', () => {
  const odd = lists({}); odd.binance = [row('BTC', 80_000, 1e9, { symbol: 'BTCUSDC' })];
  const c = buildCatalogue(odd, null, NOW).catalogue;
  assert.equal(c.coins[0]!.coin, 'BTC'); assert.deepEqual(c.coins[0]!.markets, BTC.markets); assert.equal(c.coins[0]!.tier, 0);
  const parsed = parseCatalogue({ version: 1, coins: [{ coin: 'BTC', markets: { binance: { symbol: 'EVIL', unit: 1 } }, tier: 3, volumeUsd: 5, price: 7 }] })!;
  assert.deepEqual(parsed.coins[0]!.markets, BTC.markets); assert.equal(parsed.coins[0]!.tier, 0); assert.equal(parsed.coins[0]!.price, 7);
});

test('the tier follows the coin\'s volume against BTC\'s, and does not flip at the edge', () => {
  assert.deepEqual([1, 0.4, 0.39, 0.04, 0.0399, 0.004, 0.0004, 0.00001].map(tierFor), [0, 0, 1, 1, 2, 2, 3, 4]);
  assert.deepEqual([0, 1, 2, 3, 4].map(tier => scaleOf({ tier })), [1, 0.4, 0.1, 0.04, 0.01]);
  assert.equal(steadyTier(0.035, 1), 1, 'just under the boundary, the tier it had stands');
  assert.equal(steadyTier(0.015, 1), 2, 'well under it, it moves');
  assert.equal(steadyTier(0.035, undefined), 2);
  const c = buildCatalogue(lists({ BIG: { price: 1 } }, 1e8 * 2), null, NOW).catalogue;
  assert.equal(coinOf(c, 'BIG'), undefined, 'another coin is not given a tier');
  assert.equal(c.coins[0]!.tier, 0);
});

test('a list read from JSON drops what it cannot use and keeps the rest', () => {
  assert.equal(parseCatalogue({ version: 2, coins: [] }), null);
  assert.equal(parseCatalogue('nonsense'), null);
  const c = parseCatalogue({ version: 1, builtAt: NOW, lists: { binance: NOW, nowhere: 5 }, coins: [
    { coin: 'GOOD', markets: { binance: { symbol: 'GOODUSDT', unit: 1 }, okx: { symbol: 'GOOD-USDT-SWAP', unit: 1, contract: 10 } }, tier: 2, volumeUsd: 5, price: 1 },
    { coin: 'bad name', markets: { binance: { symbol: 'X', unit: 1 } }, tier: 1 },
    { coin: 'NOTIER', markets: { binance: { symbol: 'X', unit: 1 } }, tier: 9 },
    { coin: 'HALF', markets: { binance: { symbol: 'HALFUSDT', unit: 0 }, bybit: { symbol: 'HALF USDT', unit: 1 }, okx: { symbol: 'HALF-USDT-SWAP', unit: 1 } }, tier: 1 },
  ] })!;
  assert.deepEqual(c.coins.map(x => x.coin), ['BTC'], 'every coin other than BTC is left out');
  assert.deepEqual(c.coins[0]!.markets, BTC.markets);
  assert.deepEqual(c.lists, { binance: NOW });
  assert.deepEqual(ONLY_BTC.coins, [BTC]);
});

test('every market is asked once and a failing one is null', async () => {
  const asked: string[] = [];
  const got = await fetchLists(async url => { asked.push(url); if (url.includes('bybit')) throw new Error('403'); return url.includes('okx') ? { data: [] } : []; }, NOW);
  assert.equal(got.bybit, null); assert.equal(got.bybitspot, null);
  assert.equal(got.okx, null, 'a list that yields nothing is a failed one');
  assert.equal(new Set(asked).size, asked.length);
});

test('the shipped coin list is BTC alone, named the way the connectors name it', () => {
  const raw = JSON.parse(fs.readFileSync('src/app/public/coins.json', 'utf8')) as { coins: { coin: string }[] };
  assert.deepEqual(raw.coins.map(c => c.coin), ['BTC'], 'the file itself names no other coin');
  const shipped = parseCatalogue(raw);
  assert.ok(shipped, 'src/app/public/coins.json parses');
  assert.deepEqual(shipped.coins.map(c => c.coin), ['BTC']);
  assert.deepEqual(shipped.coins[0]!.markets, BTC.markets);
  assert.equal(instrumentIdFor('hyperliquid', BTC), 'hyperliquid:BTC-PERP');
  assert.equal(instrumentIdFor('hyperliquidspot', BTC), 'hyperliquidspot:@142', 'spot is BTC\'s built-in pair');
});

test('the server builds its own list, serves it, and keeps the last one when a build fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmf-coins-')), file = path.join(dir, 'coins.json'), shipped = path.join(dir, 'shipped.json');
  fs.writeFileSync(shipped, JSON.stringify(buildCatalogue(lists({}), null, NOW - 86_400_000).catalogue));
  let fail = false;
  const answers: Record<string, unknown> = {};
  const get = async (url: string) => { if (fail) throw new Error('offline'); return answers[url] ?? []; };
  const list = new CoinList(file, shipped, get, () => NOW);
  const sent: { status?: number; body?: string } = {};
  const res = { writeHead: (status: number) => { sent.status = status; }, end: (body: string) => { sent.body = body; } } as unknown as import('node:http').ServerResponse;
  assert.equal(list.send(res), false, 'nothing built yet: the page\'s own copy is served');
  fail = true;
  assert.equal(await list.refresh(), false);
  assert.equal(list.send(res), false, 'a build with no list read writes nothing'); assert.ok(!fs.existsSync(file));
  fail = false;
  // Nine markets answer (with BTC alone), enough for the day's list to be built.
  const ticker = [{ symbol: 'BTCUSDT', lastPrice: '80000', quoteVolume: '1', closeTime: NOW }], bybit = { result: { list: [{ symbol: 'BTCUSDT', lastPrice: '80000', turnover24h: '1' }] } }, bitget = { data: [{ symbol: 'BTCUSDT', lastPr: '80000', usdtVolume: '1' }] };
  const reply: Partial<Record<CoinVenue, unknown>> = { binance: ticker, binancespot: ticker, bybit, bybitspot: bybit, bitget, bitgetspot: bitget, okxspot: { data: [{ instId: 'BTC-USDT', last: '80000', volCcy24h: '1' }] },
    hyperliquid: [{ universe: [{ name: 'BTC' }] }, [{ markPx: '80000', dayNtlVlm: '1' }]], coinbase: { 'BTC-USD': { stats_24hour: { last: '80000', volume: '1' } } } };
  for (const v of COIN_VENUES) for (const u of MARKET_LISTS[v].urls) answers[u.url] = reply[v] ?? [];
  assert.equal(await list.refresh(), true);
  assert.ok(fs.existsSync(file));
  assert.equal(list.send(res), true); assert.equal(sent.status, 200);
  const served = parseCatalogue(JSON.parse(sent.body!))!;
  assert.deepEqual(served.coins.map(c => c.coin), ['BTC']); assert.equal(served.builtAt, NOW);
  list.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

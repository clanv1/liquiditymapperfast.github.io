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
  const spot = [{ tokens: [{ name: 'USDC', index: 0 }, { name: 'UBTC', index: 197 }, { name: 'HYPE', index: 150 }, { name: 'PURR', index: 1 }],
    universe: [{ name: '@142', index: 142, tokens: [197, 0] }, { name: '@107', index: 107, tokens: [150, 0] }, { name: 'PURR/USDC', index: 0, tokens: [1, 0] }, { name: '@234', index: 234, tokens: [197, 8] }] }];
  const ctx = (coin: string, mark: string, vol: string) => ({ coin, markPx: mark, dayNtlVlm: vol });
  const contexts: unknown[] = []; contexts[0] = ctx('PURR/USDC', '0.1', '5'); contexts[107] = ctx('@107', '40', '8'); contexts[142] = ctx('@142', '80000', '1000'); contexts[234] = ctx('@234', '80000', '1');
  assert.deepEqual(read('hyperliquidspot', [spot[0], contexts]), [
    { coin: 'BTC', listing: { symbol: '@142', unit: 1 }, price: 80000, volumeUsd: 1000 },
    { coin: 'HYPE', listing: { symbol: '@107', unit: 1 }, price: 40, volumeUsd: 8 },
    { coin: 'PURR', listing: { symbol: 'PURR/USDC', unit: 1 }, price: 0.1, volumeUsd: 5 },
  ], 'UBTC is BTC, a pair not quoted in USDC is left out, and a context is read at the pair index');
  const deribit = read('deribit', { result: [{ instrument_name: 'ETH-PERPETUAL', base_currency: 'ETH', mark_price: 2500, volume_usd: 7 }, { instrument_name: 'ETH-27MAR26', base_currency: 'ETH', mark_price: 2500 }] },
    { result: [{ instrument_name: '1000PEPE_USDC-PERPETUAL', base_currency: '1000PEPE', mark_price: 0.004, volume_usd: 3 }] });
  assert.deepEqual(deribit, [{ coin: 'ETH', listing: { symbol: 'ETH-PERPETUAL', inverse: true, unit: 1 }, price: 2500, volumeUsd: 7 }, { coin: 'PEPE', listing: { symbol: '1000PEPE_USDC-PERPETUAL', unit: 1000 }, price: 0.004 / 1000, volumeUsd: 3 }], 'dated futures are left out');
  assert.deepEqual(read('coinbase', { 'SOL-USD': { stats_24hour: { last: '100', volume: '2' } }, 'SOL-EUR': { stats_24hour: { last: '90', volume: '2' } } }), [{ coin: 'SOL', listing: { symbol: 'SOL-USD', unit: 1 }, price: 100, volumeUsd: 200 }]);
});

test('a coin on nine of the twelve markets is listed, on eight it is not; one already listed stays on eight', () => {
  const nine = buildCatalogue(lists({ AAA: { price: 2, off: ['deribit', 'coinbase', 'hyperliquidspot'] }, BBB: { price: 3, off: ['deribit', 'coinbase', 'hyperliquid', 'hyperliquidspot'] } }), null, NOW).catalogue;
  assert.equal(MIN_MARKETS, 9); assert.equal(KEEP_MARKETS, 8);
  assert.ok(coinOf(nine, 'AAA')); assert.equal(coinOf(nine, 'BBB'), undefined);
  const later = buildCatalogue(lists({ AAA: { price: 2, off: ['deribit', 'coinbase', 'hyperliquidspot', 'okxspot'] } }), nine, NOW + 86_400_000).catalogue;
  assert.ok(coinOf(later, 'AAA'), 'kept at eight');
  assert.equal(Object.keys(coinOf(later, 'AAA')!.markets).length, 8);
});

test('a market whose price is another token\'s is left out of the coin, and the coin is judged on the rest', () => {
  const c = buildCatalogue(lists({ LIT: { price: 1, at: { binancespot: 0.21 } } }), null, NOW).catalogue;
  const lit = coinOf(c, 'LIT')!;
  assert.equal(lit.markets.binancespot, undefined);
  assert.equal(Object.keys(lit.markets).length, 11);
});

test('a market whose list fails keeps its listings from the previous list, and says how old they are', () => {
  const first = buildCatalogue(lists({ AAA: { price: 2 } }), null, NOW).catalogue;
  const fresh = lists({ AAA: { price: 2 } }) as Partial<Record<CoinVenue, ListRow[] | null>>;
  fresh.binance = null; fresh.bybit = null;
  const { catalogue, notes } = buildCatalogue(fresh, first, NOW + 86_400_000);
  assert.deepEqual(coinOf(catalogue, 'AAA')!.markets.binance, coinOf(first, 'AAA')!.markets.binance);
  assert.equal(catalogue.lists.binance, NOW, 'the listings are as old as the list they came from');
  assert.equal(catalogue.lists.okx, NOW + 86_400_000);
  assert.ok(notes.some(n => n.startsWith('binance: list not read')));
});

test('with too few lists, or a list that loses a third of its coins, the previous list stands', () => {
  const first = buildCatalogue(lists({ AAA: { price: 2 }, BBB: { price: 3 }, CCC: { price: 4 } }), null, NOW).catalogue;
  const few = lists({ AAA: { price: 2 } }) as Partial<Record<CoinVenue, ListRow[] | null>>;
  // Six lists are the fewest a day's catalogue will accept, so one more than that has to fail.
  for (const v of COIN_VENUES.slice(0, 7)) few[v] = null;
  assert.equal(buildCatalogue(few, first, NOW + 1).catalogue, first);
  const none = buildCatalogue(few, null, NOW + 1);
  assert.equal(none.fresh, false, 'with nothing before it, too few lists is still no day\'s list');
  assert.deepEqual(none.catalogue.coins.map(c => c.coin), ['BTC']);
  assert.equal(buildCatalogue(lists({ AAA: { price: 2 } }), null, NOW).fresh, true);
  const lost = buildCatalogue(lists({ AAA: { price: 2 } }), first, NOW + 1);
  assert.equal(lost.catalogue, first);
  assert.ok(lost.notes.some(n => /previous catalogue stands/.test(n)));
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
  assert.equal(coinOf(c, 'BIG')!.tier, 0, 'half of BTC\'s volume is BTC\'s floors');
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
  assert.deepEqual(c.coins.map(x => x.coin), ['BTC', 'GOOD', 'HALF']);
  assert.deepEqual(Object.keys(c.coins[2]!.markets), ['okx'], 'a malformed listing is left out of its coin');
  assert.deepEqual(c.lists, { binance: NOW });
  assert.deepEqual(ONLY_BTC.coins, [BTC]);
  const spot = parseCatalogue({ version: 1, coins: [
    { coin: 'HYPE', markets: { hyperliquidspot: { symbol: '@107', unit: 1 } }, tier: 1, volumeUsd: 1, price: 40 },
    { coin: 'PURR', markets: { hyperliquidspot: { symbol: 'PURR/USDC', unit: 1 } }, tier: 1, volumeUsd: 1, price: 0.1 },
    { coin: 'BAD', markets: { hyperliquidspot: { symbol: '@142;drop', unit: 1 } }, tier: 1, volumeUsd: 1, price: 1 },
  ] })!;
  assert.equal(spot.coins.find(x => x.coin === 'HYPE')!.markets.hyperliquidspot!.symbol, '@107');
  assert.equal(spot.coins.find(x => x.coin === 'PURR')!.markets.hyperliquidspot!.symbol, 'PURR/USDC');
  assert.equal(spot.coins.find(x => x.coin === 'BAD'), undefined, 'a pair name with another mark is dropped, and a coin with nothing left is left out');
});

test('every market is asked once and a failing one is null', async () => {
  const asked: string[] = [];
  const got = await fetchLists(async (url, init) => { asked.push(url + (init?.body ?? '')); if (url.includes('bybit')) throw new Error('403'); return url.includes('okx') ? { data: [] } : []; }, NOW);
  assert.equal(got.bybit, null); assert.equal(got.bybitspot, null);
  assert.equal(got.okx, null, 'a list that yields nothing is a failed one');
  assert.equal(got.hyperliquid, null); assert.equal(got.hyperliquidspot, null);
  assert.equal(new Set(asked).size, asked.length, 'two Hyperliquid lists share the info address and differ by the body');
  assert.equal(asked.filter(item => item.startsWith('https://api.hyperliquid.xyz/info')).length, 2);
});

test('the shipped coin list is a list, BTC first, every coin on nine markets or more, and named the way the connectors name it', () => {
  const shipped = parseCatalogue(JSON.parse(fs.readFileSync('src/app/public/coins.json', 'utf8')));
  assert.ok(shipped, 'src/app/public/coins.json parses');
  assert.equal(shipped.coins[0]!.coin, 'BTC');
  assert.ok(shipped.coins.length > 100, `${shipped.coins.length} coins`);
  for (const c of shipped.coins.slice(1)) assert.ok(Object.keys(c.markets).length >= KEEP_MARKETS, c.coin);
  assert.equal(instrumentIdFor('hyperliquid', BTC), 'hyperliquid:BTC-PERP');
  assert.equal(instrumentIdFor('binance', shipped.coins.find(c => c.coin === 'PEPE')!), 'binance:1000PEPEUSDT');
});

test('the server builds its own list, serves it, and keeps the last one when a build fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmf-coins-')), file = path.join(dir, 'coins.json'), shipped = path.join(dir, 'shipped.json');
  fs.writeFileSync(shipped, JSON.stringify(buildCatalogue(lists({}), null, NOW - 86_400_000).catalogue));
  let fail = false;
  const answers: Record<string, unknown> = {};
  const get = async (url: string, init?: { body?: string }) => {
    if (fail) throw new Error('offline');
    if (url === 'https://api.hyperliquid.xyz/info') {
      const type = init?.body ? (JSON.parse(init.body) as { type?: string }).type : '';
      if (type === 'spotMetaAndAssetCtxs') {
        const contexts: unknown[] = [];
        contexts[142] = { coin: '@142', markPx: '80000', dayNtlVlm: '1' };
        return [{ tokens: [{ name: 'USDC', index: 0 }, { name: 'UBTC', index: 197 }], universe: [{ name: '@142', index: 142, tokens: [197, 0] }] }, contexts];
      }
      return reply.hyperliquid ?? [];
    }
    return answers[url] ?? [];
  };
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
  assert.equal(served.coins[0]!.coin, 'BTC'); assert.equal(served.builtAt, NOW);
  list.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

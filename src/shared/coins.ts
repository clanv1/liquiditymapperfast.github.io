/**
 * The page offers Bitcoin only. BTC's markets are built in (`BTC`); a catalogue read from JSON or built from the markets' public lists
 * keeps that one entry and drops every other coin, so the daily rebuild (`scripts/coins.mts`, the server, GitHub Actions) cannot put
 * another coin back. Building it is pure: the lists come in as parsed JSON, so a test can say what each market answered.
 *
 * The readers below still turn a market's public list into rows (a unit of 1000, an OKX contract size, Deribit's inverse perpetual).
 * `buildCatalogue` uses them for BTC's price and volume, and to say which lists were read.
 */

/** The markets there were before a saved venue choice recorded which ones it had seen (shared/venues.ts restoreSelection). */
export const EARLIER_BROWSER_VENUES: readonly string[] = ['binance', 'bybit', 'okx', 'bitget', 'hyperliquid', 'deribit', 'binancespot', 'coinbase'];

/** The eleven markets, as the venue ids the browser uses. A coin is listed by how many of these list it. */
export const COIN_VENUES = ['binance', 'binancespot', 'bybit', 'bybitspot', 'okx', 'okxspot', 'bitget', 'bitgetspot', 'hyperliquid', 'deribit', 'coinbase'] as const;
export type CoinVenue = (typeof COIN_VENUES)[number];
/**
 * Markets that do not count towards a coin's place in the list. MEXC's books are not readable by a page. Hyperliquid spot is BTC's
 * UBTC/USDC pair only: no other coin is listed there.
 */
export const OPTIONAL_VENUES = ['hyperliquidspot', 'mexc'] as const;
export type MarketVenue = CoinVenue | (typeof OPTIONAL_VENUES)[number];

/** How one market lists a coin. */
export interface Listing {
  /** The market's own name for it (BTCUSDT, BTC-USDT-SWAP, kPEPE, 1000PEPE_USDC-PERPETUAL). */
  symbol: string;
  /** Coins per listed unit: 1000 for 1000PEPEUSDT, whose price is that of 1000 coins and whose sizes count thousands. */
  unit: number;
  /** OKX swaps: listed units per contract (the instrument's ctVal). */
  contract?: number;
  /** Deribit's coin-margined perpetuals (BTC, ETH): sizes are USD. */
  inverse?: boolean;
}
export interface Coin {
  coin: string;
  /** How each market lists it: the eleven of COIN_VENUES, and an optional market where one is known (BTC's are built in). */
  markets: Partial<Record<MarketVenue, Listing>>;
  /** 24 h volume in USD over the markets that list it, and the price of one coin when the list was built. */
  volumeUsd: number; price: number;
  /** How much smaller than BTC's the size floors are: 0 is BTC's, each step down is SCALES[tier] (see `tierFor`). */
  tier: number;
}
export interface Catalogue {
  version: 1; builtAt: number;
  /** When each market's list was last read successfully: a market whose list failed keeps the listings it had (see `buildCatalogue`). */
  lists: Partial<Record<CoinVenue, number>>;
  coins: Coin[];
}

/** BTC as the page has always read it. It is never taken from a list, so a bad list cannot change it. */
export const BTC: Coin = {
  coin: 'BTC', volumeUsd: 0, price: 0, tier: 0,
  markets: {
    binance: { symbol: 'BTCUSDT', unit: 1 }, binancespot: { symbol: 'BTCUSDT', unit: 1 },
    bybit: { symbol: 'BTCUSDT', unit: 1 }, bybitspot: { symbol: 'BTCUSDT', unit: 1 },
    okx: { symbol: 'BTC-USDT-SWAP', unit: 1, contract: 0.01 }, okxspot: { symbol: 'BTC-USDT', unit: 1 },
    bitget: { symbol: 'BTCUSDT', unit: 1 }, bitgetspot: { symbol: 'BTCUSDT', unit: 1 },
    hyperliquid: { symbol: 'BTC', unit: 1 },
    // UBTC/USDC, the spot pair Hyperliquid names `@142` (the book and the trades subscribe with that name).
    hyperliquidspot: { symbol: '@142', unit: 1 },
    deribit: { symbol: 'BTC-PERPETUAL', unit: 1, inverse: true }, coinbase: { symbol: 'BTC-USD', unit: 1 },
    // Contracts of 0.0001 BTC (MEXC's contract detail; a page cannot read it, so it is written here).
    mexc: { symbol: 'BTC_USDT', unit: 1, contract: 0.0001 },
  },
};

/** How many of the eleven markets used to admit a coin. The catalogue no longer admits one by this count: it is BTC only. */
export const MIN_MARKETS = 9, KEEP_MARKETS = 8;
/** A day's list that reads fewer markets than this is not used: the previous catalogue stands (still BTC only). */
const MIN_LISTS = 6;
/** Names a market's list may use for a base. Anything else is not a row. */
const COIN_NAME = /^[A-Z0-9]{1,15}$/;

/**
 * Size floors (the smallest trade, absorption group and map cell recorded) for a coin of each tier, as a share of BTC's. The tier follows
 * the square root of the coin's volume against BTC's (trade sizes shrink more slowly than volume), on the steps 1, 0.4, 0.1, 0.04 and 0.01.
 */
export const SCALES: readonly number[] = [1, 0.4, 0.1, 0.04, 0.01];
/** The tier of a coin whose volume is `ratio` times BTC's: the boundaries sit at 0.4, 0.04, 0.004 and 0.0004. */
export function tierFor(ratio: number): number {
  let tier = 0;
  for (let bound = 0.4; tier < SCALES.length - 1 && !(ratio >= bound); bound /= 10) tier++;
  return tier;
}
/** The tier for `ratio`, keeping `previous` while the ratio is within a factor of two of the boundary between them. */
export function steadyTier(ratio: number, previous: number | undefined): number {
  const fresh = tierFor(ratio);
  if (previous === undefined || previous === fresh) return fresh;
  return previous >= tierFor(ratio * 2) && previous <= tierFor(ratio / 2) ? previous : fresh;
}
/** The size floors' multiplier for a coin (1 for BTC). */
export const scaleOf = (coin: Pick<Coin, 'tier'>): number => SCALES[Math.max(0, Math.min(SCALES.length - 1, coin.tier))]!;

// ---- Reading the markets' lists -----------------------------------------------------------------------------------------------------

/** One market's listing of one coin, as read from its list. */
export interface ListRow { coin: string; listing: Listing; price: number; volumeUsd: number }

export type ListFetcher = (url: string, init?: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;

const num = (value: unknown): number => Number(value);
const at = (value: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((v, key) => (v !== null && typeof v === 'object' ? (v as Record<string | number, unknown>)[key] : undefined), value);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const DAY_MS = 86_400_000;

/** The coin and its unit from a market's name for the base ("1000PEPE" is PEPE in thousands; Hyperliquid writes "kPEPE", Bybit "SHIB1000"). */
export function unitOf(raw: string, venue: CoinVenue): [string, number] {
  const m = /^(10{3,})([A-Z0-9]+)$/.exec(raw);
  if (m) return [m[2]!, Number(m[1])];
  const k = venue === 'hyperliquid' ? /^k([A-Z0-9]+)$/.exec(raw) : null;
  if (k) return [k[1]!, 1000];
  const suffix = venue === 'bybit' ? /^([A-Z]+)(10{3,})$/.exec(raw) : null;
  if (suffix) return [suffix[1]!, Number(suffix[2])];
  return [raw, 1];
}
const usdt = (symbol: string): string | null => symbol.endsWith('USDT') && symbol.length > 4 ? symbol.slice(0, -4) : null;

/** A row from a market's name for the base, its listed price and its volume; null when it is not a coin the page can name. */
function rowOf(venue: CoinVenue, raw: string | null, listing: Omit<Listing, 'unit'>, listedPrice: number, volumeUsd: number): ListRow | null {
  if (!raw) return null;
  const [coin, unit] = unitOf(raw, venue);
  if (!COIN_NAME.test(coin) || !(listedPrice > 0)) return null;
  return { coin, listing: { ...listing, unit }, price: listedPrice / unit, volumeUsd: Number.isFinite(volumeUsd) && volumeUsd > 0 ? volumeUsd : 0 };
}
const POST_JSON = { method: 'POST', headers: { 'content-type': 'application/json' } };

/** Each market's list: the requests (every one answers a page, with CORS) and how to read their answers. */
export const MARKET_LISTS: Readonly<Record<CoinVenue, { urls: { url: string; init?: { method: string; headers: Record<string, string>; body: string } }[]; read(answers: unknown[], now: number): ListRow[] }>> = {
  binance: {
    urls: [{ url: 'https://fapi.binance.com/fapi/v1/ticker/24hr' }],
    // Settled and halted contracts stay in the list with an old close time and no volume.
    read: ([tickers], now) => list(tickers).flatMap(t => num(at(t, 'closeTime')) > now - DAY_MS && num(at(t, 'quoteVolume')) > 0
      ? [rowOf('binance', usdt(text(at(t, 'symbol'))), { symbol: text(at(t, 'symbol')) }, num(at(t, 'lastPrice')), num(at(t, 'quoteVolume')))] : []).filter(r => r !== null),
  },
  binancespot: {
    urls: [{ url: 'https://api.binance.com/api/v3/ticker/24hr?type=MINI' }],
    read: ([tickers], now) => list(tickers).flatMap(t => num(at(t, 'closeTime')) > now - DAY_MS && num(at(t, 'quoteVolume')) > 0
      ? [rowOf('binancespot', usdt(text(at(t, 'symbol'))), { symbol: text(at(t, 'symbol')) }, num(at(t, 'lastPrice')), num(at(t, 'quoteVolume')))] : []).filter(r => r !== null),
  },
  bybit: {
    urls: [{ url: 'https://api.bybit.com/v5/market/tickers?category=linear' }],
    read: ([body]) => list(at(body, 'result', 'list')).map(t => num(at(t, 'turnover24h')) > 0 ? rowOf('bybit', usdt(text(at(t, 'symbol'))), { symbol: text(at(t, 'symbol')) }, num(at(t, 'lastPrice')), num(at(t, 'turnover24h'))) : null).filter(r => r !== null),
  },
  bybitspot: {
    urls: [{ url: 'https://api.bybit.com/v5/market/tickers?category=spot' }],
    read: ([body]) => list(at(body, 'result', 'list')).map(t => num(at(t, 'turnover24h')) > 0 ? rowOf('bybitspot', usdt(text(at(t, 'symbol'))), { symbol: text(at(t, 'symbol')) }, num(at(t, 'lastPrice')), num(at(t, 'turnover24h'))) : null).filter(r => r !== null),
  },
  okx: {
    // Sizes there are contracts, so a swap is listed only with its contract value (from the instrument list), in the coin it names.
    urls: [{ url: 'https://www.okx.com/api/v5/market/tickers?instType=SWAP' }, { url: 'https://www.okx.com/api/v5/public/instruments?instType=SWAP' }],
    read: ([tickers, instruments]) => {
      const contracts = new Map<string, { value: number; ccy: string }>();
      for (const i of list(at(instruments, 'data'))) if (at(i, 'state') === 'live') contracts.set(text(at(i, 'instId')), { value: num(at(i, 'ctVal')), ccy: text(at(i, 'ctValCcy')) });
      return list(at(tickers, 'data')).map(t => {
        const id = text(at(t, 'instId')), base = id.endsWith('-USDT-SWAP') ? id.slice(0, -'-USDT-SWAP'.length) : null, contract = contracts.get(id);
        if (!base || !contract || !(contract.value > 0) || contract.ccy !== base) return null;
        const price = num(at(t, 'last'));
        return rowOf('okx', base, { symbol: id, contract: contract.value }, price, num(at(t, 'volCcy24h')) * price);
      }).filter(r => r !== null);
    },
  },
  okxspot: {
    urls: [{ url: 'https://www.okx.com/api/v5/market/tickers?instType=SPOT' }],
    // On spot, volCcy24h is in the quote currency.
    read: ([body]) => list(at(body, 'data')).map(t => { const id = text(at(t, 'instId')); return id.endsWith('-USDT') ? rowOf('okxspot', id.slice(0, -5), { symbol: id }, num(at(t, 'last')), num(at(t, 'volCcy24h'))) : null; }).filter(r => r !== null),
  },
  bitget: {
    urls: [{ url: 'https://api.bitget.com/api/v2/mix/market/tickers?productType=usdt-futures' }],
    read: ([body]) => list(at(body, 'data')).map(t => num(at(t, 'usdtVolume')) > 0 ? rowOf('bitget', usdt(text(at(t, 'symbol'))), { symbol: text(at(t, 'symbol')) }, num(at(t, 'lastPr')), num(at(t, 'usdtVolume'))) : null).filter(r => r !== null),
  },
  bitgetspot: {
    urls: [{ url: 'https://api.bitget.com/api/v2/spot/market/tickers' }],
    read: ([body]) => list(at(body, 'data')).map(t => num(at(t, 'usdtVolume')) > 0 ? rowOf('bitgetspot', usdt(text(at(t, 'symbol'))), { symbol: text(at(t, 'symbol')) }, num(at(t, 'lastPr')), num(at(t, 'usdtVolume'))) : null).filter(r => r !== null),
  },
  hyperliquid: {
    urls: [{ url: 'https://api.hyperliquid.xyz/info', init: { ...POST_JSON, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) } }],
    read: ([body]) => {
      const universe = list(at(body, 0, 'universe')), contexts = list(at(body, 1));
      return universe.map((u, i) => at(u, 'isDelisted') === true ? null : rowOf('hyperliquid', text(at(u, 'name')), { symbol: text(at(u, 'name')) }, num(at(contexts, i, 'markPx')), num(at(contexts, i, 'dayNtlVlm')))).filter(r => r !== null);
    },
  },
  deribit: {
    // BTC and ETH have a coin-margined perpetual (sized in USD) and a USDC one; the coin-margined one is the market there.
    urls: ['BTC', 'ETH', 'USDC'].map(currency => ({ url: `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=future` })),
    read: answers => answers.flatMap(body => list(at(body, 'result'))).map(b => {
      const name = text(at(b, 'instrument_name'));
      const inverse = /^[A-Z]+-PERPETUAL$/.test(name), linear = /^[A-Z0-9]+_USDC-PERPETUAL$/.test(name);
      if (!inverse && !linear) return null;
      return rowOf('deribit', text(at(b, 'base_currency')), inverse ? { symbol: name, inverse: true } : { symbol: name }, num(at(b, 'mark_price')), num(at(b, 'volume_usd')));
    }).filter(r => r !== null),
  },
  coinbase: {
    urls: [{ url: 'https://api.exchange.coinbase.com/products/stats' }],
    read: ([stats]) => Object.entries(stats !== null && typeof stats === 'object' ? stats as Record<string, unknown> : {}).map(([id, s]) => {
      const last = num(at(s, 'stats_24hour', 'last')), volume = num(at(s, 'stats_24hour', 'volume'));
      return id.endsWith('-USD') && volume > 0 ? rowOf('coinbase', id.slice(0, -4), { symbol: id }, last, volume * last) : null;
    }).filter(r => r !== null),
  },
};

/** Read every market's list; a market whose requests fail, or whose answers yield nothing, is null (its previous listings stand). */
export async function fetchLists(get: ListFetcher, now: number): Promise<Record<CoinVenue, ListRow[] | null>> {
  const out = {} as Record<CoinVenue, ListRow[] | null>;
  await Promise.all(COIN_VENUES.map(async venue => {
    const spec = MARKET_LISTS[venue];
    try {
      const rows = spec.read(await Promise.all(spec.urls.map(u => get(u.url, u.init))), now);
      out[venue] = rows.length ? rows : null;
    } catch { out[venue] = null; }
  }));
  return out;
}

// ---- Building the catalogue ---------------------------------------------------------------------------------------------------------

const median = (values: readonly number[]): number => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
/** Six significant figures: the price is only a guide (the page's decimals, the list's sort), and the file should not carry float noise. */
const sig = (value: number): number => Number(value.toPrecision(6));

/**
 * The day's catalogue: BTC, with its built-in markets and the price and volume the lists reported for it. Every other row is ignored.
 * With too few lists the previous catalogue stands (and is still read back as BTC only); the reason is in `notes`.
 */
export function buildCatalogue(lists: Partial<Record<CoinVenue, ListRow[] | null>>, previous: Catalogue | null, now: number): { catalogue: Catalogue; notes: string[]; fresh: boolean } {
  const notes: string[] = [];
  const read = COIN_VENUES.filter(v => lists[v]?.length);
  for (const v of COIN_VENUES) if (!read.includes(v)) notes.push(`${v}: list not read${previous?.lists[v] ? `, keeping its listings from ${new Date(previous.lists[v]!).toISOString()}` : ''}`);
  // Too few lists is no day's list, whether or not there is one to keep (with none, BTC alone stands in, and `fresh` says it is not one).
  if (read.length < MIN_LISTS) { notes.push(`only ${read.length} lists read: ${previous ? 'the previous catalogue stands' : 'no list built'}`); return { catalogue: previous ? btcHeld(previous) : ONLY_BTC, notes, fresh: false }; }

  const btcRows = new Map<CoinVenue, ListRow>();
  for (const venue of read) for (const row of lists[venue]!) {
    if (row.coin !== 'BTC') continue;
    // One listing per market: the first, unless a coin-margined one comes later (Deribit lists both).
    const held = btcRows.get(venue);
    if (!held || (row.listing.inverse && !held.listing.inverse) || (!held.listing.inverse === !row.listing.inverse && row.volumeUsd > held.volumeUsd)) btcRows.set(venue, row);
  }
  const btcVolume = [...btcRows.values()].reduce((a, r) => a + r.volumeUsd, 0);
  const btcPrice = btcRows.size ? sig(median([...btcRows.values()].map(r => r.price))) : previous?.coins.find(c => c.coin === 'BTC')?.price ?? 0;
  return {
    catalogue: {
      version: 1, builtAt: now,
      lists: Object.fromEntries(COIN_VENUES.flatMap(v => read.includes(v) ? [[v, now]] : previous?.lists[v] ? [[v, previous.lists[v]!]] : [])),
      coins: [{ ...BTC, volumeUsd: Math.round(btcVolume), price: btcPrice }],
    },
    notes, fresh: true,
  };
}

// ---- Reading a catalogue ------------------------------------------------------------------------------------------------------------

/**
 * A catalogue from JSON, or null when it is not one. Every coin other than BTC is left out, and BTC is always the built-in entry (with
 * the list's price and volume), so an older file that named other coins cannot bring them back.
 */
export function parseCatalogue(value: unknown): Catalogue | null {
  if (at(value, 'version') !== 1 || !Array.isArray(at(value, 'coins'))) return null;
  let btc: Coin = BTC;
  for (const c of list(at(value, 'coins'))) {
    if (at(c, 'coin') !== 'BTC') continue;
    btc = { ...BTC, volumeUsd: Math.max(0, num(at(c, 'volumeUsd')) || 0), price: Math.max(0, num(at(c, 'price')) || 0) };
  }
  const lists: Partial<Record<CoinVenue, number>> = {};
  for (const v of COIN_VENUES) { const t = num(at(value, 'lists', v)); if (t > 0) lists[v] = t; }
  return { version: 1, builtAt: num(at(value, 'builtAt')) || 0, lists, coins: [btc] };
}

/** The catalogue that holds only BTC, for a page that could not read one. */
export const ONLY_BTC: Catalogue = { version: 1, builtAt: 0, lists: {}, coins: [BTC] };

/** A catalogue with every coin but BTC removed, and BTC's markets put back to the built-in entry. */
function btcHeld(catalogue: Catalogue): Catalogue {
  const btc = catalogue.coins.find(c => c.coin === 'BTC');
  return { ...catalogue, coins: [{ ...BTC, volumeUsd: btc?.volumeUsd ?? 0, price: btc?.price ?? 0 }] };
}

/** The instrument id a market's connector gives the coin there (the connectors in shared/venues.ts: "hyperliquid:BTC-PERP", "binance:BTCUSDT"), or null where it is not listed. */
export function instrumentIdFor(venue: string, coin: Coin): string | null {
  const listing = coin.markets[venue as MarketVenue];
  if (!listing) return null;
  return `${venue}:${venue === 'hyperliquid' ? `${listing.symbol}-PERP` : listing.symbol}`;
}

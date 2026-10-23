/** Display names for venue ids (the part of an instrument id before the colon). */
const NAMES: Readonly<Record<string, string>> = {
  aster: 'Aster', binance: 'Binance', binanceus: 'Binance US', binancespot: 'Binance spot', bitfinex: 'Bitfinex', bitget: 'Bitget', bitgetspot: 'Bitget spot', bitmart: 'BitMart', bitmex: 'BitMEX',
  bitstamp: 'Bitstamp', bitstampspot: 'Bitstamp spot', bitunix: 'Bitunix', bingx: 'BingX', bingxspot: 'BingX spot', bitfinexspot: 'Bitfinex spot', bybit: 'Bybit', bybitspot: 'Bybit spot', coinbase: 'Coinbase', cryptocom: 'Crypto.com', cryptocomspot: 'Crypto.com spot', deribit: 'Deribit', dydx: 'dYdX', gateio: 'Gate.io', gateiospot: 'Gate.io spot',
  hitbtc: 'HitBTC', htx: 'HTX', htxspot: 'HTX spot', hyperliquid: 'Hyperliquid', hyperliquidspot: 'Hyperliquid spot', kraken: 'Kraken', krakenspot: 'Kraken spot', kucoin: 'KuCoin', kucoinspot: 'KuCoin spot', mexc: 'MEXC', mexcspot: 'MEXC spot', okx: 'OKX', okxspot: 'OKX spot', phemex: 'Phemex', poloniex: 'Poloniex', whitebit: 'WhiteBIT', whitebitspot: 'WhiteBIT spot',
};

/** A short handle for a venue in popups: "binance-spot", "hyperliquid". */
export function venueSlug(id: string): string { return venueLabel(id).toLowerCase().replace(/\s+/g, '-'); }

export function venueLabel(id: string): string {
  const venue = id.split(':')[0]!;
  return NAMES[venue] ?? venue.replace(/^./, c => c.toUpperCase());
}

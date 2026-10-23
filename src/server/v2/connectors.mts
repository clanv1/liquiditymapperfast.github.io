import { inflateRawSync } from 'node:zlib';
import { BinanceSpotConnector, BinanceUsConnector, BitunixConnector, BookConnector, HitbtcConnector, PoloniexConnector } from '../../shared/connector.ts';

import { BitfinexPerpConnector, BitfinexSpotConnector, BingxPerpConnector, BingxSpotConnector, BitstampPerpConnector, BitstampSpotConnector, CryptocomPerpConnector, CryptocomSpotConnector, GatePerpConnector, GateSpotConnector, HtxPerpConnector, HtxSpotConnector, KucoinPerpConnector, KucoinSpotConnector, MexcSpotConnector, WhitebitPerpConnector, WhitebitSpotConnector } from '../../shared/more-venues.ts';
import { BitgetSpotConnector, BybitSpotConnector, HyperliquidSpotConnector, KrakenPerpConnector, KrakenSpotConnector, MexcConnector, OkxSpotConnector } from '../../shared/venues.ts';
export { BinanceSpotConnector, BinanceUsConnector, BitunixConnector, BookConnector, HitbtcConnector, PoloniexConnector, type ConnectorState, type ConnectorStatus } from '../../shared/connector.ts';

/** BitMart spot depth50: deflate-compressed full snapshots. */
export class BitmartConnector extends BookConnector {
  readonly id = 'bitmart'; readonly name = 'BitMart'; readonly symbol = 'BTC_USDT'; readonly quote = 'USDT'; readonly marketType = 'spot' as const;
  protected url() { return 'wss://ws-manager-compress.bitmart.com/api?protocol=1.1'; }
  protected open(send: (p: unknown) => void) { send({ op: 'subscribe', args: [`spot/depth50:${this.symbol}`] }); }
  /** Whole depth50 snapshots are re-sent several times a second. */
  protected override coalesceMs() { return 400; }
  override decode(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) { try { return inflateRawSync(Buffer.from(data)).toString('utf8'); } catch { return Buffer.from(data).toString('utf8'); } }
    return null;
  }
  onMessage(text: string) {
    const m = this.record(JSON.parse(text)); if (!m || m.table !== 'spot/depth50' || !Array.isArray(m.data)) return;
    for (const item of m.data) {
      const d = this.record(item); if (!d || d.symbol !== this.symbol) continue;
      this.replace(this.bids, this.rows(d.bids)); this.replace(this.asks, this.rows(d.asks)); this.touch();
    }
  }
}

export const CONNECTOR_FACTORIES: Record<string, () => BookConnector> = {
  binanceus: () => new BinanceUsConnector(), binancespot: () => new BinanceSpotConnector(), hitbtc: () => new HitbtcConnector(), poloniex: () => new PoloniexConnector(),
  // The spot markets of exchanges whose perpetual the feed manager serves: these connectors carry their own trades.
  bybitspot: () => new BybitSpotConnector(), okxspot: () => new OkxSpotConnector(), bitgetspot: () => new BitgetSpotConnector(),
  hyperliquidspot: () => new HyperliquidSpotConnector(),
  kraken: () => new KrakenPerpConnector(), krakenspot: () => new KrakenSpotConnector(),
  // The nine exchanges added for coverage. Each connector carries its own book and its trades, so the feed-manager adapters for the same names stay off.
  mexc: () => new MexcConnector(), mexcspot: () => new MexcSpotConnector(),
  gateio: () => new GatePerpConnector(), gateiospot: () => new GateSpotConnector(),
  htx: () => new HtxPerpConnector(), htxspot: () => new HtxSpotConnector(),
  whitebit: () => new WhitebitPerpConnector(), whitebitspot: () => new WhitebitSpotConnector(),
  cryptocom: () => new CryptocomPerpConnector(), cryptocomspot: () => new CryptocomSpotConnector(),
  bingx: () => new BingxPerpConnector(), bingxspot: () => new BingxSpotConnector(),
  kucoin: () => new KucoinPerpConnector(), kucoinspot: () => new KucoinSpotConnector(),
  bitfinex: () => new BitfinexPerpConnector(), bitfinexspot: () => new BitfinexSpotConnector(),
  bitstamp: () => new BitstampPerpConnector(), bitstampspot: () => new BitstampSpotConnector(),
  bitmart: () => new BitmartConnector(), bitunix: () => new BitunixConnector(),
};

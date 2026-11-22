import type { ArchiveConnector, Capture, PriceConnector, PriceQuote } from '@olcys/core';

/** The Internet Archive's Wayback Machine: which past versions of a page it holds, and the pages as they were. */
export function createWaybackConnector(base = 'https://web.archive.org', limit = 40): ArchiveConnector {
  const root = base.replace(/\/+$/, '');
  return {
    id: 'wayback',
    descriptor: { name: 'Wayback Machine (Internet Archive)', hosts: [new URL(root).host], synthetic: false },
    async captures(url, ctx): Promise<Capture[]> {
      // One capture per distinct content, successful responses only.
      const res = await ctx.fetch(`${root}/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp&filter=statuscode:200&collapse=digest&limit=${limit}`);
      if (res.status !== 200) return [];
      const rows = JSON.parse(res.body || '[]') as string[][];
      return rows.slice(1).map(([t]) => ({
        timestamp: t,
        at: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}.000Z`,
        url: `${root}/web/${t}id_/${url}`, // "id_" = the page exactly as stored, without the archive's toolbar
      }));
    },
  };
}

// Wrapped ether and wrapped bitcoin are worth what they wrap.
const PRODUCTS: Record<string, string> = { BTC: 'BTC-USD', ETH: 'ETH-USD', WETH: 'ETH-USD', WBTC: 'BTC-USD' };

/** Daily closing prices from the public market-data API of Coinbase Exchange. */
export function createCoinbasePriceConnector(base = 'https://api.exchange.coinbase.com'): PriceConnector {
  const root = base.replace(/\/+$/, '');
  return {
    id: 'coinbase-prices',
    descriptor: { name: 'Kursy rynkowe (Coinbase Exchange)', hosts: [new URL(root).host], synthetic: false },
    async usdPrice(asset, date, ctx): Promise<PriceQuote | undefined> {
      const product = PRODUCTS[asset];
      if (!product) return undefined;
      const url = `${root}/products/${product}/candles?granularity=86400&start=${date}T00:00:00Z&end=${date}T00:00:00Z`;
      let res = await ctx.fetch(url);
      // A refusal for asking too fast is answered by waiting and asking again; a price silently missing would understate the estimate.
      for (let attempt = 2; attempt <= 4 && (res.status === 429 || res.status >= 500); attempt++) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        res = await ctx.fetch(url);
      }
      if (res.status !== 200) {
        ctx.log(`kurs ${asset} z dnia ${date}: odpowiedź ${res.status}`);
        return undefined;
      }
      const candle = (JSON.parse(res.body) as number[][])[0]; // [time, low, high, open, close, volume]
      return candle ? { asset, usd: candle[4], date, source: 'dzienny kurs zamknięcia, Coinbase Exchange', url, snapshotId: res.snapshotId } : undefined;
    },
  };
}

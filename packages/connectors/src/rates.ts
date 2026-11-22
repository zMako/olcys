import type { PriceConnector, PriceQuote, RateQuote, RatesConnector } from '@olcys/core';

const day = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Average exchange rates of the National Bank of Poland (table A), read from the public NBP API.
 * `base` is https://api.nbp.pl for live use, or the offline copy served by the synthetic environment.
 */
export function createNbpConnector(base = 'https://api.nbp.pl', synthetic = false): RatesConnector {
  const root = base.replace(/\/+$/, '');
  return {
    id: 'nbp',
    descriptor: { name: synthetic ? 'Kursy średnie NBP (kopia lokalna)' : 'Narodowy Bank Polski — kursy średnie, tabela A', hosts: [new URL(root).host], synthetic },
    async usdPlnBefore(date, ctx): Promise<RateQuote | undefined> {
      // The rate that applies is the one from the last working day before the day in question.
      const end = Date.parse(`${date}T00:00:00Z`) - day;
      const url = `${root}/api/exchangerates/rates/a/usd/${iso(end - 9 * day)}/${iso(end)}/?format=json`;
      // The bank's API now and then answers a valid question with an error page (measured: about one request in six).
      // "No data" from the API itself is a short plain-text answer; an HTML page or a server error is asked again.
      let res = await ctx.fetch(url);
      for (let attempt = 2; attempt <= 5 && res.status !== 200 && (res.status >= 500 || res.status === 429 || res.body.trimStart().startsWith('<')); attempt++) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1))); // 0.5 s, 1 s, 2 s, 4 s: the refusals come in bursts
        res = await ctx.fetch(url);
      }
      if (res.status !== 200) {
        if (res.status >= 500 || res.status === 429 || res.body.trimStart().startsWith('<')) ctx.log(`kurs NBP sprzed ${date}: odpowiedź ${res.status} mimo ponawiania`);
        return undefined;
      }
      const body = JSON.parse(res.body) as { rates: { no: string; effectiveDate: string; mid: number }[] };
      const last = body.rates[body.rates.length - 1];
      if (!last) return undefined;
      return { currency: 'USD', mid: last.mid, effectiveDate: last.effectiveDate, table: last.no, source: 'NBP, tabela A', url, snapshotId: res.snapshotId };
    },
  };
}

/** Daily market prices from the synthetic environment's reference service. A real price provider implements the same interface. */
export function createWorldPriceConnector(base: string): PriceConnector {
  const root = base.replace(/\/+$/, '');
  return {
    id: 'world-prices',
    descriptor: { name: 'Kursy rynkowe (kopia lokalna)', hosts: [new URL(root).host], synthetic: true },
    async usdPrice(asset, date, ctx): Promise<PriceQuote | undefined> {
      const url = `${root}/prices/v1/${encodeURIComponent(asset)}/usd/${date}`;
      const res = await ctx.fetch(url);
      if (res.status !== 200) return undefined;
      const body = JSON.parse(res.body) as { usd: number; source: string };
      return { asset, usd: body.usd, date, source: body.source, url, snapshotId: res.snapshotId };
    },
  };
}

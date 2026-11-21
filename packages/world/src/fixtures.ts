import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = <T>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;

export interface NbpRate {
  d: string;
  no: string;
  mid: number;
}

/**
 * Real public reference data bundled with the environment so that it works offline:
 * NBP average USD/PLN rates and daily closing prices of BTC and ETH.
 * Refresh with scripts/fetch-reference-data.mjs.
 */
export const NBP = read<{ source: string; code: string; rates: NbpRate[] }>('nbp-usd.json');
export const PRICES = read<{ source: string; prices: Record<string, Record<string, number>> }>('prices-usd.json');

export function priceUsd(asset: string, date: string): number | undefined {
  return PRICES.prices[asset]?.[date];
}

/** NBP average USD/PLN rate from the last table published before the given day. */
export function usdPlnBefore(date: string): NbpRate | undefined {
  let last: NbpRate | undefined;
  for (const r of NBP.rates) {
    if (r.d >= date) break;
    last = r;
  }
  return last;
}

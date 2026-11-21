// Downloads the public reference data bundled with the synthetic environment:
//  - NBP average USD/PLN rates (table A), from the National Bank of Poland API;
//  - daily closing prices of BTC and ETH in USD, from the Coinbase Exchange public market-data API.
// Run once; the results are committed so that the environment works offline.
import { writeFileSync } from 'node:fs';

const FROM = '2022-01-01';
const TO = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const day = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The APIs occasionally answer 5xx under load; wait and try again a few times.
const get = async (url) => {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt >= 5 || res.status < 500) throw new Error(`${res.status} ${url}`);
    await sleep(1500 * attempt);
  }
};

// --- NBP: quarterly requests (long ranges are refused by the API)
const nbp = [];
for (let t = Date.parse(FROM); t <= Date.parse(TO); t += 90 * day) {
  const end = Math.min(t + 89 * day, Date.parse(TO));
  await sleep(400);
  const data = await get(`https://api.nbp.pl/api/exchangerates/rates/a/usd/${iso(t)}/${iso(end)}/?format=json`);
  for (const r of data.rates) nbp.push({ d: r.effectiveDate, no: r.no, mid: r.mid });
}
writeFileSync('packages/world/fixtures/nbp-usd.json', JSON.stringify({ source: 'Narodowy Bank Polski, tabela A kursów średnich walut obcych, api.nbp.pl', code: 'USD', rates: nbp }));
console.log(`NBP: ${nbp.length} tables, ${nbp[0].d} … ${nbp.at(-1).d}`);

// --- prices: 300 daily candles per request; candle = [time, low, high, open, close, volume]
const prices = {};
for (const [asset, product] of [['BTC', 'BTC-USD'], ['ETH', 'ETH-USD']]) {
  prices[asset] = {};
  for (let t = Date.parse(FROM); t <= Date.parse(TO); t += 300 * day) {
    const end = Math.min(t + 299 * day, Date.parse(TO));
    const candles = await get(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${iso(t)}T00:00:00Z&end=${iso(end)}T00:00:00Z`);
    for (const c of candles) prices[asset][iso(c[0] * 1000)] = c[4];
    await new Promise((r) => setTimeout(r, 250));
  }
  const days = Object.keys(prices[asset]).sort();
  prices[asset] = Object.fromEntries(days.map((d) => [d, prices[asset][d]]));
  console.log(`${asset}: ${days.length} days, ${days[0]} … ${days.at(-1)}`);
}
writeFileSync('packages/world/fixtures/prices-usd.json', JSON.stringify({ source: 'dzienne kursy zamknięcia, Coinbase Exchange (publiczne dane rynkowe)', prices }));

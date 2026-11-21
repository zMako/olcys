// Builds the corpus from Common Crawl.
//   npm run corpus -- keywords                 seeds from URLs: hosts whose name or paths speak of crypto
//   npm run corpus -- sample --files 200       scans a random sample of the crawl for valid addresses
//   npm run corpus -- listing --tld pl        every page of one top-level domain, by URL: hosts and keyword seeds
//   npm run corpus -- seeds --tld pl          fetches a few pages of every seed host and measures which really carry addresses
//   npm run corpus -- report                   yield of the sample and the domains it points at
import { latestCrawlId, type CrawlRef } from './cc';
import { keywordPass } from './discover';
import { listTld } from './listing';
import { buildReport, type DomainYield } from './report';
import { runSample } from './sample';
import { measureSeeds } from './seeds';
import { ingestFarcaster } from './farcaster';
import { readFileSync } from 'node:fs';
import { listingDir } from './listing';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const crawl: CrawlRef = { id: flag('crawl') ?? process.env.CC_CRAWL ?? (['keywords', 'listing', 'seeds', 'sample', 'report'].includes(command) ? await latestCrawlId() : ''), dir: flag('dir') ?? process.env.CORPUS_DIR ?? '.corpus' };
const n = (x: number) => x.toLocaleString('pl-PL');
const table = (rows: DomainYield[]) => {
  for (const r of rows) {
    console.log(`  ${r.host.padEnd(38).slice(0, 38)} ${String(r.distinctAddresses).padStart(6)} adresów  ${String(r.pagesWithAddress).padStart(5)} z ${String(r.pagesSeen).padStart(6)} stron  ${r.kind === 'address list' ? 'lista adresów' : 'pojedyncze adresy'}`);
  }
};

if (command === 'keywords') {
  const k = await keywordPass(crawl);
  console.log(`${crawl.id}: indeks ma ${n(k.indexLines)} wierszy, czyli około ${n(k.estimatedPages)} stron.`);
  console.log(`Hosty ze słowem kluczowym w nazwie: ${n(k.hosts.filter((h) => h.keywords.length).length)}; tylko w ścieżkach: ${n(k.hosts.filter((h) => !h.keywords.length).length)}.`);
  for (const [t, s] of Object.entries(k.tld)) console.log(`Pełna lista stron .${t}: ${n(s.blocks)} bloków, ${n(Math.round(s.megabytes))} MB.`);
  for (const h of k.hosts.filter((x) => x.keywords.length).slice(0, 40)) console.log(`  ${h.host.padEnd(40).slice(0, 40)} ~${n(h.estimatedPages).padStart(9)} stron  ${h.keywords.join(', ')}`);
} else if (command === 'sample') {
  const p = await runSample(crawl, {
    files: Number(flag('files') ?? 20), offset: Number(flag('offset') ?? 0), concurrency: Number(flag('concurrency') ?? 6),
    onProgress: (x) => {
      if (x.filesDone % 10 === 0 || x.filesDone === x.filesTotal) console.log(`${x.filesDone}/${x.filesTotal} plików, ${n(x.pages)} stron, ${n(x.hitPages)} z adresem, ${n(Math.round(x.pages / Math.max(1, x.seconds)))} stron/s`);
    },
  });
  console.log(`Gotowe: ${n(p.pages)} stron w ${Math.round(p.seconds)} s.`);
} else if (command === 'listing') {
  const tld = flag('tld') ?? 'pl';
  const r = await listTld(crawl, tld, {
    concurrency: Number(flag('concurrency') ?? 6),
    onProgress: (done, total, pages) => {
      if (done % 25 === 0 || done === total) console.log(`${done}/${total} części indeksu, ${n(pages)} stron`);
    },
  });
  console.log(`.${tld}: ${n(r.pages)} stron na ${n(r.hosts)} hostach (po polsku ${n(r.polishPages)}); pobrano ${n(Math.round(r.megabytes))} MB indeksu w ${Math.round(r.seconds)} s.`);
  console.log(`Strony, których adres mówi o kryptowalutach: ${n(r.seedPages)} na ${n(r.seedHosts)} hostach.`);
} else if (command === 'seeds') {
  const tld = flag('tld') ?? 'pl';
  const r = await measureSeeds(crawl, tld, {
    perHost: Number(flag('per-host') ?? 25), concurrency: Number(flag('concurrency') ?? 24), maxHosts: flag('max-hosts') ? Number(flag('max-hosts')) : undefined,
    onProgress: (done, total, hits) => console.log(`${n(done)}/${n(total)} stron, ${n(hits)} z adresem`),
  });
  console.log(`Sprawdzono ${n(r.hosts)} hostów: pobrano ${n(r.fetched)} stron (${n(r.failed)} nieudanych) w ${Math.round(r.seconds)} s.`);
  console.log(`Stron z adresem: ${n(r.pagesWithAddress)} na ${n(r.hostsWithAddress)} hostach.`);
  const rows = JSON.parse(readFileSync(`${listingDir(crawl, tld)}/seed-yield.json`, 'utf8')) as { host: string; seedPages: number; fetched: number; pagesWithAddress: number; distinctAddresses: number }[];
  for (const x of rows.filter((y) => y.pagesWithAddress).slice(0, 30)) console.log(`  ${x.host.padEnd(38).slice(0, 38)} ${String(x.distinctAddresses).padStart(5)} adresów  ${String(x.pagesWithAddress).padStart(4)} z ${String(x.fetched).padStart(4)} pobranych  (${n(x.seedPages)} stron w archiwum)`);
} else if (command === 'farcaster') {
  const r = await ingestFarcaster(`${crawl.dir}/farcaster`, { maxRequests: Number(flag('max-requests') ?? 20000), perSecond: Number(flag('per-second') ?? 4), log: (m) => console.log(m) });
  console.log(`Farcaster: obejrzano ${n(r.evaluated)} kont, polskich ${n(r.polish)}, z portfelem ${n(r.withWallet)} (${n(r.wallets)} adresów); wpisy ${n(r.casts)} z ${n(r.castsOf)} kont; zapytań ${n(r.requests)}.`);
  if (r.stopped) console.log(`Zatrzymano: ${r.stopped}`);
} else if (command === 'report') {
  const r = await buildReport(crawl);
  console.log(`${r.crawl}: ${r.files} plików, ${n(r.pages)} stron (${r.gigabytes} GB tekstu), w tym po polsku ${n(r.polishPages)}.`);
  console.log(`Stron z prawidłowym adresem: ${n(r.pagesWithAddress)} (${n(r.hitsPerMillion)} na milion), po polsku ${n(r.polishPagesWithAddress)}; domen: ${n(r.domainsWithAddress)}.`);
  console.log(`Różnych adresów: ${Object.entries(r.distinctAddresses).map(([c, v]) => `${c} ${n(v)}`).join(', ')}; w tym na stronach z najwyżej trzema adresami: ${n(r.addressesInProse)}.`);
  console.log('\nDomeny z największą liczbą adresów:');
  table(r.top.slice(0, 25));
  console.log('\nDomeny polskie:');
  table(r.topPolish.slice(0, 25));
} else {
  console.log('Użycie: npm run corpus -- <keywords|listing|seeds|sample|report> [--crawl ID] [--files N] [--offset N] [--concurrency N] [--dir .corpus]');
}

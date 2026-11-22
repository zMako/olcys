// Builds the corpus from Common Crawl.
//   npm run corpus -- keywords                 seeds from URLs: hosts whose name or paths speak of crypto
//   npm run corpus -- sample --files 200       scans a random sample of the crawl for valid addresses
//   npm run corpus -- listing --tld pl        every page of one top-level domain, by URL: hosts and keyword seeds
//   npm run corpus -- seeds --tld pl          fetches a few pages of every seed host and measures which really carry addresses
//   npm run corpus -- attestations            wallets whose owners Coinbase attests as verified in Poland (public, on Base)
//   npm run corpus -- basenames               names of the attested wallets on Base, with the records their owners attached
//   npm run corpus -- expand                  grows the Polish register along the follow graph, on the protocol node
//   npm run corpus -- enrich                  adds ENS names and Keybase proofs to every Polish account of the corpus
//   npm run corpus -- report                   yield of the sample and the domains it points at
import { latestCrawlId, type CrawlRef } from './cc';
import { keywordPass } from './discover';
import { listTld } from './listing';
import { buildReport, type DomainYield } from './report';
import { runSample } from './sample';
import { measureSeeds } from './seeds';
import { ingestFarcaster } from './farcaster';
import { enrichFarcaster } from './enrich';
import { expandFarcaster } from './expand';
import { fullPass } from './fullpass';
import { readFarcasterRecords } from './farcaster';
import { readFlows, scanFlows } from './flows';
import { readPoapHolders } from './poap';
import { registerStats } from './register';
import { attestationsDir, ingestCountryAttestations, readAttestations } from './attestations';
import { ingestBasenames } from './basenames';
import { readFileSync } from 'node:fs';
import { listingDir } from './listing';

const [command, ...rest] = process.argv.slice(2);
try {
  process.loadEnvFile('.env');
} catch {
  // settings may come from the environment alone
}
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
} else if (command === 'attestations') {
  const country = (flag('country') ?? 'PL').toUpperCase();
  const r = await ingestCountryAttestations(crawl.dir, country);
  console.log(`Poświadczenia Coinbase „kraj: ${country}”: ${n(r.attestations)} na ${n(r.wallets)} portfelach, od ${r.first?.slice(0, 10)} do ${r.last?.slice(0, 10)}.`);
} else if (command === 'basenames') {
  const country = (flag('country') ?? 'PL').toUpperCase();
  // The attested wallets, and with --all also every wallet of the Polish accounts found on Farcaster.
  const more = process.argv.includes('--all') ? readFarcasterRecords(`${crawl.dir}/farcaster`).filter((x) => x.polish.score >= 0.5).flatMap((x) => x.wallets).filter((w) => w.startsWith('0x')) : [];
  const wallets = [...new Set([...readAttestations(crawl.dir, country).map((a) => a.wallet), ...more])];
  const r = await ingestBasenames(`${attestationsDir(crawl.dir, country)}/basenames.jsonl`, wallets, { onProgress: (done, named) => done % 1000 === 0 && console.log(`${n(done)} portfeli, ${n(named)} z nazwą`) });
  console.log(`Nazwy Base: ${n(r.named)} z ${n(r.wallets)} portfeli ma nazwę; ${n(r.withRecords)} nazw ma rekordy (inne konta, strona, opis).`);
} else if (command === 'register') {
  console.log(JSON.stringify(registerStats(crawl.dir), null, 2));
} else if (command === 'flows') {
  const key = process.env.ALCHEMY_KEY;
  if (!key) throw new Error('Brak ALCHEMY_KEY: historia sieci Base wymaga klucza.');
  // Accounts that are both public and attested first, then the other public accounts, then the rest of the register.
  const polish = readFarcasterRecords(`${crawl.dir}/farcaster`).filter((r) => r.polish.score >= 0.5);
  // Last: wallets seen at in-person events in Poland on two or more days.
  const days = new Map<string, Set<string>>();
  for (const h of readPoapHolders(crawl.dir)) if (!h.virtual) days.set(h.wallet, (days.get(h.wallet) ?? new Set()).add((h.date ?? String(h.dropId)).slice(0, 10)));
  const regulars = [...days].filter(([, d]) => d.size >= 2).map(([w]) => w);
  const order = [...polish.filter((r) => r.attested?.length).flatMap((r) => r.wallets), ...polish.flatMap((r) => r.wallets), ...readAttestations(crawl.dir).map((a) => a.wallet), ...regulars];
  const wallets = [...new Set(order)].filter((w) => w.startsWith('0x')).slice(0, Number(flag('limit') ?? 100000));
  const r = await scanFlows(crawl.dir, wallets, { key, perSecond: Number(flag('per-second') ?? 3), log: (m) => console.log(m) });
  const all = readFlows(crawl.dir);
  console.log(`Przepływy na Base: przejrzano ${n(r.scanned)} portfeli (łącznie ${n(all.length)}), z historią ${n(all.filter((f) => f.transfers).length)}, z wpłatą na giełdę ${n(all.filter((f) => f.offRamps.length).length)}.`);
} else if (command === 'fullpass') {
  const r = await fullPass(`${crawl.dir}/farcaster`, { from: flag('from') ? Number(flag('from')) : undefined, to: flag('to') ? Number(flag('to')) : undefined, startPerSecond: Number(flag('start') ?? 40), maxPerSecond: Number(flag('max') ?? 150), log: (m) => console.log(m) });
  console.log(`Przegląd: przejrzano ${n(r.scanned)} kont, polskich łącznie ${n(r.polish)} (+${n(r.added)}); następne konto ${n(r.next)}.`);
  if (r.stopped) console.log(`Zatrzymano: ${r.stopped}`);
} else if (command === 'expand') {
  const r = await expandFarcaster(`${crawl.dir}/farcaster`, {
    maxRequests: Number(flag('max-requests') ?? 30000), perSecond: Number(flag('per-second') ?? 8), minNeighbours: Number(flag('min-neighbours') ?? 2), log: (m) => console.log(m),
  });
  console.log(`Polskich kont: ${n(r.polish)} (+${n(r.added)}); z portfelem ${n(r.withWallet)}, adresów ${n(r.wallets)}; z kontem X ${n(r.withX)}.`);
  console.log(`Oświadczenia portfeli sprawdzone w tym przebiegu: ${n(r.claimsVerified)} prawidłowych, ${n(r.claimsFailed)} odrzuconych. Odrzuconych kandydatów łącznie: ${n(r.checked)}. Zapytań: ${n(r.requests)}.`);
  if (r.stopped) console.log(`Zatrzymano: ${r.stopped}`);
} else if (command === 'enrich') {
  const r = await enrichFarcaster(`${crawl.dir}/farcaster`, { maxAccounts: flag('max') ? Number(flag('max')) : undefined, log: (m) => console.log(m) });
  console.log(`Uzupełniono ${n(r.done)} z ${n(r.accounts)} polskich kont. Nazwy ENS: ${n(r.ensNames)} na ${n(r.withEns)} kontach, w tym z rekordami wskazującymi inne konta lub stronę: ${n(r.ensWithAccounts)}.`);
  console.log(`Keybase: ${n(r.withKeybase)} kont z potwierdzonym tym samym kontem X; adresów Bitcoin podpisanych tam: ${n(r.bitcoinAddresses)}.`);
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

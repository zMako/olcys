import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { CrawlRef } from './cc';
import { fetchArchived } from './fetch';
import { listingDir, type PagePointer } from './listing';
import { scanPage, type PageHit } from './scan';

export interface SeedYield {
  host: string;
  /** Seed pages the crawl holds for this host, and how many of them were fetched and read. */
  seedPages: number;
  fetched: number;
  pagesWithAddress: number;
  distinctAddresses: number;
  keywords: string[];
}

export interface SeedsResult {
  hosts: number;
  fetched: number;
  failed: number;
  pagesWithAddress: number;
  hostsWithAddress: number;
  seconds: number;
}

/**
 * Judges keyword seeds by content. A host whose address speaks of crypto is only a candidate; a few of its
 * pages are fetched from the archive and put through the address filter. What comes back is a yield per host,
 * and the hosts that pages with addresses link to — the next candidates, which no keyword would have found.
 */
export async function measureSeeds(
  crawl: CrawlRef,
  tld: string,
  opts: { perHost?: number; concurrency?: number; maxHosts?: number; onProgress?(done: number, total: number, hits: number): void } = {},
): Promise<SeedsResult> {
  const dir = listingDir(crawl, tld);
  if (!existsSync(`${dir}/seed-pages.jsonl`)) throw new Error(`Run "listing --tld ${tld}" first`);
  mkdirSync(dir, { recursive: true });
  const byHost = new Map<string, PagePointer[]>();
  for await (const line of createInterface({ input: createReadStream(`${dir}/seed-pages.jsonl`), crlfDelay: Infinity })) {
    if (!line) continue;
    const p = JSON.parse(line) as PagePointer;
    byHost.set(p.host, [...(byHost.get(p.host) ?? []), p]);
  }
  const perHost = opts.perHost ?? 25;
  const hosts = [...byHost].sort((a, b) => b[1].length - a[1].length).slice(0, opts.maxHosts ?? Infinity);
  const jobs: PagePointer[] = [];
  for (const [, pages] of hosts) {
    // evenly spread over the host's pages, so one section of a site does not stand for the whole
    const step = Math.max(1, pages.length / perHost);
    for (let i = 0; i < pages.length && i / step < perHost; i += step) jobs.push(pages[Math.floor(i)]);
  }

  const stats = new Map<string, { fetched: number; hits: number; addresses: Set<string> }>();
  const linked = new Map<string, number>();
  writeFileSync(`${dir}/seed-hits.jsonl`, '');
  const result: SeedsResult = { hosts: hosts.length, fetched: 0, failed: 0, pagesWithAddress: 0, hostsWithAddress: 0, seconds: 0 };
  const started = Date.now();
  let done = 0;
  const worker = async () => {
    for (let job = jobs.pop(); job; job = jobs.pop()) {
      done++;
      try {
        const page = await fetchArchived(job);
        if (!page) continue;
        result.fetched++;
        const s = stats.get(job.host) ?? { fetched: 0, hits: 0, addresses: new Set<string>() };
        s.fetched++;
        stats.set(job.host, s);
        // The visible text first; if it has no address, the markup may (a link to an explorer, a payment URI).
        let found = scanPage(Buffer.from(page.text, 'utf8'));
        if (!found.mentions.length) found = scanPage(Buffer.from(page.html, 'utf8'));
        if (!found.mentions.length) continue;
        s.hits++;
        result.pagesWithAddress++;
        for (const m of found.mentions) s.addresses.add(m.address);
        for (const h of page.linkedHosts) linked.set(h, (linked.get(h) ?? 0) + 1);
        const hit: PageHit = { url: job.url, host: job.host, languages: job.languages, ...found };
        appendFileSync(`${dir}/seed-hits.jsonl`, JSON.stringify(hit) + '\n');
      } catch {
        result.failed++;
      } finally {
        if (done % 500 === 0) opts.onProgress?.(done, done + jobs.length, result.pagesWithAddress);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 24 }, worker));

  const rows: SeedYield[] = hosts.map(([host, pages]) => {
    const s = stats.get(host);
    return { host, seedPages: pages.length, fetched: s?.fetched ?? 0, pagesWithAddress: s?.hits ?? 0, distinctAddresses: s?.addresses.size ?? 0, keywords: [...new Set(pages.flatMap((p) => p.keywords))] };
  }).sort((a, b) => b.distinctAddresses - a.distinctAddresses || b.pagesWithAddress - a.pagesWithAddress || b.seedPages - a.seedPages);
  writeFileSync(`${dir}/seed-yield.json`, JSON.stringify(rows, null, 1));
  writeFileSync(`${dir}/seed-links.tsv`, [...linked].sort((a, b) => b[1] - a[1]).map(([h, c]) => `${h}\t${c}`).join('\n'));
  result.hostsWithAddress = rows.filter((r) => r.pagesWithAddress > 0).length;
  result.seconds = (Date.now() - started) / 1000;
  return result;
}

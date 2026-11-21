import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { CC_DATA, ccFetch, clusterIndex, type ClusterLine, type CrawlRef } from './cc';
import { STRONG_KEYWORDS, keywordsIn, parseSurt, tldOf } from './keywords';

/** Where a page sits in the archive: enough to fetch that one page and nothing else. */
export interface PagePointer {
  url: string;
  host: string;
  /** Crypto keywords in the host name or path that made the page a seed. */
  keywords: string[];
  languages: string[];
  filename: string;
  offset: number;
  length: number;
}

export interface ListingResult {
  tld: string;
  pages: number;
  hosts: number;
  polishPages: number;
  /** Pages whose address alone says they are about crypto. */
  seedPages: number;
  seedHosts: number;
  megabytes: number;
  seconds: number;
}

export const listingDir = (crawl: CrawlRef, tld: string) => `${crawl.dir}/${crawl.id}/tld-${tld}`;

const MAX_RANGE = 16 * 1024 * 1024;
const MAX_POINTERS_PER_HOST = 4000;

/** Byte ranges of the full index that hold every page of one top-level domain, with neighbouring blocks merged. */
export async function tldRanges(crawl: CrawlRef, tld: string): Promise<{ file: string; from: number; to: number }[]> {
  const ranges: { file: string; from: number; to: number }[] = [];
  let previous: ClusterLine | undefined;
  let inside = false;
  const add = (b: ClusterLine) => {
    const last = ranges[ranges.length - 1];
    if (last && last.file === b.file && last.to === b.offset && b.offset + b.length - last.from <= MAX_RANGE) last.to = b.offset + b.length;
    else ranges.push({ file: b.file, from: b.offset, to: b.offset + b.length });
  };
  for await (const line of clusterIndex(crawl)) {
    const here = tldOf(line.surt) === tld;
    // The block before the first matching one ends with the domain's first pages.
    if (here && !inside && previous) add(previous);
    if (here) add(line);
    else if (inside) break; // the index is sorted: once past the domain, nothing more will come
    inside = here;
    previous = line;
  }
  return ranges;
}

/**
 * Reads the complete list of one top-level domain's pages from the crawl index — URLs only, no page content.
 * Writes every host with its page counts, and a pointer for every page whose address carries a strong crypto
 * keyword. Those pointers are seeds: the pages are fetched and judged by whether they hold addresses.
 */
export async function listTld(crawl: CrawlRef, tld: string, opts: { concurrency?: number; onProgress?(done: number, total: number, pages: number): void } = {}): Promise<ListingResult> {
  const dir = listingDir(crawl, tld);
  mkdirSync(dir, { recursive: true });
  const ranges = await tldRanges(crawl, tld);
  const hosts = new Map<string, { pages: number; polish: number; seeds: number; keywords: Set<string> }>();
  const seeds = openSync(`${dir}/seed-pages.jsonl`, 'w');
  const started = Date.now();
  const result: ListingResult = { tld, pages: 0, hosts: 0, polishPages: 0, seedPages: 0, seedHosts: 0, megabytes: 0, seconds: 0 };
  const prefix = `${tld},`;
  const queue = [...ranges];
  let done = 0;

  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const res = await ccFetch(`${CC_DATA}/cc-index/collections/${crawl.id}/indexes/${r.file}`, { range: [r.from, r.to - 1] });
      result.megabytes += (r.to - r.from) / 1e6;
      const out: string[] = [];
      for await (const line of createInterface({ input: Readable.fromWeb(res.body as never).pipe(createGunzip()), crlfDelay: Infinity })) {
        if (!line.startsWith(prefix)) continue;
        // "<key> <timestamp> {json}" — the key itself may contain braces, so the record is found by its first field.
        const brace = line.indexOf(' {"url": ');
        const parsed = parseSurt(line.slice(0, line.indexOf(' ')));
        if (brace < 0 || !parsed) continue;
        let page: { url: string; status: string; mime?: string; 'mime-detected'?: string; languages?: string; filename: string; offset: string; length: string };
        try {
          page = JSON.parse(line.slice(brace + 1));
        } catch {
          continue;
        }
        if (page.status !== '200' || !(page['mime-detected'] ?? page.mime ?? '').includes('html')) continue;
        const languages = (page.languages ?? '').split(',').filter(Boolean);
        let h = hosts.get(parsed.host);
        if (!h) hosts.set(parsed.host, (h = { pages: 0, polish: 0, seeds: 0, keywords: new Set(keywordsIn(parsed.host)) }));
        h.pages++;
        result.pages++;
        if (languages[0] === 'pol') {
          h.polish++;
          result.polishPages++;
        }
        const inPath = keywordsIn(parsed.path.slice(0, 200));
        const strong = [...h.keywords, ...inPath].filter((k) => STRONG_KEYWORDS.has(k));
        if (!strong.length || h.seeds >= MAX_POINTERS_PER_HOST) continue;
        h.seeds++;
        result.seedPages++;
        const pointer: PagePointer = { url: page.url, host: parsed.host, keywords: [...new Set(strong)], languages, filename: page.filename, offset: Number(page.offset), length: Number(page.length) };
        out.push(JSON.stringify(pointer));
      }
      if (out.length) writeSync(seeds, out.join('\n') + '\n');
      opts.onProgress?.(++done, ranges.length, result.pages);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  closeSync(seeds);

  const table = openSync(`${dir}/hosts.tsv`, 'w');
  const rows = [...hosts].sort((a, b) => b[1].seeds - a[1].seeds || b[1].pages - a[1].pages);
  for (let i = 0; i < rows.length; i += 20_000) {
    writeSync(table, rows.slice(i, i + 20_000).map(([host, h]) => `${host}\t${h.pages}\t${h.polish}\t${h.seeds}\t${[...h.keywords].join(',')}\n`).join(''));
  }
  closeSync(table);
  result.hosts = hosts.size;
  result.seedHosts = rows.filter(([, h]) => h.seeds > 0).length;
  result.seconds = (Date.now() - started) / 1000;
  return result;
}

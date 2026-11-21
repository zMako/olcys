import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { parseWarc } from './warc';

/**
 * Common Crawl: a public archive of the web, published as monthly snapshots.
 * Everything here is a plain download from its public storage; no site is contacted.
 *  - cluster.idx        one line per 3000 pages of the crawl, sorted by host: a ready-made sample of what the crawl holds;
 *  - wet.paths.gz       the list of text-only files (the readable text of every page, about 100 000 files per crawl);
 *  - *.warc.wet.gz      one such file: tens of thousands of pages, in no topical order.
 */
export const CC_DATA = 'https://data.commoncrawl.org';
const USER_AGENT = 'OLCyS/0.1 (OSINT research tool)';

export interface CrawlRef {
  /** Crawl id, e.g. "CC-MAIN-2026-43". */
  id: string;
  /** Local folder for downloaded index files and results. Never committed. */
  dir: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with a few patient retries: the storage occasionally answers 503 under load. */
export async function ccFetch(url: string, init: { range?: [number, number] } = {}, attempts = 4): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...(init.range ? { range: `bytes=${init.range[0]}-${init.range[1]}` } : {}) } });
      if (res.ok) return res;
      last = new Error(`${res.status} for ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = err;
    }
    await sleep(1500 * (i + 1) ** 2);
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Downloads a file once; later calls reuse the local copy. */
export async function cached(url: string, file: string): Promise<string> {
  if (existsSync(file)) return file;
  mkdirSync(dirname(file), { recursive: true });
  const res = await ccFetch(url);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
  return file;
}

async function* linesOf(file: string): AsyncGenerator<string> {
  const raw = createReadStream(file);
  const rl = createInterface({ input: file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

/** The newest crawl, as listed by Common Crawl. */
export async function latestCrawlId(): Promise<string> {
  const res = await ccFetch('https://index.commoncrawl.org/collinfo.json');
  return ((await res.json()) as { id: string }[])[0].id;
}

export interface ClusterLine {
  /** Index key of the first page of the block: host reversed, then path ("pl,bitcoin,forum)/watek/1"). */
  surt: string;
  /** The index file and byte range that hold the 3000 pages starting at this key. */
  file: string;
  offset: number;
  length: number;
}

/** Streams the top level of the crawl's URL index. */
export async function* clusterIndex(crawl: CrawlRef): AsyncGenerator<ClusterLine> {
  const file = await cached(`${CC_DATA}/cc-index/collections/${crawl.id}/indexes/cluster.idx`, `${crawl.dir}/${crawl.id}/cluster.idx`);
  for await (const line of linesOf(file)) {
    const [key, cdx, offset, length] = line.split('\t');
    if (!length) continue;
    yield { surt: key.slice(0, key.lastIndexOf(' ')), file: cdx, offset: Number(offset), length: Number(length) };
  }
}

/** Paths of every text-only file of the crawl. */
export async function wetPaths(crawl: CrawlRef): Promise<string[]> {
  const file = await cached(`${CC_DATA}/crawl-data/${crawl.id}/wet.paths.gz`, `${crawl.dir}/${crawl.id}/wet.paths.gz`);
  const out: string[] = [];
  for await (const line of linesOf(file)) if (line.trim()) out.push(line.trim());
  return out;
}

export interface TextPage {
  url: string;
  /** Languages the crawler detected, most likely first. */
  languages: string[];
  /** The page's readable text, as bytes (UTF-8). */
  body: Buffer;
}

/** Streams the pages of one text-only file straight from the archive, without storing it. */
export async function* textPages(path: string): AsyncGenerator<TextPage> {
  const res = await ccFetch(`${CC_DATA}/${path}`);
  const unzipped = Readable.fromWeb(res.body as never).pipe(createGunzip());
  for await (const record of parseWarc(unzipped)) {
    if (record.headers['warc-type'] !== 'conversion') continue;
    const url = record.headers['warc-target-uri'];
    if (!url) continue;
    yield { url, languages: (record.headers['warc-identified-content-language'] ?? '').split(',').map((x) => x.trim()).filter(Boolean), body: record.body };
  }
}

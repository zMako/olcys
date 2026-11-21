import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { textPages, wetPaths, type CrawlRef } from './cc';
import { hostOf, scanPage, type PageHit } from './scan';

export interface SampleOptions {
  /** How many of the crawl's text files to scan, spread evenly over the whole crawl. */
  files: number;
  /** Shifts the selection, so a later run can take other files than an earlier one. */
  offset?: number;
  concurrency?: number;
  onProgress?(p: SampleProgress): void;
}

export interface SampleProgress {
  filesDone: number;
  filesTotal: number;
  pages: number;
  polishPages: number;
  hitPages: number;
  megabytes: number;
  seconds: number;
}

interface FileResult {
  path: string;
  pages: number;
  polishPages: number;
  bytes: number;
  hits: PageHit[];
  hosts: Map<string, [number, number]>;
}

export const sampleDir = (crawl: CrawlRef) => `${crawl.dir}/${crawl.id}/sample`;

/** Scans one text file of the crawl: every page goes through the address filter, almost none survive. */
export async function scanFile(path: string): Promise<FileResult> {
  const out: FileResult = { path, pages: 0, polishPages: 0, bytes: 0, hits: [], hosts: new Map() };
  for await (const page of textPages(path)) {
    const host = hostOf(page.url);
    if (!host) continue;
    out.pages++;
    out.bytes += page.body.length;
    const polish = page.languages[0] === 'pol';
    if (polish) out.polishPages++;
    const count = out.hosts.get(host) ?? [0, 0];
    count[0]++;
    if (polish) count[1]++;
    out.hosts.set(host, count);
    const found = scanPage(page.body);
    if (found.mentions.length) out.hits.push({ url: page.url, host, languages: page.languages, ...found });
  }
  return out;
}

/**
 * Scans a random sample of the crawl. Results are appended file by file, so the run can be stopped
 * and continued, or extended later with more files:
 *   hits.jsonl   one line per page that carries a valid address (address, chain, surrounding text);
 *   files.jsonl  one line per scanned file (pages, Polish pages, bytes);
 *   hosts.tsv    pages seen per host, to turn hit counts into yields.
 */
export async function runSample(crawl: CrawlRef, opts: SampleOptions): Promise<SampleProgress> {
  const dir = sampleDir(crawl);
  mkdirSync(dir, { recursive: true });
  const all = await wetPaths(crawl);
  const step = Math.max(1, Math.floor(all.length / opts.files));
  const picked = all.filter((_, i) => i % step === (opts.offset ?? 0) % step).slice(0, opts.files);

  const doneFile = `${dir}/files.jsonl`;
  const done = new Set(existsSync(doneFile) ? readFileSync(doneFile, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { path: string }).path) : []);
  const hosts = await readHosts(`${dir}/hosts.tsv`);
  // Millions of hosts: written in pieces, to a temporary file first, so an interrupted run never leaves half a table.
  const saveHosts = () => {
    const fd = openSync(`${dir}/hosts.tsv.part`, 'w');
    let piece: string[] = [];
    for (const [h, [p, pl]] of hosts) {
      piece.push(`${h}\t${p}\t${pl}\n`);
      if (piece.length >= 50_000) {
        writeSync(fd, piece.join(''));
        piece = [];
      }
    }
    writeSync(fd, piece.join(''));
    closeSync(fd);
    renameSync(`${dir}/hosts.tsv.part`, `${dir}/hosts.tsv`);
  };

  const queue = picked.filter((p) => !done.has(p));
  const progress: SampleProgress = { filesDone: picked.length - queue.length, filesTotal: picked.length, pages: 0, polishPages: 0, hitPages: 0, megabytes: 0, seconds: 0 };
  const started = Date.now();
  const worker = async () => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      let result: FileResult | undefined;
      for (let attempt = 0; attempt < 3 && !result; attempt++) {
        try {
          result = await scanFile(path);
        } catch (err) {
          if (attempt === 2) console.error(`skipped ${path}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (!result) continue;
      // A file's results are written only once it has been read to the end, so a retry never doubles anything.
      if (result.hits.length) appendFileSync(`${dir}/hits.jsonl`, result.hits.map((h) => JSON.stringify(h)).join('\n') + '\n');
      appendFileSync(doneFile, JSON.stringify({ path, pages: result.pages, polishPages: result.polishPages, bytes: result.bytes, hitPages: result.hits.length }) + '\n');
      for (const [h, [p, pl]] of result.hosts) {
        const c = hosts.get(h);
        if (c) {
          c[0] += p;
          c[1] += pl;
        } else hosts.set(h, [p, pl]);
      }
      progress.filesDone++;
      progress.pages += result.pages;
      progress.polishPages += result.polishPages;
      progress.hitPages += result.hits.length;
      progress.megabytes += result.bytes / 1e6;
      progress.seconds = (Date.now() - started) / 1000;
      if (progress.filesDone % 50 === 0) saveHosts();
      opts.onProgress?.(progress);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  saveHosts();
  progress.seconds = (Date.now() - started) / 1000;
  return progress;
}

/** Pages seen per host in the sample: host → [all pages, Polish pages]. */
export async function readHosts(file: string): Promise<Map<string, [number, number]>> {
  const hosts = new Map<string, [number, number]>();
  if (!existsSync(file)) return hosts;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    const [host, pages, polish] = line.split('\t');
    if (host) hosts.set(host, [Number(pages), Number(polish)]);
  }
  return hosts;
}

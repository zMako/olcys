import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { CrawlRef } from './cc';
import { readHosts, sampleDir } from './sample';
import type { PageHit } from './scan';

export interface DomainYield {
  host: string;
  /** Pages of this host that the sample happened to contain. */
  pagesSeen: number;
  polishPages: number;
  pagesWithAddress: number;
  distinctAddresses: number;
  /** Typical number of addresses on a page that has any. Lists and explorers have many; people's own posts have one or two. */
  medianPerPage: number;
  chains: Record<string, number>;
  kind: 'address list' | 'single addresses';
}

export interface SampleReport {
  crawl: string;
  files: number;
  pages: number;
  polishPages: number;
  gigabytes: number;
  pagesWithAddress: number;
  /** Pages with an address per million pages scanned. */
  hitsPerMillion: number;
  polishPagesWithAddress: number;
  distinctAddresses: Record<string, number>;
  /** Addresses that stand on pages with at most three addresses — the ones worth reading the sentence around. */
  addressesInProse: number;
  domainsWithAddress: number;
  top: DomainYield[];
  topPolish: DomainYield[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

/** Turns the raw output of a sample scan into numbers: how rare addresses are, and which domains carry them. */
export async function buildReport(crawl: CrawlRef, top = 40): Promise<SampleReport> {
  const dir = sampleDir(crawl);
  const files = existsSync(`${dir}/files.jsonl`) ? readFileSync(`${dir}/files.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { pages: number; polishPages: number; bytes: number }) : [];
  const seen = await readHosts(`${dir}/hosts.tsv`);

  const domains = new Map<string, { pages: number; perPage: number[]; addresses: Set<string>; chains: Record<string, number>; polishHits: number }>();
  const distinct: Record<string, Set<string>> = {};
  const prose = new Set<string>();
  let pagesWithAddress = 0;
  let polishPagesWithAddress = 0;
  if (existsSync(`${dir}/hits.jsonl`)) {
    for await (const line of createInterface({ input: createReadStream(`${dir}/hits.jsonl`), crlfDelay: Infinity })) {
      if (!line) continue;
      const hit = JSON.parse(line) as PageHit;
      pagesWithAddress++;
      const polish = hit.languages[0] === 'pol';
      if (polish) polishPagesWithAddress++;
      const d = domains.get(hit.host) ?? { pages: 0, perPage: [], addresses: new Set<string>(), chains: {}, polishHits: 0 };
      d.pages++;
      d.perPage.push(hit.mentions.length);
      if (polish) d.polishHits++;
      for (const m of hit.mentions) {
        d.addresses.add(m.address);
        d.chains[m.chain] = (d.chains[m.chain] ?? 0) + 1;
        (distinct[m.chain] ??= new Set()).add(m.address);
        if (hit.mentions.length <= 3) prose.add(m.address);
      }
      domains.set(hit.host, d);
    }
  }

  const rows: DomainYield[] = [...domains].map(([host, d]) => {
    const [pagesSeen, polishPages] = seen.get(host) ?? [d.pages, d.polishHits];
    const m = median(d.perPage);
    return { host, pagesSeen, polishPages, pagesWithAddress: d.pages, distinctAddresses: d.addresses.size, medianPerPage: m, chains: d.chains, kind: m >= 8 ? 'address list' : 'single addresses' };
  });
  const byAddresses = (a: DomainYield, b: DomainYield) => b.distinctAddresses - a.distinctAddresses || b.pagesWithAddress - a.pagesWithAddress || a.host.localeCompare(b.host);
  const pages = files.reduce((n, f) => n + f.pages, 0);
  const report: SampleReport = {
    crawl: crawl.id, files: files.length, pages, polishPages: files.reduce((n, f) => n + f.polishPages, 0), gigabytes: Math.round(files.reduce((n, f) => n + f.bytes, 0) / 1e7) / 100,
    pagesWithAddress, hitsPerMillion: pages ? Math.round((pagesWithAddress / pages) * 1e6) : 0, polishPagesWithAddress,
    distinctAddresses: Object.fromEntries(Object.entries(distinct).map(([c, s]) => [c, s.size])), addressesInProse: prose.size,
    domainsWithAddress: rows.length,
    top: [...rows].sort(byAddresses).slice(0, top),
    // a domain counts as Polish when most of what the sample saw of it is in Polish
    topPolish: rows.filter((r) => r.polishPages * 2 >= r.pagesSeen || r.host.endsWith('.pl')).sort(byAddresses).slice(0, top),
  };
  writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 1));
  return report;
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { clusterIndex, type CrawlRef } from './cc';
import { keywordsIn, parseSurt, tldOf } from './keywords';

export interface KeywordHost {
  host: string;
  /** Lines of the top-level index that fall on this host; each stands for about 3000 pages. */
  lines: number;
  estimatedPages: number;
  /** Keywords in the host name. */
  keywords: string[];
  /** Keywords seen in paths on this host. */
  pathKeywords: string[];
}

export interface KeywordPass {
  crawl: string;
  indexLines: number;
  estimatedPages: number;
  /** Hosts whose name or paths carry a crypto keyword, largest first. */
  hosts: KeywordHost[];
  /** How much of the full index one top-level domain takes, e.g. to list every .pl page. */
  tld: Record<string, { blocks: number; megabytes: number }>;
}

const PAGES_PER_LINE = 3000;

/**
 * Seeds from URLs alone. The crawl's top-level index is a sample of one page in 3000, sorted by host.
 * Reading it costs one 100 MB download and finds every larger site whose name or paths speak of crypto —
 * no page is fetched and no site name is supplied by hand.
 */
export async function keywordPass(crawl: CrawlRef, tlds = ['pl']): Promise<KeywordPass> {
  const hosts = new Map<string, { lines: number; keywords: Set<string>; pathKeywords: Set<string> }>();
  const tld: KeywordPass['tld'] = Object.fromEntries(tlds.map((t) => [t, { blocks: 0, megabytes: 0 }]));
  let indexLines = 0;
  for await (const line of clusterIndex(crawl)) {
    indexLines++;
    const top = tldOf(line.surt);
    if (tld[top]) {
      tld[top].blocks++;
      tld[top].megabytes += line.length / 1e6;
    }
    const parsed = parseSurt(line.surt);
    if (!parsed) continue;
    const inHost = keywordsIn(parsed.host);
    const inPath = keywordsIn(parsed.path.slice(0, 200));
    let h = hosts.get(parsed.host);
    if (!h) {
      if (!inHost.length && !inPath.length) continue; // hosts without any keyword are not kept: there are hundreds of thousands
      hosts.set(parsed.host, (h = { lines: 0, keywords: new Set(inHost), pathKeywords: new Set() }));
    }
    h.lines++;
    for (const k of inPath) h.pathKeywords.add(k);
  }
  const out: KeywordPass = {
    crawl: crawl.id, indexLines, estimatedPages: indexLines * PAGES_PER_LINE, tld,
    hosts: [...hosts]
      .map(([host, h]) => ({ host, lines: h.lines, estimatedPages: h.lines * PAGES_PER_LINE, keywords: [...h.keywords], pathKeywords: [...h.pathKeywords] }))
      .sort((a, b) => b.keywords.length - a.keywords.length || b.lines - a.lines || a.host.localeCompare(b.host)),
  };
  mkdirSync(`${crawl.dir}/${crawl.id}`, { recursive: true });
  writeFileSync(`${crawl.dir}/${crawl.id}/keywords.json`, JSON.stringify(out, null, 1));
  return out;
}

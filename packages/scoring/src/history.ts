import type { DocFact, RunFacts } from './types';

export interface ProfileVersion {
  at: string;
  /** 'archive' = a stored past copy of the page; 'live' = the page as fetched during this analysis. */
  source: 'archive' | 'live';
  url: string;
  addresses: { chain: string; address: string }[];
}

export interface ProfileChange {
  kind: 'swap' | 'added' | 'removed';
  chain: string;
  from?: string;
  to?: string;
  /** The last version with the old state and the first with the new one. */
  after: string;
  before: string;
  detail: string;
}

/** How one profile's published addresses changed over time. */
export interface ProfileHistory {
  origin: string;
  source: string;
  handle: string;
  url: string;
  versions: ProfileVersion[];
  changes: ProfileChange[];
}

const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;
const day = (iso: string) => iso.slice(0, 10);

/**
 * Lines up archived copies of each profile with its present state and reports what changed —
 * in particular a wallet address replaced by another one.
 */
export function buildHistories(facts: RunFacts): ProfileHistory[] {
  const byDoc = new Map<string, { chain: string; address: string }[]>();
  for (const m of facts.mentions) {
    if (m.segmentKind === 'quote') continue;
    const list = byDoc.get(m.documentId) ?? [];
    if (!list.some((x) => x.address === m.address)) list.push({ chain: m.chain, address: m.address });
    byDoc.set(m.documentId, list);
  }

  const groups = new Map<string, DocFact[]>();
  for (const d of facts.documents) {
    if (d.container?.kind !== 'archive' || !d.container.url) continue;
    const key = `${d.origin}|${d.container.url}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }

  const out: ProfileHistory[] = [];
  for (const [key, archived] of groups) {
    const url = key.slice(key.indexOf('|') + 1);
    const live = facts.documents.find((d) => d.url === url && d.origin === archived[0].origin && d.container?.kind !== 'archive');
    const versions: ProfileVersion[] = archived
      .map((d): ProfileVersion => ({ at: d.publishedAt ?? d.fetchedAt, source: 'archive', url: d.url, addresses: byDoc.get(d.id) ?? [] }))
      .sort((a, b) => a.at.localeCompare(b.at));
    if (live) versions.push({ at: live.fetchedAt, source: 'live', url: live.url, addresses: byDoc.get(live.id) ?? [] });

    const changes: ProfileChange[] = [];
    for (let i = 1; i < versions.length; i++) {
      const [prev, cur] = [versions[i - 1], versions[i]];
      const window = `Między ${day(prev.at)} a ${day(cur.at)}`;
      for (const chain of new Set([...prev.addresses, ...cur.addresses].map((a) => a.chain))) {
        const was = prev.addresses.filter((a) => a.chain === chain).map((a) => a.address);
        const is = cur.addresses.filter((a) => a.chain === chain).map((a) => a.address);
        const removed = was.filter((a) => !is.includes(a));
        const added = is.filter((a) => !was.includes(a));
        const base = { chain, after: prev.at, before: cur.at };
        if (removed.length === 1 && added.length === 1) {
          changes.push({ ...base, kind: 'swap', from: removed[0], to: added[0], detail: `${window} adres ${short(removed[0])} został na profilu zastąpiony adresem ${short(added[0])}.` });
          continue;
        }
        for (const a of removed) changes.push({ ...base, kind: 'removed', from: a, detail: `${window} adres ${short(a)} zniknął z profilu.` });
        for (const a of added) changes.push({ ...base, kind: 'added', to: a, detail: `${window} na profilu pojawił się adres ${short(a)}.` });
      }
    }
    out.push({ origin: archived[0].origin, source: facts.sources?.[archived[0].origin] ?? archived[0].origin, handle: archived[0].authorHandle ?? '', url, versions, changes });
  }
  return out.sort((a, b) => b.changes.length - a.changes.length || a.url.localeCompare(b.url));
}

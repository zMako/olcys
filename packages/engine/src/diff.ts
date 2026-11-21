import type { Link } from '@olcys/scoring';
import type { RunSummary } from './run';

export interface LinkChange {
  kind: 'added' | 'removed' | 'score' | 'status';
  chain: string;
  address: string;
  before?: { status: string; score: number; band: string };
  after?: { status: string; score: number; band: string };
  /** Scoring rules that fired now but not before, and the other way round. */
  rulesAdded: string[];
  rulesRemoved: string[];
  /** Places where the address stands now but did not before. */
  newSources: string[];
  text: string;
}

export interface AccountChange {
  kind: 'added' | 'removed';
  origin: string;
  handle: string;
  text: string;
}

export interface ProfileAddressChange {
  kind: 'swap' | 'added' | 'removed';
  origin: string;
  handle: string;
  url: string;
  chain: string;
  from?: string;
  to?: string;
  text: string;
}

export interface IndicatorChange {
  kind: 'added' | 'removed' | 'grew';
  chain: string;
  address: string;
  type: string;
  text: string;
}

/** What is different between two analyses of the same case. */
export interface RunDiff {
  baseRunId: string;
  runId: string;
  /** When each analysis was made. */
  baseAt?: string;
  at?: string;
  changed: boolean;
  links: LinkChange[];
  accounts: AccountChange[];
  /** Addresses that changed on a profile between the two analyses (e.g. a wallet address swapped for another). */
  profiles: ProfileAddressChange[];
  indicators: IndicatorChange[];
  estimate: { year: number; before: number; after: number; delta: number }[];
  /** Stored pages compared by address and content hash. */
  pages: { changed: number; added: number; gone: number };
  /** One sentence for lists and notifications. */
  summary: string;
}

export interface PageRef {
  url: string;
  sha256: string;
}

const CHAIN: Record<string, string> = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', tron: 'Tron' };
const BAND: Record<string, string> = {
  very_high: 'bardzo wysokie', probable: 'prawdopodobne', medium: 'średnie', noise: 'niskie, szum', excluded: 'wykluczone', not_attributable: 'nie do przypisania',
};
const PLACEMENT: Record<string, string> = {
  own_profile: 'własny profil', sale: 'ogłoszenie', discussion: 'dyskusja na forum', mass_comment: 'masowe komentarze', quoted: 'cytat',
};
const short = (a: string) => (a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);
const pln = (n: number) => `${Math.round(n).toLocaleString('pl-PL')} zł`;
const plural = (n: number, one: string, few: string, many: string) => `${n} ${n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many}`;

/** One link per address: the one on the firmest identity (links are stored strongest identity first). */
function bestLinks(s: RunSummary): Map<string, Link> {
  const out = new Map<string, Link>();
  for (const l of s.assessment?.links ?? []) {
    const key = `${l.chain}:${l.address}`;
    if (!out.has(key)) out.set(key, l);
  }
  return out;
}
const state = (l: Link) => ({ status: l.status, score: l.score, band: l.band });
const sources = (l: Link) => new Set(l.occurrences.map((o) => o.image?.url ?? o.url));
const ruleTitles = (l: Link) => new Map(l.receipt.filter((r) => r.effect !== 'info').map((r) => [r.rule, r.title]));

/** Addresses each live profile shows, by profile address. Archived copies are another matter (the web archive's, not ours). */
function profileAddresses(s: RunSummary): Map<string, { origin: string; handle: string; addresses: Map<string, string> }> {
  const out = new Map<string, { origin: string; handle: string; addresses: Map<string, string> }>();
  for (const a of s.addresses) {
    for (const o of a.occurrences) {
      if (o.doc_type !== 'profile' || o.container?.kind === 'archive' || o.segment_kind === 'quote' || !o.author_handle) continue;
      const p = out.get(o.url) ?? { origin: o.origin, handle: o.author_handle, addresses: new Map<string, string>() };
      p.addresses.set(a.address, a.chain);
      out.set(o.url, p);
    }
  }
  return out;
}

/**
 * Compares two analyses of the same case: which addresses appeared or disappeared, whose score changed and why,
 * which accounts joined, what a profile shows now versus then, new cash-out patterns, and the change in the estimate.
 * A pure function of two stored results, so any pair of analyses can be compared at any time.
 */
export function compareRuns(prev: RunSummary, cur: RunSummary, pages?: { prev: PageRef[]; cur: PageRef[] }, when?: { prev?: string; cur?: string }): RunDiff {
  const [before, after] = [bestLinks(prev), bestLinks(cur)];
  const links: LinkChange[] = [];
  for (const [key, l] of after) {
    const old = before.get(key);
    const base = { chain: l.chain, address: l.address };
    if (!old) {
      const where = PLACEMENT[l.occurrences[0]?.placement ?? ''] ?? 'źródła';
      links.push({
        ...base, kind: 'added', after: state(l), rulesAdded: [...ruleTitles(l).keys()], rulesRemoved: [], newSources: [...sources(l)],
        text: l.status === 'attributed'
          ? `Nowy adres ${short(l.address)} (${CHAIN[l.chain] ?? l.chain}): ${l.score}%, ${BAND[l.band]} — ${where}.`
          : `Nowy adres ${short(l.address)} (${CHAIN[l.chain] ?? l.chain}) odrzucony: ${l.account?.labels[0]?.name ?? l.receipt[0]?.title.toLowerCase() ?? BAND[l.band]}.`,
      });
      continue;
    }
    const [was, is] = [ruleTitles(old), ruleTitles(l)];
    const rulesAdded = [...is.keys()].filter((r) => !was.has(r));
    const rulesRemoved = [...was.keys()].filter((r) => !is.has(r));
    const newSources = [...sources(l)].filter((u) => !sources(old).has(u));
    if (old.status !== l.status) {
      links.push({ ...base, kind: 'status', before: state(old), after: state(l), rulesAdded, rulesRemoved, newSources, text: `Adres ${short(l.address)}: było „${BAND[old.band]}”, jest „${BAND[l.band]}”${l.status === 'attributed' ? ` (${l.score}%)` : ''}.` });
    } else if (old.score !== l.score) {
      const why = [
        ...rulesAdded.map((r) => `doszła przesłanka „${is.get(r)}” (${r})`),
        ...rulesRemoved.map((r) => `odpadła przesłanka „${was.get(r)}” (${r})`),
      ];
      links.push({
        ...base, kind: 'score', before: state(old), after: state(l), rulesAdded, rulesRemoved, newSources,
        text: `Wynik adresu ${short(l.address)}: ${old.score}% → ${l.score}%${why.length ? ` — ${why.join(', ')}` : newSources.length ? ' — adres pojawił się w nowym miejscu' : ''}.`,
      });
    }
  }
  for (const [key, old] of before) {
    if (after.has(key)) continue;
    links.push({
      kind: 'removed', chain: old.chain, address: old.address, before: state(old), rulesAdded: [], rulesRemoved: [], newSources: [],
      text: `Adresu ${short(old.address)} nie ma już w źródłach (poprzednio ${old.status === 'attributed' ? `${old.score}%` : BAND[old.band]}). Zapis poprzedniej analizy pozostaje w magazynie dowodów.`,
    });
  }

  // Accounts tied to the person
  const accountsOf = (s: RunSummary) => new Map((s.assessment?.clusters ?? []).flatMap((c) => c.accounts.map((a) => [`${a.origin}:${a.handle.toLowerCase()}`, a] as const)));
  const [accBefore, accAfter] = [accountsOf(prev), accountsOf(cur)];
  const accounts: AccountChange[] = [];
  for (const [k, a] of accAfter) if (!accBefore.has(k)) accounts.push({ kind: 'added', origin: a.origin, handle: a.handle, text: `Nowe konto powiązane z osobą: ${a.handle} (${a.source}).` });
  for (const [k, a] of accBefore) if (!accAfter.has(k)) accounts.push({ kind: 'removed', origin: a.origin, handle: a.handle, text: `Konto ${a.handle} (${a.source}) nie jest już powiązane z osobą.` });

  // What each profile shows now versus then
  const [profBefore, profAfter] = [profileAddresses(prev), profileAddresses(cur)];
  const profiles: ProfileAddressChange[] = [];
  for (const url of new Set([...profBefore.keys(), ...profAfter.keys()])) {
    const [was, is] = [profBefore.get(url), profAfter.get(url)];
    const who = (is ?? was)!;
    if (!accAfter.has(`${who.origin}:${who.handle.toLowerCase()}`) && !accBefore.has(`${who.origin}:${who.handle.toLowerCase()}`)) continue;
    if (!was && !accBefore.has(`${who.origin}:${who.handle.toLowerCase()}`)) continue; // a newly found profile is not a change on a profile
    const chains = new Set([...(was?.addresses.values() ?? []), ...(is?.addresses.values() ?? [])]);
    for (const chain of chains) {
      const a = [...(was?.addresses ?? [])].filter(([, c]) => c === chain).map(([x]) => x);
      const b = [...(is?.addresses ?? [])].filter(([, c]) => c === chain).map(([x]) => x);
      const removed = a.filter((x) => !b.includes(x));
      const added = b.filter((x) => !a.includes(x));
      const base = { origin: who.origin, handle: who.handle, url, chain };
      if (removed.length === 1 && added.length === 1) {
        profiles.push({ ...base, kind: 'swap', from: removed[0], to: added[0], text: `Na profilu ${who.handle} adres ${short(removed[0])} został zastąpiony adresem ${short(added[0])}.` });
        continue;
      }
      for (const x of removed) profiles.push({ ...base, kind: 'removed', from: x, text: `Z profilu ${who.handle} zniknął adres ${short(x)}.` });
      for (const x of added) profiles.push({ ...base, kind: 'added', to: x, text: `Na profilu ${who.handle} pojawił się adres ${short(x)}.` });
    }
  }

  // Cash-out patterns
  const indicatorsOf = (s: RunSummary) => new Map(s.chain.activity.flatMap((w) => w.indicators.map((i) => [`${w.address}|${i.type}`, { w, i }] as const)));
  const [indBefore, indAfter] = [indicatorsOf(prev), indicatorsOf(cur)];
  const indicators: IndicatorChange[] = [];
  for (const [k, { w, i }] of indAfter) {
    const old = indBefore.get(k);
    if (!old) indicators.push({ kind: 'added', chain: w.chain, address: w.address, type: i.type, text: `Nowy wzorzec przy adresie ${short(w.address)} — ${i.title}: ${i.summary}` });
    else if (i.count > old.i.count) indicators.push({ kind: 'grew', chain: w.chain, address: w.address, type: i.type, text: `${i.title} przy adresie ${short(w.address)}: przybyło przelewów (${old.i.count} → ${i.count}).` });
  }
  for (const [k, { w, i }] of indBefore) {
    if (!indAfter.has(k) && after.has(`${w.chain}:${w.address}`)) indicators.push({ kind: 'removed', chain: w.chain, address: w.address, type: i.type, text: `Wzorzec „${i.title}” przy adresie ${short(w.address)} nie występuje w tej analizie.` });
  }

  // Estimate
  const years = new Set([...(prev.estimate?.years ?? []), ...(cur.estimate?.years ?? [])].map((y) => y.year));
  const estimate = [...years].sort().map((year) => {
    const a = prev.estimate?.years.find((y) => y.year === year)?.totalPln ?? 0;
    const b = cur.estimate?.years.find((y) => y.year === year)?.totalPln ?? 0;
    return { year, before: a, after: b, delta: b - a };
  }).filter((y) => y.delta !== 0);

  // Stored pages
  const [pagesBefore, pagesAfter] = [new Map((pages?.prev ?? []).map((p) => [p.url, p.sha256])), new Map((pages?.cur ?? []).map((p) => [p.url, p.sha256]))];
  const pageStats = {
    changed: [...pagesAfter].filter(([u, h]) => pagesBefore.has(u) && pagesBefore.get(u) !== h).length,
    added: [...pagesAfter.keys()].filter((u) => !pagesBefore.has(u)).length,
    gone: [...pagesBefore.keys()].filter((u) => !pagesAfter.has(u)).length,
  };

  const parts: string[] = [];
  const count = (kind: LinkChange['kind']) => links.filter((l) => l.kind === kind).length;
  if (count('added')) parts.push(plural(count('added'), 'nowy adres', 'nowe adresy', 'nowych adresów'));
  if (count('removed')) parts.push(plural(count('removed'), 'adres zniknął', 'adresy zniknęły', 'adresów zniknęło'));
  if (count('score') + count('status')) parts.push(plural(count('score') + count('status'), 'zmiana wyniku', 'zmiany wyniku', 'zmian wyniku'));
  if (profiles.length) parts.push(plural(profiles.length, 'zmiana na profilu', 'zmiany na profilach', 'zmian na profilach'));
  if (accounts.length) parts.push(plural(accounts.length, 'zmiana wśród kont', 'zmiany wśród kont', 'zmian wśród kont'));
  if (indicators.length) parts.push(plural(indicators.length, 'zmiana w przepływach', 'zmiany w przepływach', 'zmian w przepływach'));
  const total = estimate.reduce((n, y) => n + y.delta, 0);
  if (total) parts.push(`szacunek ${total > 0 ? '+' : '−'}${pln(Math.abs(total))}`);
  const changed = parts.length > 0;

  return {
    baseRunId: prev.runId, runId: cur.runId, baseAt: when?.prev, at: when?.cur, changed, links, accounts, profiles, indicators, estimate, pages: pageStats,
    summary: changed ? `Od poprzedniej analizy: ${parts.join(', ')}.` : 'Bez zmian od poprzedniej analizy.',
  };
}

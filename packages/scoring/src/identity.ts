import { identifierKey, makeIdentifier, normalizeIdentifier, usernameVariants, type Identifier } from '@olcys/core';
import type { Ruleset } from './ruleset';
import type { Cluster, ClusterAccount, ClusterLevel, DocFact, MentionFact, Placement, RunFacts } from './types';

export const accountKeyOf = (d: Pick<DocFact, 'origin' | 'authorHandle'>): string | undefined =>
  d.authorHandle ? `${d.origin}:${d.authorHandle.toLowerCase()}` : undefined;

const HARD_KINDS = new Set(['email', 'phone', 'messenger_id', 'profile_url']);
const KIND_PL: Record<string, string> = { email: 'adres e-mail', phone: 'numer telefonu', messenger_id: 'identyfikator komunikatora', profile_url: 'odnośnik do profilu' };
const LEVEL_ORDER: ClusterLevel[] = ['entered', 'publisher', 'handle_variant', 'name_unique', 'name_ambiguous', 'third_party'];

export interface Identities {
  /** Clusters tied to what the analyst entered, strongest first. */
  clusters: Cluster[];
  /** Cluster id for every account, including third parties (ids starting with "X"). */
  clusterOfAccount: Map<string, string>;
  accounts: Map<string, ClusterAccount>;
  thirdPartyAccounts: number;
}

export interface IdentityContext {
  placementOf(doc: DocFact, mention: MentionFact): Placement;
  /** True for addresses that can never be personal (labelled institutions, contracts). */
  isNonPersonal(chain: string, address: string): boolean;
}

/**
 * Decides which accounts belong to one person and how firmly each group is tied to the
 * analyst's input. Accounts are joined only on hard evidence:
 *   J1  one profile links to the other;
 *   J2  both list the same e-mail, phone or messenger id;
 *   J3  a contact detail listed on one profile led directly to the other;
 *   J4  both publish the same personal address on their own profile, on different services;
 *   J6  each published an address of the same on-chain wallet (addresses spent together in one transaction);
 *       nothing on the web has to connect the two accounts — the blockchain does;
 *   J7  the on-chain name of an address one account published has a record pointing at the other account;
 *   J5  both carry the exact nick (or other hard identifier) the analyst entered — the KAS method
 *       treats traces "tied to the same nick or phone number" as belonging together.
 * A matching name alone never joins two accounts.
 */
export function resolveIdentities(facts: RunFacts, ruleset: Ruleset, ctx: IdentityContext): Identities {
  const docs = new Map(facts.documents.map((d) => [d.id, d]));
  const accounts = new Map<string, ClusterAccount>();
  for (const d of facts.documents) {
    const k = accountKeyOf(d);
    if (!k) continue;
    const a = accounts.get(k) ?? { origin: d.origin, source: facts.sources?.[d.origin] ?? d.origin, handle: d.authorHandle! };
    a.profileUrl ??= d.authorProfileUrl;
    a.displayName ??= d.authorDisplayName;
    accounts.set(k, a);
  }
  const label = (k: string) => `${accounts.get(k)!.handle} (${accounts.get(k)!.source})`;

  // ---- union-find
  const parent = new Map<string, string>([...accounts.keys()].map((k) => [k, k]));
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const joins: { a: string; b: string; rule: string; detail: string }[] = [];
  const join = (a: string | undefined, b: string | undefined, rule: string, detail: string) => {
    if (!a || !b || a === b || !accounts.has(a) || !accounts.has(b)) return;
    if (!joins.some((j) => j.rule === rule && ((j.a === a && j.b === b) || (j.a === b && j.b === a)))) joins.push({ a, b, rule, detail });
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  // Only what an account says about itself counts: its profile, or content it authored.
  const selfDocs = facts.documents.filter((d) => accountKeyOf(d) && d.docType === 'profile');
  const byProfileUrl = new Map<string, string>();
  for (const [k, a] of accounts) if (a.profileUrl) byProfileUrl.set(normalizeIdentifier('profile_url', a.profileUrl), k);

  // J1: explicit link from one profile to another.
  for (const d of selfDocs) {
    for (const lead of d.discovered) {
      if (lead.kind !== 'profile_url') continue;
      const target = byProfileUrl.get(lead.normalized);
      if (target) join(accountKeyOf(d), target, 'J1', `${label(accountKeyOf(d)!)} podaje na profilu odnośnik do konta ${label(target)}`);
    }
  }

  // J2: the same contact detail listed by two accounts.
  const listers = new Map<string, { lead: Identifier; keys: Set<string> }>();
  for (const d of selfDocs) {
    for (const lead of d.discovered) {
      if (!HARD_KINDS.has(lead.kind) || lead.kind === 'profile_url') continue;
      const e = listers.get(identifierKey(lead)) ?? { lead, keys: new Set<string>() };
      e.keys.add(accountKeyOf(d)!);
      listers.set(identifierKey(lead), e);
    }
  }
  for (const { lead, keys } of listers.values()) {
    const list = [...keys].sort();
    for (let i = 1; i < list.length; i++) join(list[0], list[i], 'J2', `oba konta podają ten sam ${KIND_PL[lead.kind]}: ${lead.value}`);
  }

  // J3: a contact detail listed on one profile led to the other profile.
  for (const h of facts.hits) {
    if (!HARD_KINDS.has(h.identifier.kind) || h.relation !== 'profile_owner') continue;
    const target = accountKeyOf(docs.get(h.documentId)!);
    const lists = (k: string | undefined) => selfDocs.some((d) => accountKeyOf(d) === k && d.discovered.some((l) => identifierKey(l) === identifierKey(h.identifier)));
    if (lists(target)) continue; // both accounts list it: already covered by J2
    for (const d of selfDocs) {
      if (d.discovered.some((l) => identifierKey(l) === identifierKey(h.identifier))) {
        join(accountKeyOf(d), target, 'J3', `${KIND_PL[h.identifier.kind]} ${h.identifier.value} z profilu ${label(accountKeyOf(d)!)} prowadzi do konta ${target ? label(target) : '?'}`);
      }
    }
  }

  // J4: the same personal address on the own profile of accounts on different services.
  const profileAddresses = new Map<string, Set<string>>();
  for (const m of facts.mentions) {
    const d = docs.get(m.documentId)!;
    const k = accountKeyOf(d);
    if (!k || ctx.placementOf(d, m) !== 'own_profile' || ctx.isNonPersonal(m.chain, m.address)) continue;
    const key = `${m.chain}:${m.address}`;
    profileAddresses.set(key, (profileAddresses.get(key) ?? new Set()).add(k));
  }
  for (const [addr, keys] of profileAddresses) {
    const list = [...keys].sort();
    const origins = new Set(list.map((k) => accounts.get(k)!.origin));
    if (list.length < 2 || origins.size !== list.length) continue; // two accounts on one service: ambiguous, do not join
    const short = addr.split(':')[1];
    for (let i = 1; i < list.length; i++) join(list[0], list[i], 'J4', `oba konta publikują na własnym profilu ten sam adres ${short.slice(0, 10)}…${short.slice(-6)}`);
  }

  // J6: accounts that each published an address of one wallet. The wallet is one party's by construction
  // (its addresses funded the same transactions), so whoever advertises its addresses as their own is that party.
  const ownPublishers = new Map<string, Set<string>>();
  for (const m of facts.mentions) {
    const d = docs.get(m.documentId)!;
    const k = accountKeyOf(d);
    const placement = ctx.placementOf(d, m);
    if (!k || placement === 'quoted' || placement === 'mass_comment' || ctx.isNonPersonal(m.chain, m.address)) continue;
    ownPublishers.set(m.address, (ownPublishers.get(m.address) ?? new Set()).add(k));
  }
  const shortAddr = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;
  for (const w of facts.wallets ?? []) {
    const holders: { key: string; address: string }[] = [];
    for (const member of w.members) for (const k of ownPublishers.get(member.address) ?? []) holders.push({ key: k, address: member.address });
    holders.sort((a, b) => (a.address === w.root ? -1 : b.address === w.root ? 1 : a.key.localeCompare(b.key)));
    for (let i = 1; i < holders.length; i++) {
      if (holders[i].address === holders[0].address) continue; // the same address on two accounts is J4's business
      const how = w.members.find((m) => m.address === holders[i].address)?.rule === 'D2' || w.members.find((m) => m.address === holders[0].address)?.rule === 'D2'
        ? 'oba adresy wpłacały na ten sam adres depozytowy giełdy, a taki adres ma tylko jeden klient'
        : 'środki z obu wydano w jednej transakcji';
      join(holders[0].key, holders[i].key, 'J6', `${label(holders[i].key)} podaje adres ${shortAddr(holders[i].address)}, który należy do tej samej osoby co adres ${shortAddr(holders[0].address)} podany przez ${label(holders[0].key)} — ${how}`);
    }
  }

  // J7: the name an address claimed on chain carries records written by whoever controls it. If a record names
  // another account, the address owner is pointing at that account.
  const listedEmail = new Map<string, string>(); // e-mail → account that lists it
  for (const d of selfDocs) for (const l of d.discovered) if (l.kind === 'email') listedEmail.set(l.normalized, accountKeyOf(d)!);
  for (const n of facts.names ?? []) {
    if (!n.verified) continue;
    for (const publisher of ownPublishers.get(n.address) ?? []) {
      for (const [key, value] of Object.entries(n.records)) {
        const targets = key === 'email'
          ? [listedEmail.get(value.toLowerCase())]
          : ['com.github', 'com.twitter', 'org.telegram'].includes(key)
            ? [...accounts.keys()].filter((k) => accounts.get(k)!.handle.toLowerCase() === value.replace(/^@/, '').toLowerCase())
            : [];
        for (const target of targets) {
          join(publisher, target, 'J7', `adres ${shortAddr(n.address)} podany przez ${label(publisher)} ma nazwę ${n.name}, a jej rekord „${key}: ${value}” wskazuje konto ${target ? label(target) : ''}`);
        }
      }
    }
  }

  // J5: accounts that each match the same entered hard identifier.
  const enteredHard = new Map(facts.seeds.filter((x) => x.kind !== 'full_name' && x.kind !== 'crypto_address').map((x) => [identifierKey(x), x]));
  const matched = new Map<string, Set<string>>();
  for (const h of facts.hits) {
    const k = accountKeyOf(docs.get(h.documentId)!);
    const sk = identifierKey(h.identifier);
    if (k && h.relation !== 'mention' && enteredHard.has(sk)) matched.set(sk, (matched.get(sk) ?? new Set()).add(k));
  }
  for (const [sk, keys] of matched) {
    const list = [...keys].sort();
    for (let i = 1; i < list.length; i++) join(list[0], list[i], 'J5', `oba konta odpowiadają wprowadzonemu identyfikatorowi „${enteredHard.get(sk)!.value}”`);
  }

  // ---- groups
  const groups = new Map<string, string[]>();
  for (const k of [...accounts.keys()].sort()) {
    const r = find(k);
    groups.set(r, [...(groups.get(r) ?? []), k]);
  }

  // ---- how each group is tied to the input
  const hardSeeds = new Set(facts.seeds.filter((s) => s.kind !== 'full_name' && s.kind !== 'crypto_address').map(identifierKey));
  const addressSeeds = new Set(facts.seeds.filter((s) => s.kind === 'crypto_address').map((s) => s.normalized));
  // Other spellings of the entered nick ("szklane_domy" → "szklanedomy"): likely the same person, but not certain.
  const variantSeeds = new Set(facts.seeds.filter((x) => x.kind === 'username').flatMap((x) => usernameVariants(x.value)).map((v) => identifierKey(makeIdentifier('username', v))));
  const entered = new Set<string>();
  const variant = new Set<string>();
  const publisher = new Set<string>();
  const nameMatches = new Map<string, Set<string>>(); // group root → names it was matched by
  const nameCarriers = new Map<string, Set<string>>(); // name → group roots carrying it

  const carry = (name: string, root: string) => nameCarriers.set(name, (nameCarriers.get(name) ?? new Set()).add(root));
  for (const [k, a] of accounts) if (a.displayName) carry(normalizeIdentifier('full_name', a.displayName), find(k));
  for (const d of selfDocs) for (const l of d.discovered) if (l.kind === 'full_name') carry(l.normalized, find(accountKeyOf(d)!));

  for (const h of facts.hits) {
    const k = accountKeyOf(docs.get(h.documentId)!);
    if (!k || h.relation === 'mention') continue;
    const root = find(k);
    if (hardSeeds.has(identifierKey(h.identifier))) entered.add(root);
    if (variantSeeds.has(identifierKey(h.identifier))) variant.add(root);
    if (h.identifier.kind === 'full_name' && h.relation === 'profile_owner') {
      nameMatches.set(root, (nameMatches.get(root) ?? new Set()).add(h.identifier.normalized));
      carry(h.identifier.normalized, root);
    }
  }
  for (const m of facts.mentions) {
    if (!addressSeeds.has(m.address) || m.segmentKind === 'quote') continue;
    const k = accountKeyOf(docs.get(m.documentId)!);
    if (k) publisher.add(find(k));
  }

  const built: (Cluster & { root: string })[] = [];
  for (const [root, keys] of groups) {
    let level: ClusterLevel = 'third_party';
    let note = '';
    if (entered.has(root)) {
      level = 'entered';
      note = 'Konto odpowiada wprost wprowadzonemu identyfikatorowi albo jest z nim połączone odnośnikiem lub danymi kontaktowymi.';
    } else if (publisher.has(root)) {
      level = 'publisher';
      note = 'Konto samo opublikowało wprowadzony adres.';
    } else if (variant.has(root)) {
      level = 'handle_variant';
      note = `Konto znaleziono po nicku, który różni się od wprowadzonego tylko zapisem (na przykład brakiem podkreślnika). To prawdopodobnie ta sama osoba, ale nic więcej tych kont nie łączy — wynik ograniczony do ${ruleset.identityCaps.handle_variant}%.`;
    } else if (nameMatches.has(root)) {
      const names = [...nameMatches.get(root)!];
      const carriers = Math.max(...names.map((n) => nameCarriers.get(n)?.size ?? 1));
      if (carriers >= 2) {
        level = 'name_ambiguous';
        note = `Konto dopasowane wyłącznie po imieniu i nazwisku, a to samo imię i nazwisko mają ${carriers} niepowiązane ze sobą grupy kont. Bez drugiego śladu nie wiadomo, czy to ta sama osoba — wynik ograniczony do ${ruleset.identityCaps.name_ambiguous}%.`;
      } else {
        level = 'name_unique';
        note = `Konto dopasowane wyłącznie po imieniu i nazwisku. Innych kont o tym nazwisku nie znaleziono, ale zbieżność nazwisk jest możliwa — wynik ograniczony do ${ruleset.identityCaps.name_unique}%.`;
      }
    }
    const identifiers = new Map<string, Identifier>();
    for (const d of selfDocs) {
      if (!keys.includes(accountKeyOf(d)!)) continue;
      for (const l of d.discovered) if (l.kind !== 'profile_url') identifiers.set(identifierKey(l), l);
    }
    built.push({
      root,
      id: '',
      level,
      identityCap: level === 'third_party' ? 0 : ruleset.identityCaps[level],
      identityNote: note,
      accounts: keys.map((k) => accounts.get(k)!),
      joins: joins.filter((j) => keys.includes(j.a)).map(({ rule, detail }) => ({ rule, detail })),
      identifiers: [...identifiers.values()],
    });
  }
  built.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.root.localeCompare(b.root));

  const clusterOfAccount = new Map<string, string>();
  let subjects = 0;
  let others = 0;
  for (const c of built) {
    c.id = c.level === 'third_party' ? `X${++others}` : `T${++subjects}`;
    for (const k of groups.get(c.root)!) clusterOfAccount.set(k, c.id);
  }
  return {
    clusters: built.filter((c) => c.level !== 'third_party').map(({ root: _root, ...c }) => c),
    clusterOfAccount,
    accounts,
    thirdPartyAccounts: built.filter((c) => c.level === 'third_party').reduce((n, c) => n + c.accounts.length, 0),
  };
}

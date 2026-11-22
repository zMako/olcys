import { FARCASTER_API, farcasterProfileItem, parseFarcasterUser } from '@olcys/connectors';
import { makeIdentifier, type Identifier, type SourceConnector, type SourceItem } from '@olcys/core';
import { readEnrichment } from './enrich';
import { readFarcasterRecords, type FarcasterRecord } from './farcaster';

/** One person as the corpus knows them: a Farcaster account with everything other registers tie to it. */
export interface CorpusPerson {
  record: FarcasterRecord;
  /** Handles on other services, each with how the tie is known. Only ties backed by a proof or a verified connection. */
  handles: { service: string; handle: string; proof: string }[];
  /** On-chain names of the person's wallets: each wallet claimed the name, and the name points back at the wallet. */
  names: { name: string; address: string }[];
  /** Keybase accounts of the same person. */
  keybase: string[];
  /** Bitcoin addresses signed on Keybase. */
  bitcoin: string[];
}

/** The corpus turned around: from an address to the accounts that claimed it, from a nick on any service to the person. */
export interface CorpusIndex {
  accounts: number;
  addresses: number;
  byAddress: Map<string, FarcasterRecord[]>;
  byHandle: Map<string, FarcasterRecord>;
  /** Any verified handle of a person, lower-cased → the person. */
  byAnyHandle: Map<string, CorpusPerson[]>;
  people: Map<number, CorpusPerson>;
}

export function loadCorpusIndex(dir: string): CorpusIndex {
  const byAddress = new Map<string, FarcasterRecord[]>();
  const byHandle = new Map<string, FarcasterRecord>();
  const byAnyHandle = new Map<string, CorpusPerson[]>();
  const people = new Map<number, CorpusPerson>();
  const records = readFarcasterRecords(`${dir}/farcaster`);
  const extra = new Map(readEnrichment(`${dir}/farcaster`).map((e) => [e.fid, e]));
  const index = (handle: string, person: CorpusPerson) => {
    const key = handle.toLowerCase().replace(/^@/, '');
    if (key && !(byAnyHandle.get(key) ?? []).includes(person)) byAnyHandle.set(key, [...(byAnyHandle.get(key) ?? []), person]);
  };
  for (const r of records) {
    if (r.username) byHandle.set(r.username.toLowerCase(), r);
    for (const a of r.wallets) byAddress.set(a, [...(byAddress.get(a) ?? []), r]);
    const e = extra.get(r.fid);
    const person: CorpusPerson = {
      record: r,
      handles: [
        ...r.connected.map((c) => ({ service: c.platform.toLowerCase(), handle: c.username, proof: 'konto połączone i zweryfikowane w sieci Farcaster' })),
        ...(e?.keybase ?? []).flatMap((k) => k.proofs.map((p) => ({ service: p.service, handle: p.handle, proof: `dowód podpisany kluczem konta Keybase ${k.username}` }))),
      ],
      names: (e?.ens ?? []).map((x) => ({ name: x.name, address: x.address })),
      keybase: (e?.keybase ?? []).map((k) => k.username),
      bitcoin: [...new Set((e?.keybase ?? []).flatMap((k) => k.bitcoin))],
    };
    people.set(r.fid, person);
    if (r.username) index(r.username, person);
    for (const h of person.handles) index(h.handle, person);
    for (const k of person.keybase) index(k, person);
    for (const n of person.names) index(n.name, person);
  }
  return { accounts: records.length, addresses: byAddress.size, byAddress, byHandle, byAnyHandle, people };
}

/**
 * Answers two questions no public service answers: "which account claimed this address?" and
 * "which account belongs to the holder of this nick on another service?"
 * The network lets anyone read an account's wallets and connections, but not search the other way; the corpus
 * was built for exactly that. A hit is never taken from the local copy: the account is fetched again from the
 * network, so the evidence stored with the analysis is current and first-hand.
 */
export function createCorpusConnector(dir: string, opts: { api?: string } = {}): SourceConnector {
  const index = loadCorpusIndex(dir);
  const api = (opts.api ?? FARCASTER_API).replace(/\/+$/, '');
  const nick = (id: Identifier) => (id.kind === 'username' ? id.normalized : undefined);
  return {
    id: 'corpus-farcaster',
    descriptor: { name: `Indeks kont Farcaster (${index.accounts.toLocaleString('pl-PL')} kont, zbudowany lokalnie)`, kind: 'search', origin: 'farcaster', hosts: [new URL(api).host], synthetic: false },
    supports: (id) => (id.kind === 'crypto_address' && index.byAddress.has(id.normalized)) || (!!nick(id) && index.byAnyHandle.has(nick(id)!)),
    async *search(id, ctx): AsyncGenerator<SourceItem> {
      const byNick = nick(id) ? index.byAnyHandle.get(nick(id)!) ?? [] : [];
      const hits = id.kind === 'crypto_address' ? (index.byAddress.get(id.normalized) ?? []).map((record) => ({ record, person: index.people.get(record.fid) })) : byNick.map((person) => ({ record: person.record, person }));
      for (const { record, person } of hits) {
        // The account's own name is the live connector's business; this one covers the names the network cannot be searched by.
        if (nick(id) && record.username?.toLowerCase() === nick(id)) continue;
        const res = await ctx.fetch(`${api}/v2/user-by-fid?fid=${record.fid}`);
        if (res.status !== 200) continue;
        const p = parseFarcasterUser(JSON.parse(res.body));
        if (!p) continue;
        if (id.kind === 'crypto_address') {
          // Only if the account still lists the address today.
          if (p.wallets.includes(id.normalized)) yield farcasterProfileItem(p, res.snapshotId, 'mention');
          continue;
        }
        // Reached by a nick the person holds elsewhere. It counts only if the tie is still there, or was proven on Keybase.
        const stillConnected = p.connected.some((c) => c.username.toLowerCase() === nick(id));
        const proven = person?.handles.some((h) => h.handle.toLowerCase() === nick(id) && h.proof.startsWith('dowód')) || person?.keybase.some((k) => k.toLowerCase() === nick(id));
        // An on-chain name counts while the wallet that claimed it is still attached to the account.
        const named = person?.names.some((n) => n.name.toLowerCase() === nick(id) && p.wallets.includes(n.address));
        if (!stillConnected && !proven && !named) continue;
        const item = farcasterProfileItem(p, res.snapshotId, 'profile_owner');
        // The account itself is then read in full by the live connector: signed wallet claims, recent posts.
        if (p.username) item.discovered.push(makeIdentifier('profile_url', `https://farcaster.xyz/${p.username}`));
        // The Keybase accounts of the same person are leads: there the addresses are signed with the account's key.
        for (const k of person?.keybase ?? []) item.discovered.push(makeIdentifier('profile_url', `https://keybase.io/${k}`));
        yield item;
      }
    },
  };
}

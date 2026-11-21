import { FARCASTER_API, farcasterProfileItem, parseFarcasterUser } from '@olcys/connectors';
import type { SourceConnector, SourceItem } from '@olcys/core';
import { readFarcasterRecords, type FarcasterRecord } from './farcaster';

/** The corpus turned around: from an address to the accounts that claimed it, from a nick to its record. */
export interface CorpusIndex {
  accounts: number;
  addresses: number;
  byAddress: Map<string, FarcasterRecord[]>;
  byHandle: Map<string, FarcasterRecord>;
}

export function loadCorpusIndex(dir: string): CorpusIndex {
  const byAddress = new Map<string, FarcasterRecord[]>();
  const byHandle = new Map<string, FarcasterRecord>();
  const records = readFarcasterRecords(`${dir}/farcaster`);
  for (const r of records) {
    if (r.username) byHandle.set(r.username.toLowerCase(), r);
    for (const a of r.wallets) byAddress.set(a, [...(byAddress.get(a) ?? []), r]);
  }
  return { accounts: records.length, addresses: byAddress.size, byAddress, byHandle };
}

/**
 * Answers the question no public service answers: "which account claimed this address?"
 * The network lets anyone read an account's wallets, but not search the other way. The corpus was built
 * for exactly that. A hit is not taken from the local copy: the account is fetched again from the network,
 * so the evidence stored with the analysis is current and first-hand.
 */
export function createCorpusConnector(dir: string, opts: { api?: string } = {}): SourceConnector {
  const index = loadCorpusIndex(dir);
  const api = (opts.api ?? FARCASTER_API).replace(/\/+$/, '');
  return {
    id: 'corpus-farcaster',
    descriptor: { name: `Indeks kont Farcaster (${index.accounts.toLocaleString('pl-PL')} kont, zbudowany lokalnie)`, kind: 'search', origin: 'farcaster', hosts: [new URL(api).host], synthetic: false },
    supports: (id) => id.kind === 'crypto_address' && index.byAddress.has(id.normalized),
    async *search(id, ctx): AsyncGenerator<SourceItem> {
      for (const record of index.byAddress.get(id.normalized) ?? []) {
        const res = await ctx.fetch(`${api}/v2/user-by-fid?fid=${record.fid}`);
        if (res.status !== 200) continue;
        const p = parseFarcasterUser(JSON.parse(res.body));
        // Only if the account still lists the address today.
        if (p?.wallets.includes(id.normalized)) yield farcasterProfileItem(p, res.snapshotId, 'mention');
      }
    },
  };
}

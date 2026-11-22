import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createEnsNameService } from '@olcys/connectors';
import { parseAddress, type ConnectorContext } from '@olcys/core';
import { readFarcasterRecords } from './farcaster';
import { BlockedError, GaveUpError, PoliteClient } from './polite';

/** What other public registers say about one corpus account: the names its wallets carry, and what it proved on Keybase. */
export interface Enrichment {
  fid: number;
  /** On-chain names of the account's wallets, with the records the owner attached (website, other accounts, e-mail). */
  ens: { address: string; name: string; records: Record<string, string> }[];
  /** Keybase accounts that proved the same X handle, with their other proven accounts and signed Bitcoin addresses. */
  keybase: { username: string; via: string; proofs: { service: string; handle: string }[]; bitcoin: string[] }[];
  at: string;
}

export interface EnrichResult {
  accounts: number;
  done: number;
  withEns: number;
  ensNames: number;
  ensWithAccounts: number;
  withKeybase: number;
  bitcoinAddresses: number;
  stopped?: string;
}

export const readEnrichment = (dir: string): Enrichment[] => {
  const file = `${dir}/enrichment.jsonl`;
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Enrichment) : [];
};

/**
 * Joins the corpus with two more public registers, account by account:
 *  - ENS: the name each wallet claimed for itself and the records on it — written by whoever holds the wallet's key;
 *  - Keybase: accounts that proved, with their own key, that they hold the X handle the Farcaster account connected.
 * One person's identifiers on four services end up side by side, each link carrying its own proof.
 */
export async function enrichFarcaster(dir: string, opts: { rpcUrl?: string; maxAccounts?: number; log?(m: string): void } = {}): Promise<EnrichResult> {
  const records = readFarcasterRecords(dir).filter((r) => r.polish.score >= 0.5);
  const done = new Set(readEnrichment(dir).map((e) => e.fid));
  const rpc = new PoliteClient(6);
  const keybase = new PoliteClient(2);
  const ens = createEnsNameService(opts.rpcUrl ?? process.env.ETH_RPC_URL ?? 'https://ethereum-rpc.publicnode.com');
  // The name service speaks through the engine's network exit; here a plain, paced fetch stands in for it.
  const ctx: ConnectorContext = {
    log: () => {},
    async fetch(url, init) {
      const res = await rpc.raw(url, init);
      return { snapshotId: '', url, status: res.status, contentType: 'application/json', body: res.body, sha256: '', fetchedAt: new Date().toISOString() };
    },
  };
  let stopped: string | undefined;
  let processed = 0;
  try {
    for (const r of records) {
      if (done.has(r.fid) || processed >= (opts.maxAccounts ?? Infinity)) continue;
      const e: Enrichment = { fid: r.fid, ens: [], keybase: [], at: new Date().toISOString() };
      for (const address of r.wallets.slice(0, 6)) {
        const name = await ens.reverse('ethereum', address, ctx).catch(() => undefined);
        if (name) e.ens.push({ address, name: name.name, records: name.records });
      }
      for (const c of r.connected.filter((x) => /^(x|twitter)$/i.test(x.platform)).slice(0, 2)) {
        const res = await keybase.json<{ them?: ({ basics: { username: string }; proofs_summary?: { all?: { proof_type: string; nametag: string; state: number }[] }; cryptocurrency_addresses?: { bitcoin?: { address: string }[] } } | null)[] }>(
          `https://keybase.io/_/api/1.0/user/lookup.json?twitter=${encodeURIComponent(c.username)}&fields=basics,proofs_summary,cryptocurrency_addresses`,
        );
        for (const u of res?.them ?? []) {
          if (!u?.basics?.username) continue;
          e.keybase.push({
            username: u.basics.username, via: `x:${c.username}`,
            proofs: (u.proofs_summary?.all ?? []).filter((p) => p.state === 1).map((p) => ({ service: p.proof_type, handle: p.nametag })),
            bitcoin: (u.cryptocurrency_addresses?.bitcoin ?? []).map((a) => parseAddress(a.address)?.address).filter((a): a is string => !!a),
          });
        }
      }
      appendFileSync(`${dir}/enrichment.jsonl`, JSON.stringify(e) + '\n');
      processed++;
      if (processed % 20 === 0) opts.log?.(`${processed} kont uzupełnionych`);
    }
  } catch (err) {
    if (!(err instanceof BlockedError) && !(err instanceof GaveUpError)) throw err;
    stopped = err.message;
  }
  const all = readEnrichment(dir);
  return {
    accounts: records.length, done: all.length, withEns: all.filter((e) => e.ens.length).length, ensNames: all.reduce((n, e) => n + e.ens.length, 0),
    ensWithAccounts: all.filter((e) => e.ens.some((x) => Object.keys(x.records).some((k) => k.startsWith('com.') || k === 'email' || k === 'url'))).length,
    withKeybase: all.filter((e) => e.keybase.length).length, bitcoinAddresses: new Set(all.flatMap((e) => e.keybase.flatMap((k) => k.bitcoin))).size, stopped,
  };
}

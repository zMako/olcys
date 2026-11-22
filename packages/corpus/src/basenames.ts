import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { BASENAME_RESOLVER as L2_RESOLVER, baseReverseNode, decodeString, encodeTextCall as encodeText, namehash, selector } from '@olcys/connectors';
import { PoliteClient } from './polite';

/**
 * Base names: the name service of the Base network ("ania.base.eth"). A wallet's owner registers a name, points
 * it at the wallet, and may attach records to it — their handle on X, on Farcaster, on GitHub, a website, a few
 * words about themselves. All of it is written by whoever holds the wallet's key, and all of it is public.
 */
export const BASE_RPC = 'https://mainnet.base.org';
/** Records worth reading: where else the owner can be found, and what they say about themselves. */
export const BASENAME_KEYS = ['com.twitter', 'xyz.farcaster', 'com.github', 'url', 'description', 'email', 'org.telegram', 'com.discord', 'location'];

export interface Basename {
  wallet: string;
  name: string;
  records: Record<string, string>;
}

type Call = { to: string; data: string };

async function batch(client: PoliteClient, rpcUrl: string, calls: Call[]): Promise<(string | undefined)[]> {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [{ to: c.to, data: `0x${c.data}` }, 'latest'] })));
  const res = await client.raw(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const parsed = JSON.parse(res.body) as { id: number; result?: string }[] | { error?: unknown };
  const list = Array.isArray(parsed) ? parsed : [];
  return calls.map((_, i) => list.find((x) => x.id === i + 1)?.result);
}

/** Names of a list of wallets, with their records. Wallets without a name are simply absent from the result. */
export async function resolveBasenames(wallets: string[], opts: { rpcUrl?: string; perSecond?: number; batchSize?: number; onProgress?(done: number, named: number): void } = {}): Promise<Basename[]> {
  const client = new PoliteClient(opts.perSecond ?? Number(process.env.BASE_RPC_PER_SECOND ?? 4), 6);
  const rpcUrl = opts.rpcUrl ?? process.env.BASE_RPC_URL ?? BASE_RPC;
  const out: Basename[] = [];
  // Some nodes meter a batch by its size; a smaller batch stays under their per-second allowance.
  const size = opts.batchSize ?? Number(process.env.BASE_RPC_BATCH ?? 20);
  for (let i = 0; i < wallets.length; i += size) {
    const part = wallets.slice(i, i + size);
    const names = await batch(client, rpcUrl, part.map((w) => ({ to: L2_RESOLVER, data: selector('name(bytes32)') + baseReverseNode(w) })));
    for (const [j, raw] of names.entries()) {
      const name = raw ? decodeString(raw) : '';
      if (!name || !/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(name)) continue;
      const node = namehash(name);
      const values = await batch(client, rpcUrl, BASENAME_KEYS.map((k) => ({ to: L2_RESOLVER, data: encodeText(node, k) })));
      const records: Record<string, string> = {};
      BASENAME_KEYS.forEach((k, n) => {
        const v = values[n] ? decodeString(values[n]!).trim() : '';
        if (v) records[k] = v.slice(0, 300);
      });
      out.push({ wallet: part[j], name, records });
    }
    opts.onProgress?.(Math.min(i + 20, wallets.length), out.length);
  }
  return out;
}

export const readBasenames = (file: string): Basename[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Basename) : []);

/** Resolves names for wallets not resolved yet and appends what it finds; can be stopped and continued. */
export async function ingestBasenames(file: string, wallets: string[], opts: Parameters<typeof resolveBasenames>[1] = {}): Promise<{ wallets: number; named: number; withRecords: number }> {
  const doneFile = `${file}.done`;
  const done = new Set(existsSync(doneFile) ? readFileSync(doneFile, 'utf8').split('\n').filter(Boolean) : []);
  const todo = wallets.filter((w) => !done.has(w));
  for (let i = 0; i < todo.length; i += 200) {
    const part = todo.slice(i, i + 200);
    const found = await resolveBasenames(part, opts);
    if (found.length) appendFileSync(file, found.map((b) => JSON.stringify(b)).join('\n') + '\n');
    appendFileSync(doneFile, part.join('\n') + '\n');
    opts.onProgress?.(done.size + i + part.length, readBasenames(file).length);
  }
  const all = readBasenames(file);
  return { wallets: wallets.length, named: all.length, withRecords: all.filter((b) => Object.keys(b.records).length).length };
}

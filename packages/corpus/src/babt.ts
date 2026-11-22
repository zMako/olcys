import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { PoliteClient } from './polite';

// Kept here as plain values so this batch job does not depend on anything but the node's standard interface.
const BABT_CONTRACT = '0x2B09d47D550061f995A3b5C6F0Fd58005215D7c8';
const BALANCE_OF = '0x70a08231';
const TOKEN_ID_OF = '0x773c02d4';
const pad = (address: string) => address.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** Whether one wallet holds Binance's account-bound token (issued to customers who passed its identity check). */
export interface BabtRecord {
  wallet: string;
  holds: boolean;
  /** The token's public serial number, when held. */
  tokenId?: string;
  checkedAt: string;
}

export const babtFile = (root: string) => `${root}/binance/babt.jsonl`;

export function readBabt(root: string): BabtRecord[] {
  const file = babtFile(root);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as BabtRecord) : [];
}

async function calls(client: PoliteClient, rpcUrl: string, list: { to: string; data: string }[]): Promise<(string | undefined)[]> {
  const body = JSON.stringify(list.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_call', params: [c, 'latest'] })));
  const res = await client.raw(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (res.status !== 200) throw new Error(`Węzeł odpowiedział ${res.status}`);
  const parsed = JSON.parse(res.body) as { id: number; result?: string }[];
  if (!Array.isArray(parsed)) throw new Error('Węzeł nie przyjął zapytania zbiorczego');
  return list.map((_, i) => parsed.find((x) => x.id === i + 1)?.result);
}

/**
 * Checks many wallets for Binance's account-bound token: fifty wallets per request, a few requests per second.
 * Results are appended as they come, so the scan can be stopped and continued.
 */
export async function scanBabt(root: string, wallets: string[], opts: { rpcUrl?: string; perSecond?: number; batch?: number; onProgress?(done: number, holders: number): void } = {}): Promise<{ wallets: number; checked: number; holders: number }> {
  mkdirSync(`${root}/binance`, { recursive: true });
  const client = new PoliteClient(Math.min(opts.perSecond ?? 3, 4), 4);
  const rpcUrl = opts.rpcUrl ?? process.env.BSC_RPC_URL ?? 'https://bsc-rpc.publicnode.com';
  const done = new Set(readBabt(root).map((r) => r.wallet));
  const todo = [...new Set(wallets)].filter((w) => /^0x[0-9a-fA-F]{40}$/.test(w) && !done.has(w));
  const size = opts.batch ?? 50;
  let checked = 0;
  for (let i = 0; i < todo.length; i += size) {
    const part = todo.slice(i, i + size);
    const balances = await calls(client, rpcUrl, part.map((w) => ({ to: BABT_CONTRACT, data: BALANCE_OF + pad(w) })));
    // A missing answer is not "no token": the wallet is left for the next run rather than recorded as checked.
    const answered = part.filter((_, k) => balances[k] !== undefined);
    const holders = part.filter((_, k) => balances[k] !== undefined && BigInt(balances[k]!) > 0n);
    const ids = holders.length ? await calls(client, rpcUrl, holders.map((w) => ({ to: BABT_CONTRACT, data: TOKEN_ID_OF + pad(w) }))) : [];
    const checkedAt = new Date().toISOString();
    const records: BabtRecord[] = answered.map((wallet) => {
      const k = holders.indexOf(wallet);
      return k < 0 ? { wallet, holds: false, checkedAt } : { wallet, holds: true, tokenId: ids[k] ? BigInt(ids[k]!).toString() : undefined, checkedAt };
    });
    if (records.length) appendFileSync(babtFile(root), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    checked += records.length;
    opts.onProgress?.(checked, readBabt(root).filter((r) => r.holds).length);
  }
  const all = readBabt(root);
  return { wallets: wallets.length, checked, holders: all.filter((r) => r.holds).length };
}

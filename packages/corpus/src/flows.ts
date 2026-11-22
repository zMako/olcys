import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createAlchemyTransfers, createBlockscout } from '@olcys/connectors';
import type { AddressLabel, ConnectorContext, Transfer } from '@olcys/core';
import { DEFAULT_RULESET, analyzeActivity } from '@olcys/scoring';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER_AGENT = 'OLCyS/0.1 (OSINT research tool)';

/**
 * A network context for batch work outside a case: paced per host, patient with "slow down" answers,
 * and storing nothing. (Inside a case the engine supplies a context that keeps every response as evidence.)
 */
export function plainContext(perSecond: number): ConnectorContext {
  const next = new Map<string, number>();
  return {
    async fetch(url, init) {
      const host = new URL(url).host;
      for (let attempt = 0; ; attempt++) {
        const at = Math.max(Date.now(), next.get(host) ?? 0);
        next.set(host, at + 1000 / perSecond);
        if (at > Date.now()) await sleep(at - Date.now());
        let status = 0;
        let body = '';
        let contentType = '';
        try {
          const res = await fetch(url, { method: init?.method ?? 'GET', headers: { 'user-agent': USER_AGENT, ...init?.headers }, body: init?.body, signal: AbortSignal.timeout(40_000) });
          status = res.status;
          contentType = res.headers.get('content-type') ?? '';
          body = await res.text();
        } catch {
          status = 599;
        }
        if ((status === 429 || status >= 500) && attempt < 5) {
          await sleep(1500 * 2 ** attempt);
          continue;
        }
        return { snapshotId: '', url, status, contentType, body, sha256: '', fetchedAt: new Date().toISOString() };
      }
    },
    log: () => {},
  };
}

/** What one wallet did on the Base network, reduced to what matters for a tax case. */
export interface WalletFlows {
  wallet: string;
  transfers: number;
  firstAt?: string;
  lastAt?: string;
  /** Sent and received, in assets that have a price. */
  sent: Record<string, number>;
  received: Record<string, number>;
  /** Exchanges the wallet paid into, with every deposit. */
  offRamps: { exchange: string; depositAddress: string; rule: string; detail: string; deposits: { at: string; asset: string; amount: number; txHash: string }[] }[];
  /** Labelled services the wallet sent to, by category. */
  services: Record<string, number>;
  scannedAt: string;
}

const VALUED = new Set(['USDC', 'USDT', 'DAI', 'ETH', 'WETH', 'WBTC']);
const ROUGH: Record<string, number> = { WBTC: 60_000, ETH: 3_000, WETH: 3_000, USDC: 1, USDT: 1, DAI: 1 };

export const flowsFile = (root: string) => `${root}/flows/base.jsonl`;

export function readFlows(root: string): WalletFlows[] {
  const file = flowsFile(root);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as WalletFlows) : [];
}

/**
 * Reads the Base history of many wallets and applies the same cash-out rules a case uses: a transfer to a labelled
 * exchange address (L1), or to an unlabelled address that passed everything on to an exchange (D1).
 * The result is a register of which wallets cashed out where — computed from public transfers only.
 */
export async function scanFlows(root: string, wallets: string[], opts: { key: string; perSecond?: number; maxHops?: number; log?(m: string): void }): Promise<{ scanned: number; active: number; cashedOut: number }> {
  mkdirSync(`${root}/flows`, { recursive: true });
  const ctx = plainContext(opts.perSecond ?? 3);
  const base = createAlchemyTransfers({ key: opts.key, maxPages: 1 });
  const labels = createBlockscout({ indexer: 'https://eth.blockscout.com', labels: 'https://metadata.services.blockscout.com', chainId: 8453 });
  const done = new Set(readFlows(root).map((f) => f.wallet));
  const hopCache = new Map<string, Transfer[]>();
  const codeCache = new Map<string, boolean>();
  const isContract = async (address: string) => {
    if (codeCache.has(address)) return codeCache.get(address)!;
    const res = await ctx.fetch('https://base-mainnet.g.alchemy.com/v2', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
    });
    const code = res.status === 200 ? String((JSON.parse(res.body) as { result?: string }).result ?? '0x') : '0x';
    // "0xef0100…" is an ordinary account that delegates to a contract: still a person's (or an exchange's) address.
    const contract = code.length > 2 && !code.startsWith('0xef0100');
    codeCache.set(address, contract);
    return contract;
  };

  const queue = wallets.filter((w) => !done.has(w));
  let scanned = 0;
  let active = 0;
  let cashedOut = 0;
  const worker = async () => {
    for (let wallet = queue.shift(); wallet; wallet = queue.shift()) {
      const transfers = await base.transfers(wallet, ctx);
      const outgoing = transfers.filter((t) => t.from === wallet);
      const known = new Map<string, AddressLabel[]>();
      const learn = async (addresses: string[]) => {
        await labels.labelMany(addresses, ctx);
        for (const a of addresses) if (!known.has(a)) known.set(a, await labels.labelsOf(a, ctx));
      };
      await learn([...new Set(outgoing.map((t) => t.to))].slice(0, 400));
      const labelsOf = (a: string) => known.get(a) ?? [];

      const worth = new Map<string, number>();
      for (const t of outgoing) if (VALUED.has(t.asset) && !labelsOf(t.to).length) worth.set(t.to, (worth.get(t.to) ?? 0) + t.amount * ROUGH[t.asset]);
      const hops = new Map<string, Transfer[]>();
      for (const [x, value] of [...worth].sort((a, b) => b[1] - a[1]).slice(0, opts.maxHops ?? 3)) {
        if (value < 20 || (await isContract(x))) continue;
        if (!hopCache.has(x)) hopCache.set(x, await base.transfers(x, ctx));
        const hop = hopCache.get(x)!;
        hops.set(x, hop);
        await learn([...new Set(hop.filter((t) => t.from === x).map((t) => t.to))].slice(0, 200));
      }

      const result = analyzeActivity({ addresses: [wallet], transfers, labelsOf, hops, ruleset: DEFAULT_RULESET });
      const sum = (ts: Transfer[]) => {
        const m: Record<string, number> = {};
        for (const t of ts) if (VALUED.has(t.asset)) m[t.asset] = Math.round(((m[t.asset] ?? 0) + t.amount) * 1e6) / 1e6;
        return m;
      };
      const services: Record<string, number> = {};
      for (const to of new Set(outgoing.map((t) => t.to))) for (const l of labelsOf(to).slice(0, 1)) services[l.category] = (services[l.category] ?? 0) + 1;
      const sorted = [...transfers].sort((a, b) => a.at.localeCompare(b.at));
      const record: WalletFlows = {
        wallet, transfers: transfers.length, firstAt: sorted[0]?.at, lastAt: sorted[sorted.length - 1]?.at,
        sent: sum(outgoing), received: sum(transfers.filter((t) => t.to === wallet)),
        offRamps: result.offRamps.map((o) => ({ exchange: o.exchange, depositAddress: o.depositAddress, rule: o.rule, detail: o.detail, deposits: o.deposits.map((d) => ({ at: d.at, asset: d.asset, amount: d.amount, txHash: d.txHash })) })),
        services, scannedAt: new Date().toISOString(),
      };
      appendFileSync(flowsFile(root), JSON.stringify(record) + '\n');
      scanned++;
      if (transfers.length) active++;
      if (record.offRamps.length) cashedOut++;
      if (scanned % 25 === 0) opts.log?.(`portfeli ${scanned}/${scanned + queue.length}, z historią na Base ${active}, z wpłatą na giełdę ${cashedOut}`);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  return { scanned, active, cashedOut };
}

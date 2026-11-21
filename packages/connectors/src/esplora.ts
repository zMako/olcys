import type { AccountInfo, ChainConnector, ConnectorContext, Transfer } from '@olcys/core';

interface EsploraTx {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

const SATS = 1e8;
const round = (n: number) => Math.round(n * SATS) / SATS;

/**
 * Turns a Bitcoin transaction into value movements seen from one address.
 * When the address is among those that funded the transaction, the other funders are reported as
 * co-inputs: whoever signs for all of them controls all of them.
 */
export function transfersFromTx(tx: EsploraTx, address: string): Omit<Transfer, 'snapshotId'>[] {
  const ins = tx.vin.map((v) => ({ addr: v.prevout?.scriptpubkey_address, value: v.prevout?.value ?? 0 })).filter((i): i is { addr: string; value: number } => !!i.addr);
  const outs = tx.vout.filter((o): o is { scriptpubkey_address: string; value: number } => !!o.scriptpubkey_address);
  const funders = [...new Set(ins.map((i) => i.addr))];
  const at = new Date((tx.status.block_time ?? 0) * 1000).toISOString();
  const base = { chain: 'bitcoin' as const, txHash: tx.txid, at, asset: 'BTC' };
  if (funders.includes(address)) {
    // The address pays its share of every output that does not go back to the funders (change).
    const share = ins.filter((i) => i.addr === address).reduce((n, i) => n + i.value, 0) / ins.reduce((n, i) => n + i.value, 0);
    const coInputs = funders.filter((f) => f !== address);
    return outs
      .filter((o) => !funders.includes(o.scriptpubkey_address))
      .map((o) => ({ ...base, from: address, to: o.scriptpubkey_address, amount: round((o.value * share) / SATS), ...(coInputs.length ? { coInputs } : {}) }));
  }
  return outs.filter((o) => o.scriptpubkey_address === address).map((o) => ({ ...base, from: funders[0] ?? 'coinbase', to: address, amount: round(o.value / SATS) }));
}

/**
 * Bitcoin through an Esplora-compatible explorer API (the format served by Blockstream's and mempool's
 * explorers, and by self-hosted instances). `base` can point at an explorer inside the organisation's own network.
 */
export function createEsploraConnector(base = 'https://mempool.space/api', maxPages = 4): ChainConnector {
  const root = base.replace(/\/+$/, '');
  const txs = async (address: string, ctx: ConnectorContext): Promise<{ list: EsploraTx[]; snapshotId?: string }> => {
    const list: EsploraTx[] = [];
    let snapshotId: string | undefined;
    let after = '';
    for (let page = 0; page < maxPages; page++) {
      const res = await ctx.fetch(`${root}/address/${address}/txs${after ? `/chain/${after}` : ''}`);
      if (res.status !== 200) throw new Error(`Explorer answered ${res.status} for ${address}`);
      snapshotId ??= res.snapshotId;
      const batch = (JSON.parse(res.body) as EsploraTx[]).filter((t) => t.status.confirmed);
      list.push(...batch);
      if (batch.length < 25) break;
      after = batch[batch.length - 1].txid;
    }
    return { list, snapshotId };
  };
  return {
    id: 'esplora',
    descriptor: { name: `Eksplorator Bitcoin (${new URL(root).host})`, chains: ['bitcoin'], hosts: [new URL(root).host], synthetic: false },
    supports: (chain) => chain === 'bitcoin',
    async getAccount(chain, address, ctx): Promise<AccountInfo> {
      const url = `${root}/address/${address}`;
      const res = await ctx.fetch(url);
      if (res.status !== 200) throw new Error(`Explorer answered ${res.status} for ${address}`);
      const s = (JSON.parse(res.body) as { chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number } }).chain_stats;
      const balance = round((s.funded_txo_sum - s.spent_txo_sum) / SATS);
      return { chain, address, kind: 'eoa', code: '0x', labels: [], txCount: s.tx_count, balances: balance > 0 ? [{ asset: 'BTC', amount: balance }] : [], snapshotId: res.snapshotId, sourceUrl: url };
    },
    async getTransfers(_chain, address, ctx): Promise<Transfer[]> {
      const { list, snapshotId } = await txs(address, ctx);
      return list.flatMap((t) => transfersFromTx(t, address)).map((t) => ({ ...t, snapshotId })).sort((a, b) => a.at.localeCompare(b.at));
    },
  };
}

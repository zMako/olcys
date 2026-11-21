import { classifyCode, type AccountInfo, type Chain, type ChainConnector, type Deployment, type LabelCategory, type Transfer } from '@olcys/core';

interface ApiAccount {
  address: string;
  chain: Chain;
  label: { name: string; category: LabelCategory } | null;
  code: string;
  txCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  balances: { asset: string; amount: number }[];
  /** Present for contracts whose creation the explorer indexed. */
  creator?: string;
  creationTx?: string;
  createdAt?: string;
}

/** Explorer of the synthetic environment ("BlokSkan"). Real explorers plug in through the same interface. */
export function createWorldChainConnector(base: string): ChainConnector {
  const root = base.replace(/\/+$/, '');
  return {
    id: 'world-explorer',
    descriptor: { name: 'BlokSkan (eksplorator, środowisko testowe)', chains: ['bitcoin', 'ethereum', 'tron'], hosts: [new URL(root).host], synthetic: true },
    supports: () => true,
    async getAccount(chain, address, ctx): Promise<AccountInfo> {
      const url = `${root}/api/v1/address/${encodeURIComponent(address)}`;
      const res = await ctx.fetch(url);
      if (res.status !== 200) throw new Error(`Explorer returned ${res.status} for ${address}`);
      const a = JSON.parse(res.body) as ApiAccount;
      const { kind, delegate } = classifyCode(a.code);
      return {
        chain,
        address: a.address,
        kind,
        code: a.code,
        delegate,
        labels: a.label ? [{ name: a.label.name, category: a.label.category, source: 'BlokSkan (etykieta API)' }] : [],
        txCount: a.txCount,
        firstSeenAt: a.firstSeen ?? undefined,
        lastSeenAt: a.lastSeen ?? undefined,
        balances: a.balances,
        snapshotId: res.snapshotId,
        sourceUrl: url,
      };
    },
    async getTransfers(chain, address, ctx): Promise<Transfer[]> {
      const res = await ctx.fetch(`${root}/api/v1/address/${encodeURIComponent(address)}/transfers`);
      if (res.status !== 200) throw new Error(`Explorer returned ${res.status} for ${address}`);
      const body = JSON.parse(res.body) as { transfers: Omit<Transfer, 'chain' | 'snapshotId'>[] };
      return body.transfers.map((t) => ({ ...t, chain, snapshotId: res.snapshotId }));
    },
    async getCreator(chain, contract, ctx): Promise<Deployment | undefined> {
      const url = `${root}/api/v1/address/${encodeURIComponent(contract)}`;
      const res = await ctx.fetch(url);
      if (res.status !== 200) return undefined;
      const a = JSON.parse(res.body) as ApiAccount;
      return a.creator ? { chain, contract: a.address, creator: a.creator, txHash: a.creationTx, at: a.createdAt, sourceUrl: url, snapshotId: res.snapshotId } : undefined;
    },
    async getDeployed(chain, address, ctx): Promise<Deployment[]> {
      const url = `${root}/api/v1/address/${encodeURIComponent(address)}/deployed`;
      const res = await ctx.fetch(url);
      if (res.status !== 200) return [];
      const body = JSON.parse(res.body) as { address: string; contracts: { address: string; txHash: string; at: string }[] };
      return body.contracts.map((c) => ({ chain, contract: c.address, creator: body.address, txHash: c.txHash, at: c.at, sourceUrl: url, snapshotId: res.snapshotId }));
    },
  };
}

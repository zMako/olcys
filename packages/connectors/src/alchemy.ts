import { parseAddress, type ConnectorContext, type Transfer } from '@olcys/core';

/**
 * Transfer history on the Base network, from Alchemy's transfers API. Base is where Coinbase's and Farcaster's
 * users do most of their business, and a deposit back to the exchange from there is a cash-out like any other.
 * The key travels in a header, which the evidence vault never stores.
 */
const CANONICAL: Record<string, string> = {
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 'USDC',
  '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA': 'USDC', // the bridged form of USDC on Base
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf': 'WBTC', // Coinbase's wrapped bitcoin: worth one bitcoin
};
const NETWORK_NAME: Record<string, string> = { 'base-mainnet': 'Base' };
const ADVERT = /visit|claim|reward|airdrop|voucher|bonus|https?|www|t\.me|\.(com|xyz|org|net|io|app|fi|pro|prot|site|top|vip|cc|me|co|gg|lol)\b|[^\x20-\x7e]/i;
const RESERVED = new Set(['USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'ETH', 'BTC']);

export interface AlchemyOptions {
  key: string;
  /** e.g. "base-mainnet" */
  network?: string;
  /** Pages of 1000 transfers read per direction. */
  maxPages?: number;
}

export function createAlchemyTransfers(opts: AlchemyOptions) {
  const url = `https://${opts.network ?? 'base-mainnet'}.g.alchemy.com/v2`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${opts.key}` };
  return {
    host: new URL(url).host,
    url,
    headers: { authorization: `Bearer ${opts.key}` },
    async transfers(address: string, ctx: ConnectorContext): Promise<Transfer[]> {
      const out: Transfer[] = [];
      for (const direction of ['fromAddress', 'toAddress'] as const) {
        let pageKey: string | undefined;
        for (let page = 0; page < (opts.maxPages ?? 2); page++) {
          const params = [{ fromBlock: '0x0', toBlock: 'latest', [direction]: address, category: ['external', 'erc20'], withMetadata: true, excludeZeroValue: true, maxCount: '0x3e8', order: 'desc', ...(pageKey ? { pageKey } : {}) }];
          let res;
          // "Slow down" is answered by waiting and asking again; a history silently cut short would be worse than a slow one.
          for (let attempt = 1; attempt <= 5; attempt++) {
            res = await ctx.fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: attempt, method: 'alchemy_getAssetTransfers', params }) });
            if (res.status !== 429 && res.status < 500) break;
            await new Promise((r) => setTimeout(r, 700 * 2 ** (attempt - 1)));
          }
          if (!res || res.status !== 200) throw new Error(`Base: historia adresu ${address} niedostępna (odpowiedź ${res?.status ?? 'brak'})`);
          const result = (JSON.parse(res.body) as { result?: { transfers?: Record<string, any>[]; pageKey?: string } }).result;
          for (const t of result?.transfers ?? []) {
            const [from, to] = [parseAddress(String(t.from ?? ''))?.address, parseAddress(String(t.to ?? ''))?.address];
            const at = t.metadata?.blockTimestamp;
            if (!from || !to || typeof at !== 'string' || typeof t.value !== 'number' || !(t.value > 0) || typeof t.hash !== 'string') continue;
            const contract = t.rawContract?.address ? parseAddress(String(t.rawContract.address))?.address : undefined;
            // Tokens whose "name" is an advertisement or a link are sent to everyone, and their contracts can name
            // any address as the sender, an exchange's included. They say nothing about the wallet and are left out.
            if (t.category === 'erc20' && ADVERT.test(String(t.asset ?? ''))) continue;
            let asset = 'ETH';
            if (t.category === 'erc20') {
              const symbol = String(t.asset ?? '').replace(/[^\p{L}\p{N}$._-]/gu, '').slice(0, 16).toUpperCase() || 'TOKEN';
              // A token is what its contract is, not what it calls itself.
              asset = (contract && CANONICAL[contract]) ?? (RESERVED.has(symbol) ? `${symbol} (inny kontrakt)` : symbol);
            }
            out.push({ chain: 'ethereum', txHash: t.hash, at: new Date(at).toISOString(), from, to, asset, amount: Math.round(t.value * 1e8) / 1e8, network: NETWORK_NAME[opts.network ?? 'base-mainnet'] ?? opts.network, snapshotId: res.snapshotId });
          }
          pageKey = result?.pageKey;
          if (!pageKey) break;
        }
      }
      return out;
    },
  };
}

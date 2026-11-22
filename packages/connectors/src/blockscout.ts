import { parseAddress, type AddressLabel, type ConnectorContext, type LabelCategory, type Transfer } from '@olcys/core';

/**
 * Transfer history and public labels for Ethereum, from an indexer with a Blockscout-style API.
 * A node knows balances and code but keeps no history by address; an indexer does. Its label service
 * says which addresses are exchanges, routers or bridges — without that, a transfer to "0x28C6…"
 * is just a transfer, and nobody can tell it went to an exchange.
 */

type Json = Record<string, any>;

/** The real contracts of the assets that matter for valuation. A token that merely calls itself "USDC" is not USDC. */
const CANONICAL: Record<string, string> = {
  '0xdAC17F958D2ee523a2206206994597C13D831ec7': 'USDT',
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 'USDC',
  '0x6B175474E89094C44Da98b954EedeAC495271d0F': 'DAI',
  '0xC02aaA39b223FE8D0A0e59C4F27eAD9083C756Cc2': 'WETH',
  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': 'WBTC',
};
const RESERVED = new Set([...Object.values(CANONICAL), 'ETH', 'BTC']);

/** The asset name of a token transfer: the symbol for known contracts, and a marked name for look-alikes. */
export function tokenAsset(contract: string | undefined, symbol: string | undefined): string {
  const address = contract ? parseAddress(contract)?.address : undefined;
  if (address && CANONICAL[address]) return CANONICAL[address];
  const clean = (symbol ?? '').replace(/[^\p{L}\p{N}$._-]/gu, '').slice(0, 16).toUpperCase() || 'TOKEN';
  return RESERVED.has(clean) ? `${clean} (inny kontrakt)` : clean;
}

const EXCHANGES = /^(binance|coinbase|kraken|okx|okex|bybit|kucoin|bitfinex|gate-?io|gate|crypto-com|huobi|htx|mexc|bitget|bitstamp|gemini|zonda|bitbay|kanga|upbit|bithumb|bitmart|poloniex|deribit|robinhood|revolut|bitpanda|whitebit|lbank|coinex)\b/;
const GENERIC: [RegExp, LabelCategory][] = [
  [/^(exchange|cex|centralized-exchange|hot-wallet|cold-wallet)$/, 'exchange'],
  [/^(dex|dex-aggregator|amm)$/, 'dex'],
  [/^(bridge|cross-chain-bridge)$/, 'bridge'],
  [/^(mixer|tornado-cash)$/, 'mixer'],
  [/^(token-contract|stablecoin|token)$/, 'token'],
  [/^(payment|payments|payment-gateway)$/, 'payment_gateway'],
];

/** Turns the label service's tags for one address into a label of ours, or nothing if the tags say nothing we use. */
/**
 * Whether a label carrying an exchange's name is the exchange itself (its hot or cold wallet, a deposit address),
 * and not one of its other products. Only the former knows a customer behind a transfer.
 */
export function holdsCustomerFunds(name: string): boolean {
  if (/\b(labs?|nft|fees?|router|bridge|swap|aggregator|dex|staking|earn|ventures|treasury|token|deployer|multisig|safe|web3|defi|paymaster|gas|protocol|pool|vault)\b/i.test(name)) return false;
  // "Bybit: Wallet 12" is one of the exchange's own wallets; "Bitget Wallet" is the name of its self-custody app.
  if (/\bwallet\b/i.test(name) && !/\b(hot|cold|deposit|withdrawal)\b/i.test(name) && !/:\s*wallet\b/i.test(name)) return false;
  return true;
}

export function labelFromTags(tags: Json[] | undefined, source: string): AddressLabel | undefined {
  if (!tags?.length) return undefined;
  const slug = (t: Json) => String(t.slug ?? '').toLowerCase();
  const names = tags.filter((t) => t.tagType === 'name').map((t) => String(t.name));
  const protocol = tags.find((t) => t.tagType === 'protocol');
  let category: LabelCategory | undefined;
  if (tags.some((t) => EXCHANGES.test(slug(t)) && (t.tagType === 'protocol' || t.tagType === 'name'))) category = 'exchange';
  for (const [pattern, c] of GENERIC) if (!category && tags.some((t) => t.tagType === 'generic' && pattern.test(slug(t)))) category = c;
  // A name with "Owner: Role" reads best ("Binance: Hot Wallet"); otherwise the first name, otherwise the protocol.
  const name = names.find((n) => n.includes(':')) ?? names[0] ?? (protocol ? String(protocol.name) : undefined);
  if (!name) return undefined;
  // An exchange's payment service for shops takes payments for goods; paying there is a purchase, not a deposit.
  if (category === 'exchange' && /\b(commerce|pay|payments?)\b/i.test(name)) category = 'payment_gateway';
  // An exchange's name is also on things that hold no customer account: its wallet app, its fee collector, its fund.
  if (category === 'exchange' && !holdsCustomerFunds(name)) category = 'other';
  return { name, category: category ?? 'other', source };
}

const eip55 = (a: unknown): string | undefined => (typeof a === 'string' ? parseAddress(a)?.address : undefined);
const iso = (t: unknown): string | undefined => (typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : undefined);

export interface BlockscoutOptions {
  /** Indexer, e.g. https://eth.blockscout.com */
  indexer: string;
  /** Label service; leave out to read labels only from what the indexer embeds in transactions. */
  labels?: string;
  chainId?: number;
  /** Pages (50 entries each) read per list. */
  maxPages?: number;
}

export function createBlockscout(opts: BlockscoutOptions) {
  const indexer = opts.indexer.replace(/\/+$/, '');
  const labelService = opts.labels?.replace(/\/+$/, '');
  const source = 'publiczne etykiety Blockscout';
  const known = new Map<string, AddressLabel[]>();
  const asked = new Set<string>();

  const remember = (party: Json | undefined) => {
    const address = eip55(party?.hash);
    if (!address || known.has(address)) return;
    const label = labelFromTags(party?.metadata?.tags, source);
    if (label) known.set(address, [label]);
  };

  /** One list of the indexer, following its paging. */
  async function* pages(ctx: ConnectorContext, url: string): AsyncGenerator<{ item: Json; snapshotId: string }> {
    let next = '';
    for (let page = 0; page < (opts.maxPages ?? 3); page++) {
      const res = await ctx.fetch(`${url}${next ? `${url.includes('?') ? '&' : '?'}${next}` : ''}`);
      if (res.status !== 200) return;
      const body = JSON.parse(res.body) as { items?: Json[]; next_page_params?: Json | null };
      for (const item of body.items ?? []) yield { item, snapshotId: res.snapshotId };
      if (!body.next_page_params) return;
      next = Object.entries(body.next_page_params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    }
  }

  return {
    hosts: [new URL(indexer).host, ...(labelService ? [new URL(labelService).host] : [])],

    /** Every movement of ether and tokens to or from the address that the indexer lists. */
    async transfers(address: string, ctx: ConnectorContext): Promise<Transfer[]> {
      const out: Transfer[] = [];
      const base = `${indexer}/api/v2/addresses/${address}`;
      const push = (t: Json, asset: string, raw: unknown, decimals: number, txHash: unknown, snapshotId: string) => {
        const [from, to, at] = [eip55(t.from?.hash), eip55(t.to?.hash), iso(t.timestamp)];
        const amount = Number(BigInt(String(raw ?? '0').replace(/\..*$/, '') || '0')) / 10 ** decimals;
        if (!from || !to || !at || typeof txHash !== 'string' || !(amount > 0)) return;
        remember(t.from);
        remember(t.to);
        out.push({ chain: 'ethereum', txHash, at, from, to, asset, amount: Math.round(amount * 1e8) / 1e8, snapshotId });
      };
      // Each of the three lists is read on its own: if one cannot be had (the indexer is slow on very busy addresses), the others still count.
      const read = async (url: string, each: (item: Json, snapshotId: string) => void) => {
        try {
          for await (const { item, snapshotId } of pages(ctx, url)) each(item, snapshotId);
        } catch (err) {
          ctx.log(`${url}: ${err instanceof Error ? err.message : err}`);
        }
      };
      // The three lists are independent, so they are read at the same time.
      await Promise.all([
      read(`${base}/transactions`, (item, snapshotId) => {
        if (item.status === 'ok') push(item, 'ETH', item.value, 18, item.hash, snapshotId);
      }),
      // ether that arrived or left through a contract call (a withdrawal, the output of a swap)
      read(`${base}/internal-transactions`, (item, snapshotId) => {
        if (item.success) push(item, 'ETH', item.value, 18, item.transaction_hash, snapshotId);
      }),
      read(`${base}/token-transfers?type=ERC-20`, (item, snapshotId) => {
        push(item, tokenAsset(item.token?.address_hash ?? item.token?.address, item.token?.symbol), item.total?.value, Number(item.total?.decimals ?? item.token?.decimals ?? 18), item.transaction_hash, snapshotId);
      }),
      ]);
      await this.labelMany([...new Set(out.flatMap((t) => [t.from, t.to]))].filter((a) => a !== address), ctx);
      return out.sort((a, b) => a.at.localeCompare(b.at));
    },

    /** Asks the label service about addresses not asked about yet, forty at a time. */
    async labelMany(addresses: string[], ctx: ConnectorContext): Promise<void> {
      if (!labelService) return;
      const todo = addresses.filter((a) => !asked.has(a));
      for (let i = 0; i < todo.length; i += 40) {
        const part = todo.slice(i, i + 40);
        // Whether an address is an exchange decides whether a transfer is a cash-out, so a failed answer is asked
        // again; if it still fails the addresses stay unasked and the gap is reported.
        let body: { addresses?: Record<string, { tags?: Json[] }> } | undefined;
        for (let attempt = 1; attempt <= 4 && !body; attempt++) {
          try {
            const res = await ctx.fetch(`${labelService}/api/v1/metadata?addresses=${part.join(',')}&chainId=${opts.chainId ?? 1}&tagsLimit=20`);
            if (res.status === 200) body = JSON.parse(res.body) as typeof body;
          } catch {
            // asked again below
          }
          if (!body) await new Promise((r) => setTimeout(r, 400 * attempt));
        }
        if (!body) {
          ctx.log(`etykiety ${part.length} adresów (sieć ${opts.chainId ?? 1}): usługa etykiet nie odpowiedziała`);
          continue;
        }
        part.forEach((a) => asked.add(a));
        for (const [raw, v] of Object.entries(body.addresses ?? {})) {
          const address = eip55(raw);
          const label = labelFromTags(v.tags, source);
          if (address && label) known.set(address, [label]);
        }
      }
    },

    async labelsOf(address: string, ctx: ConnectorContext): Promise<AddressLabel[]> {
      if (!known.has(address)) await this.labelMany([address], ctx);
      return known.get(address) ?? [];
    },
  };
}

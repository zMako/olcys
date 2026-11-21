import type { Chain } from './chains';

export type LabelCategory =
  | 'exchange' | 'exchange_deposit' | 'p2p' | 'payment_gateway' | 'card' | 'otc'
  | 'dex' | 'token' | 'contract' | 'mixer' | 'charity' | 'bridge' | 'other';

export interface AddressLabel {
  name: string;
  category: LabelCategory;
  /** Where the label comes from: the bundled list or an explorer API. */
  source: string;
}

export interface LabelEntry extends AddressLabel {
  address: string;
  chain: Chain;
}

/** Services through which crypto leaves to traditional currency. */
export const CASH_OUT_CATEGORIES: LabelCategory[] = ['exchange', 'exchange_deposit', 'p2p', 'payment_gateway', 'card', 'otc'];

const SRC = 'lista wbudowana OŁCyŚ v1';

/**
 * Bundled list of publicly labelled mainnet addresses. It works offline and is the
 * first line of the false-positive filter; explorer tags are the second.
 * The order is part of the public contract of this list (tests refer to entries by index).
 */
export const BUNDLED_LABELS: LabelEntry[] = [
  { address: '0x28C6c06298d514Db089934071355E5743bf21d60', chain: 'ethereum', name: 'Binance: Hot Wallet 14', category: 'exchange', source: SRC },
  { address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', chain: 'bitcoin', name: 'Binance: Cold Wallet', category: 'exchange', source: SRC },
  { address: '0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2', chain: 'ethereum', name: 'Kraken', category: 'exchange', source: SRC },
  { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chain: 'ethereum', name: 'Tether USD (USDT) — kontrakt tokena', category: 'token', source: SRC },
  { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chain: 'ethereum', name: 'USD Coin (USDC) — kontrakt tokena', category: 'token', source: SRC },
  { address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', chain: 'ethereum', name: 'Uniswap V2: Router 2', category: 'dex', source: SRC },
  { address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', chain: 'tron', name: 'Tether USD (TRC-20) — kontrakt tokena', category: 'token', source: SRC },
  { address: '0x165CD37b4C644C2921454429E7F9358d18A45e14', chain: 'ethereum', name: 'Ukraine Crypto Donation', category: 'charity', source: SRC },
  { address: '0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b', chain: 'ethereum', name: 'Tornado.Cash: Router', category: 'mixer', source: SRC },
];

const byAddress = new Map(BUNDLED_LABELS.map((l) => [`${l.chain}:${l.address}`, l]));

export function bundledLabel(chain: string, address: string): AddressLabel | undefined {
  const l = byAddress.get(`${chain}:${address}`);
  return l && { name: l.name, category: l.category, source: l.source };
}

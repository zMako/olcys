/**
 * Words that mark a site or a page as being about cryptocurrencies, in Polish and English.
 * They are matched against host names and URL paths only — nothing is downloaded to apply them.
 * Long words match anywhere in a token ("kryptowaluty"); short ones only as a whole token,
 * so that "eth" does not match "method".
 */
export const LONG_KEYWORDS = [
  'krypto', 'crypto', 'kripto', 'bitcoin', 'ethereum', 'blockchain', 'altcoin', 'litecoin', 'dogecoin', 'monero', 'tether', 'stablecoin',
  'wallet', 'portfel', 'kantor', 'gielda', 'kopalnia', 'kopanie', 'koparki', 'mining', 'miner', 'satoshi', 'airdrop', 'faucet', 'staking',
  'binance', 'coinbase', 'kraken', 'bitbay', 'zonda', 'ledger', 'trezor', 'metamask', 'uniswap', 'token', 'waluty', 'coin',
];
export const SHORT_KEYWORDS = ['btc', 'eth', 'xmr', 'ltc', 'usdt', 'usdc', 'nft', 'defi', 'dex', 'p2p', 'ico', 'hodl', 'tron', 'trx', 'dao', 'otc'];

/**
 * Keywords that almost always mean cryptocurrencies. The others ("portfel", "kantor", "token") also name leather
 * wallets, currency exchange offices and software tokens, so on their own they do not make a page a seed.
 */
export const STRONG_KEYWORDS = new Set([
  'krypto', 'crypto', 'kripto', 'bitcoin', 'ethereum', 'blockchain', 'altcoin', 'litecoin', 'dogecoin', 'monero', 'stablecoin', 'satoshi', 'airdrop',
  'faucet', 'staking', 'binance', 'coinbase', 'bitbay', 'zonda', 'metamask', 'uniswap', 'trezor', 'btc', 'xmr', 'usdt', 'usdc', 'nft', 'defi', 'hodl',
]);

const SHORT = new Set(SHORT_KEYWORDS);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter(Boolean);

/** Crypto keywords present in a host name or a URL path. */
export function keywordsIn(text: string): string[] {
  const found = new Set<string>();
  for (const t of tokens(text)) {
    if (SHORT.has(t)) found.add(t);
    for (const k of LONG_KEYWORDS) if (t.includes(k)) found.add(k);
  }
  return [...found];
}

/** "pl,bitcoin,forum)/watek/1" → { host: "forum.bitcoin.pl", path: "/watek/1" } (the key format of the crawl index). */
export function parseSurt(surt: string): { host: string; path: string } | undefined {
  const close = surt.indexOf(')');
  if (close < 0) return undefined;
  const labels = surt.slice(0, close).split(':')[0].split(',');
  if (labels.length < 2 || labels.some((l) => !l)) return undefined;
  return { host: labels.reverse().join('.').replace(/^www\./, ''), path: surt.slice(close + 1) || '/' };
}

/** The index key prefix under which every page of a top-level domain sits, e.g. "pl". */
export const tldOf = (surt: string): string => surt.slice(0, surt.search(/[,)]/));

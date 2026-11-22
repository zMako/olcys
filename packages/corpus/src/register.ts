import { existsSync } from 'node:fs';
import { holdsCustomerFunds } from '@olcys/connectors';
import { readAttestations } from './attestations';
import { readFarcasterRecords } from './farcaster';
import { readBabt } from './babt';
import { readFlows, type WalletFlows } from './flows';
import { readPoapHolders } from './poap';

const VALUED = new Set(['USDC', 'USDT', 'DAI', 'ETH', 'WETH', 'WBTC']);
const STABLE = new Set(['USDC', 'USDT', 'DAI']);
const owner = (label: string) => label.split(':')[0].replace(/\s+(deposit|hot wallet|cold wallet|exchange|\d+)$/i, '').replace(/\s+\d+$/, '').trim();

/** One wallet's deposits to exchanges, counting only assets that have a price and labels that are the exchange itself. */
export function cashOuts(f: WalletFlows): { exchange: string; rule: string; depositAddress: string; deposits: WalletFlows['offRamps'][number]['deposits'] }[] {
  return f.offRamps
    .filter((o) => holdsCustomerFunds(o.exchange))
    .map((o) => ({ exchange: owner(o.exchange), rule: o.rule, depositAddress: o.depositAddress, deposits: o.deposits.filter((d) => VALUED.has(d.asset)) }))
    .filter((o) => o.deposits.length);
}

export interface RegisterStats {
  /** Wallets an exchange attests as belonging to a customer verified in Poland. */
  attestedWallets: number;
  /** Public accounts recognised as Polish, and how many of them state a wallet. */
  accounts: number;
  accountsWithWallet: number;
  /** Every distinct wallet of the two layers together, and wallets present in both. */
  wallets: number;
  inBothLayers: number;
  /** Wallets of the register that also hold Binance's token for customers who passed its identity check. */
  binanceVerified: number;
  /** Wallets that two exchanges vouch for: Coinbase (verified in Poland) and Binance. */
  twoExchanges: number;
  /** Wallets that received attendance tokens at in-person events in Poland: all, and those seen on two or more days. */
  eventWallets: number;
  eventWalletsRepeat: number;
  flows?: {
    scanned: number;
    active: number;
    /** Wallets that sent priced assets to an exchange (directly or through a recognised deposit address). */
    cashedOut: number;
    cashedOutAttested: number;
    cashedOutAccounts: number;
    deposits: number;
    stablecoins: number;
    ether: number;
    /** Exchanges by the number of wallets that paid into them. */
    exchanges: { name: string; wallets: number }[];
    byRule: Record<string, number>;
  };
}

/** Counts over the locally built register. Aggregates only: no address or account leaves this function. */
export function registerStats(root: string): RegisterStats {
  const attested = new Set(readAttestations(root).map((a) => a.wallet));
  const polish = existsSync(`${root}/farcaster/profiles.jsonl`) ? readFarcasterRecords(`${root}/farcaster`).filter((r) => r.polish.score >= 0.5) : [];
  const accountOf = new Map<string, number>();
  for (const r of polish) for (const w of r.wallets) accountOf.set(w, r.fid);
  const all = new Set([...attested, ...accountOf.keys()]);
  const stats: RegisterStats = {
    attestedWallets: attested.size, accounts: polish.length, accountsWithWallet: polish.filter((r) => r.wallets.length).length,
    wallets: all.size, inBothLayers: [...accountOf.keys()].filter((w) => attested.has(w)).length,
    binanceVerified: 0, twoExchanges: 0, eventWallets: 0, eventWalletsRepeat: 0,
  };
  const binance = new Set(readBabt(root).filter((b) => b.holds).map((b) => b.wallet));
  stats.binanceVerified = [...binance].filter((w) => all.has(w)).length;
  stats.twoExchanges = [...binance].filter((w) => attested.has(w)).length;
  const days = new Map<string, Set<string>>();
  for (const h of readPoapHolders(root)) if (!h.virtual) days.set(h.wallet, (days.get(h.wallet) ?? new Set()).add((h.date ?? String(h.dropId)).slice(0, 10)));
  stats.eventWallets = days.size;
  stats.eventWalletsRepeat = [...days.values()].filter((d) => d.size >= 2).length;
  const flows = readFlows(root);
  if (!flows.length) return stats;
  const out = flows.map((f) => ({ f, ramps: cashOuts(f) })).filter((x) => x.ramps.length);
  const exchanges = new Map<string, Set<string>>();
  const byRule: Record<string, number> = {};
  let deposits = 0;
  let stablecoins = 0;
  let ether = 0;
  for (const { f, ramps } of out) {
    for (const r of ramps) {
      exchanges.set(r.exchange, (exchanges.get(r.exchange) ?? new Set()).add(f.wallet));
      byRule[r.rule] = (byRule[r.rule] ?? 0) + 1;
      deposits += r.deposits.length;
      for (const d of r.deposits) {
        if (STABLE.has(d.asset)) stablecoins += d.amount;
        else if (d.asset === 'ETH' || d.asset === 'WETH') ether += d.amount;
      }
    }
  }
  stats.flows = {
    scanned: flows.length, active: flows.filter((f) => f.transfers).length, cashedOut: out.length,
    cashedOutAttested: out.filter((x) => attested.has(x.f.wallet)).length,
    cashedOutAccounts: new Set(out.map((x) => accountOf.get(x.f.wallet)).filter((x) => x !== undefined)).size,
    deposits, stablecoins: Math.round(stablecoins), ether: Math.round(ether * 100) / 100,
    exchanges: [...exchanges].map(([name, w]) => ({ name, wallets: w.size })).sort((a, b) => b.wallets - a.wallets).slice(0, 12), byRule,
  };
  return stats;
}

export interface RegisterRow {
  wallet: string;
  /** The public account that claims the wallet, if one was found. */
  account?: { service: string; handle: string; displayName?: string; location?: string };
  /** An exchange attests the wallet as belonging to a customer verified in Poland. */
  attested: boolean;
  /** The wallet holds Binance's token for verified customers. */
  binance: boolean;
  /** Transfers found on Base; undefined when the wallet's history was not read. */
  transfers?: number;
  exchanges: string[];
  deposits: number;
  stablecoins: number;
  ether: number;
  firstAt?: string;
  lastAt?: string;
}

/**
 * Every wallet of the register, the most telling first: wallets that sent priced assets to an exchange by the
 * size of what they sent, then the rest by how much is known about them (a public account, attestations, activity).
 * The order uses a rough worth (stablecoins at 1, ether at a fixed round figure) only to sort; the columns show the amounts themselves.
 */
export function registerRows(root: string): RegisterRow[] {
  const attested = new Set(readAttestations(root).map((a) => a.wallet));
  const accountOf = new Map<string, RegisterRow['account']>();
  if (existsSync(`${root}/farcaster/profiles.jsonl`)) {
    for (const r of readFarcasterRecords(`${root}/farcaster`)) {
      if (r.polish.score < 0.5) continue;
      for (const w of r.wallets) accountOf.set(w, { service: 'Farcaster', handle: r.username ?? String(r.fid), displayName: r.displayName, location: r.location });
    }
  }
  const binance = new Set(readBabt(root).filter((b) => b.holds).map((b) => b.wallet));
  const flows = new Map(readFlows(root).map((f) => [f.wallet, f]));
  const rows: (RegisterRow & { worth: number; known: number })[] = [];
  for (const wallet of new Set([...attested, ...accountOf.keys()])) {
    const f = flows.get(wallet);
    const all = (f ? cashOuts(f) : []).flatMap((r) => r.deposits).sort((a, b) => a.at.localeCompare(b.at));
    const stablecoins = all.filter((d) => STABLE.has(d.asset)).reduce((n, d) => n + d.amount, 0);
    const ether = all.filter((d) => d.asset === 'ETH' || d.asset === 'WETH').reduce((n, d) => n + d.amount, 0);
    const account = accountOf.get(wallet);
    rows.push({
      wallet, account, attested: attested.has(wallet), binance: binance.has(wallet), transfers: f?.transfers,
      exchanges: f ? [...new Set(cashOuts(f).map((r) => r.exchange))] : [], deposits: all.length,
      stablecoins: Math.round(stablecoins * 100) / 100, ether: Math.round(ether * 10000) / 10000, firstAt: all[0]?.at ?? f?.firstAt, lastAt: all[all.length - 1]?.at ?? f?.lastAt,
      worth: stablecoins + ether * 3000,
      known: (account ? 4 : 0) + (attested.has(wallet) ? 2 : 0) + (binance.has(wallet) ? 1 : 0),
    });
  }
  return rows
    .sort((a, b) => b.worth - a.worth || b.known - a.known || (b.transfers ?? 0) - (a.transfers ?? 0) || a.wallet.localeCompare(b.wallet))
    .map(({ worth: _worth, known: _known, ...row }) => row);
}

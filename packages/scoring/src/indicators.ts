import type { AddressLabel, LabelCategory, Transfer } from '@olcys/core';
import { DEFAULT_RULESET, type Ruleset } from './ruleset';

export interface Amount {
  asset: string;
  amount: number;
}

export interface ActivitySummary {
  transfers: number;
  /** Movements between the wallet's own addresses; not counted as received or sent. */
  internal: number;
  firstAt?: string;
  lastAt?: string;
  received: Amount[];
  sent: Amount[];
}

/** How an address came to be treated as part of the wallet. */
export interface WalletMember {
  address: string;
  /** Absent for the address found in open sources; otherwise the transaction that ties it to another member. */
  via?: { txHash: string; with: string };
  /**
   * W1 (default): spent together with another member in one transaction.
   * D2: paid into the same personal exchange deposit address (`via.with`) as another member.
   */
  rule?: 'W1' | 'D2';
}

export type IndicatorType = 'exchange' | 'p2p' | 'payment_gateway' | 'card' | 'otc' | 'stablecoin_swap' | 'mixer' | 'exchange_inflow' | 'sanctioned' | 'reported';

/**
 * How likely the transfers are a disposal of crypto for traditional currency, goods or services:
 *  - probable: the service exists to do exactly that (card, payment gateway, OTC desk, P2P escrow);
 *  - possible: funds reached an exchange, where they may have been sold, held or swapped.
 */
export type Certainty = 'probable' | 'possible';

export interface Indicator {
  type: IndicatorType;
  rule: string;
  title: string;
  summary: string;
  /** True when the pattern may mean crypto was converted to traditional currency. */
  cashOut: boolean;
  /** Set for patterns that enter the PLN estimate; a swap between crypto assets is not a disposal and has none. */
  certainty?: Certainty;
  /** True when the service was recognised from the flow of funds rather than from a label. */
  inferred?: boolean;
  count: number;
  totals: Amount[];
  counterparties: { address: string; name?: string; category?: string }[];
  firstAt: string;
  lastAt: string;
  transfers: Transfer[];
}

/** The point where funds reached an exchange: the entity that knows who the customer is. */
export interface OffRamp {
  exchange: string;
  chain: string;
  /** The network built on top of the chain where the deposits were made, if not the main one. */
  network?: string;
  depositAddress: string;
  /** L1 = the deposit address is labelled; D1 = recognised because everything it received was swept to the exchange. */
  rule: 'L1' | 'D1';
  detail: string;
  /**
   * An entity of this name in the Polish register of virtual-currency businesses (kept by the tax administration):
   * a domestic party the request can be addressed to. A match of names only; NIP and KRS identify the business.
   */
  registered?: { number: string; name: string; nip: string; krs?: string; entered: string; struckOff: boolean; suspendedFrom?: string; matched: string; edition: string; status: string };
  deposits: Transfer[];
  sweeps: Transfer[];
}

const OUTGOING: Partial<Record<LabelCategory, { type: IndicatorType; rule: string; title: string; what: string; certainty?: Certainty }>> = {
  exchange: { type: 'exchange', rule: 'W1', title: 'Wpłaty na giełdę', what: 'na adresy giełdy', certainty: 'possible' },
  exchange_deposit: { type: 'exchange', rule: 'W1', title: 'Wpłaty na giełdę', what: 'na adresy giełdy', certainty: 'possible' },
  p2p: { type: 'p2p', rule: 'W2', title: 'Usługa wymiany P2P', what: 'do usługi P2P', certainty: 'probable' },
  payment_gateway: { type: 'payment_gateway', rule: 'W3', title: 'Bramka płatnicza', what: 'do bramki płatniczej', certainty: 'probable' },
  card: { type: 'card', rule: 'W4', title: 'Karta krypto-fiat', what: 'na doładowanie karty płatniczej', certainty: 'probable' },
  otc: { type: 'otc', rule: 'W5', title: 'Kantor / OTC', what: 'do kantoru kryptowalut', certainty: 'probable' },
  mixer: { type: 'mixer', rule: 'W7', title: 'Mikser', what: 'do miksera' },
};

const round = (n: number) => Math.round(n * 1e8) / 1e8;
export const formatAmount = (n: number) => n.toLocaleString('pl-PL', { maximumFractionDigits: 8 });
const amounts = (m: Map<string, number>): Amount[] => [...m].map(([asset, amount]) => ({ asset, amount: round(amount) })).sort((a, b) => a.asset.localeCompare(b.asset));
const sumBy = (ts: { asset: string; amount: number }[]) => {
  const m = new Map<string, number>();
  for (const t of ts) m.set(t.asset, (m.get(t.asset) ?? 0) + t.amount);
  return amounts(m);
};
const total = (ts: Transfer[]) => ts.reduce((n, t) => n + t.amount, 0);
const list = (a: Amount[]) => a.map((x) => `${formatAmount(x.amount)} ${x.asset}`).join(' + ');
const span = (ts: Transfer[]) => {
  const [first, last] = [ts[0].at.slice(0, 10), ts[ts.length - 1].at.slice(0, 10)];
  return first === last ? first : `${first} – ${last}`;
};
/** A Bitcoin payment funded from several addresses is one transaction, not several. */
const txCount = (ts: Transfer[]) => new Set(ts.map((t) => t.txHash)).size;
const times = (n: number) => (n === 1 ? '1 przelew' : n < 5 ? `${n} przelewy` : `${n} przelewów`);
/** The owner of a labelled address without the role of that address: "Binance: Hot Wallet", "Bitget 3", "ByBit Deposit" → the exchange. */
const SPELLING: Record<string, string> = { bybit: 'Bybit', okx: 'OKX', mexc: 'MEXC', kucoin: 'KuCoin', htx: 'HTX', bitget: 'Bitget', binance: 'Binance', coinbase: 'Coinbase', kraken: 'Kraken' };
const head = (name: string) => {
  const owner = name.split(':')[0].replace(/\s+(deposit|hot wallet|cold wallet|wallet|exchange|\d+)$/i, '').replace(/\s+\d+$/, '').trim();
  // label sources spell the same exchange differently ("ByBit", "Bybit")
  return SPELLING[owner.toLowerCase()] ?? owner;
};
const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;

export interface ActivityInput {
  /** The wallet: the address found in open sources plus any addresses tied to it on chain. */
  addresses: string[];
  /** Other addresses known to belong to the same person; transfers to and from them are internal. */
  related?: string[];
  transfers: Transfer[];
  labelsOf: (address: string) => AddressLabel[];
  /** Transfers of unlabelled addresses the wallet paid, used to see where the money went next. */
  hops?: Map<string, Transfer[]>;
  ruleset?: Ruleset;
}

/**
 * On-chain picture of one wallet and the patterns that may indicate leaving crypto for traditional currency:
 * transfers to exchanges, P2P services, payment gateways, crypto cards and OTC desks, and swaps of
 * significant value into stablecoins. Also finds the exchange behind an unlabelled deposit address.
 */
export function analyzeActivity(input: ActivityInput): { activity: ActivitySummary; indicators: Indicator[]; offRamps: OffRamp[] } {
  const ruleset = input.ruleset ?? DEFAULT_RULESET;
  const wallet = new Set([...input.addresses, ...(input.related ?? [])]);
  const core = new Set(input.addresses);
  const seen = new Set<string>();
  const sorted = [...input.transfers]
    // Only movements that touch this wallet itself; a related address's other business is analysed with that address.
    .filter((t) => core.has(t.from) || core.has(t.to))
    .filter((t) => {
      const key = `${t.txHash}|${t.from}|${t.to}|${t.asset}|${t.amount}`;
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  const internal = sorted.filter((t) => wallet.has(t.from) && wallet.has(t.to));
  const incoming = sorted.filter((t) => wallet.has(t.to) && !wallet.has(t.from));
  const outgoing = sorted.filter((t) => wallet.has(t.from) && !wallet.has(t.to));
  const activity: ActivitySummary = {
    transfers: sorted.length,
    internal: internal.length,
    firstAt: sorted[0]?.at,
    lastAt: sorted[sorted.length - 1]?.at,
    received: sumBy(incoming),
    sent: sumBy(outgoing),
  };

  // D1: an unlabelled address that passes on (nearly) everything it receives to an exchange's wallet is
  // that exchange's deposit address for one customer.
  const inferred = new Map<string, { label: AddressLabel; sweeps: Transfer[]; share: number; assets: Set<string> }>();
  for (const x of new Set(outgoing.map((t) => t.to))) {
    const hop = input.hops?.get(x);
    if (!hop || input.labelsOf(x).length) continue;
    // Counted asset by asset, and only in the assets the wallet itself sent there: amounts of different assets do
    // not add up, worthless tokens are dropped on every address of some networks, and the history of one asset may
    // be unavailable. The address counts as a deposit address for the assets it passed on, and only for those.
    const sent = new Set(outgoing.filter((t) => t.to === x).map((t) => t.asset));
    const toExchange = hop.filter((t) => t.from === x && sent.has(t.asset) && input.labelsOf(t.to).some((l) => l.category === 'exchange'));
    const passed = [...sent].map((asset) => {
      const received = total(hop.filter((t) => t.to === x && t.asset === asset));
      return { asset, share: received > 0 ? total(toExchange.filter((t) => t.asset === asset)) / received : 0 };
    }).filter((a) => a.share >= ruleset.offRamp.minForwardShare);
    const assets = new Set(passed.map((a) => a.asset));
    const sweeps = toExchange.filter((t) => assets.has(t.asset));
    if (!sweeps.length) continue;
    const exchange = head(input.labelsOf(sweeps[0].to).find((l) => l.category === 'exchange')!.name);
    inferred.set(x, {
      label: { name: `${exchange}: adres depozytowy`, category: 'exchange_deposit', source: 'reguła D1 (przepływ środków)' },
      sweeps,
      share: Math.min(...passed.map((a) => a.share)),
      assets,
    });
  }
  // What a transfer's other side is. A recognised deposit address is one only for the assets it passed on to the exchange.
  const depositOf = (t: Transfer) => (inferred.get(t.to)?.assets.has(t.asset) ? inferred.get(t.to) : undefined);
  const labelsTo = (t: Transfer): AddressLabel[] => (inferred.has(t.to) ? (depositOf(t) ? [depositOf(t)!.label] : []) : input.labelsOf(t.to));
  const labels = (a: string): AddressLabel[] => (inferred.has(a) ? [inferred.get(a)!.label] : input.labelsOf(a));

  const indicators: Indicator[] = [];
  const make = (
    def: { type: IndicatorType; rule: string; title: string; certainty?: Certainty },
    cashOut: boolean,
    ts: Transfer[],
    summary: string,
    parties: string[],
  ) => {
    indicators.push({
      type: def.type, rule: def.rule, title: def.title, summary, cashOut, certainty: def.certainty,
      inferred: parties.some((a) => inferred.has(a)) || undefined,
      count: txCount(ts), totals: sumBy(ts),
      counterparties: [...new Set(parties)].map((a) => ({ address: a, name: labels(a)[0]?.name, category: labels(a)[0]?.category })),
      firstAt: ts[0].at, lastAt: ts[ts.length - 1].at, transfers: ts,
    });
  };

  // Outgoing transfers to labelled services, grouped by kind of service.
  const groups = new Map<IndicatorType, { def: NonNullable<(typeof OUTGOING)[LabelCategory]>; ts: Transfer[] }>();
  for (const t of outgoing) {
    const label = labelsTo(t).find((l) => OUTGOING[l.category]);
    if (!label) continue;
    const def = OUTGOING[label.category]!;
    const g = groups.get(def.type) ?? { def, ts: [] };
    g.ts.push(t);
    groups.set(def.type, g);
  }
  for (const { def, ts } of groups.values()) {
    const names = [...new Set(ts.map((t) => labelsTo(t)[0].name))];
    const how = ts.some((t) => inferred.has(t.to)) ? ' Adres depozytowy rozpoznano po tym, że wpłaty zostały z niego przekazane na portfel giełdy.' : '';
    make(def, def.type !== 'mixer', ts, `${times(txCount(ts))} ${def.what} (${names.join(', ')}), łącznie ${list(sumBy(ts))}, ${span(ts)}.${how}`, ts.map((t) => t.to));
  }

  // Swaps into stablecoins: within one transaction the wallet gives one asset and receives a stablecoin.
  const stable = new Set(ruleset.indicators.stablecoins);
  const byTx = new Map<string, Transfer[]>();
  for (const t of sorted) byTx.set(t.txHash, [...(byTx.get(t.txHash) ?? []), t]);
  const swaps: Transfer[] = [];
  const swapParties: string[] = [];
  const given: Transfer[] = [];
  for (const legs of byTx.values()) {
    // Giving back a deposit receipt for a stablecoin (cUSDCv3, aUSDC…) is a withdrawal of that stablecoin, not a swap into it.
    const out = legs.filter((l) => wallet.has(l.from) && !stable.has(l.asset) && ![...stable].some((x) => l.asset.toUpperCase().includes(x)));
    const got = legs.filter((l) => wallet.has(l.to) && stable.has(l.asset));
    const value = got.reduce((n, l) => n + l.amount, 0);
    if (out.length && value >= ruleset.indicators.significantStablecoinSwap) {
      swaps.push(...got);
      given.push(...out);
      swapParties.push(...out.map((l) => l.to));
    }
  }
  if (swaps.length) {
    make({ type: 'stablecoin_swap', rule: 'W6', title: 'Wymiana na stablecoiny' }, true, swaps,
      `${txCount(swaps) === 1 ? '1 wymiana' : `${txCount(swaps)} wymiany`} ${list(sumBy(given))} na ${list(sumBy(swaps))} (każda powyżej progu ${formatAmount(ruleset.indicators.significantStablecoinSwap)}), ${span(swaps)}. Sama wymiana między kryptowalutami nie jest zbyciem, ale często poprzedza wypłatę.`,
      swapParties);
  }

  // Money arriving from an exchange: not a cash-out, but shows where the person buys.
  const fromExchange = incoming.filter((t) => labels(t.from).some((l) => l.category === 'exchange' || l.category === 'exchange_deposit'));
  if (fromExchange.length) {
    make({ type: 'exchange_inflow', rule: 'W8', title: 'Wypłaty z giełdy' }, false, fromExchange, `${times(txCount(fromExchange))} z giełdy, łącznie ${list(sumBy(fromExchange))}, ${span(fromExchange)}.`, fromExchange.map((t) => t.from));
  }
  // Counterparties on a sanctions list or publicly reported for fraud, in either direction. Not a cash-out: a flag.
  for (const [category, def, what] of [
    ['sanctioned', { type: 'sanctioned', rule: 'Z1', title: 'Kontrahent na liście sankcyjnej' }, 'z adresami z listy sankcyjnej'],
    ['reported', { type: 'reported', rule: 'Z2', title: 'Kontrahent zgłoszony jako oszustwo' }, 'z adresami publicznie zgłoszonymi jako oszustwo (zgłoszenie jest twierdzeniem zgłaszającego, nie ustaleniem)'],
  ] as const) {
    const other = (t: Transfer) => (wallet.has(t.from) ? t.to : t.from);
    const ts = [...outgoing, ...incoming].filter((t) => labels(other(t)).some((l) => l.category === category)).sort((a, b) => a.at.localeCompare(b.at));
    if (ts.length) make(def, false, ts, `${times(txCount(ts))} ${what}: ${[...new Set(ts.map((t) => labels(other(t))[0].name))].join(', ')}; łącznie ${list(sumBy(ts))}, ${span(ts)}.`, ts.map(other));
  }

  indicators.sort((a, b) => a.rule.localeCompare(b.rule));

  // Every exchange address the wallet paid into: the exchange is the party that holds the customer's identity.
  const offRamps: OffRamp[] = [];
  for (const x of new Set(outgoing.map((t) => t.to))) {
    const label = labels(x).find((l) => l.category === 'exchange' || l.category === 'exchange_deposit');
    if (!label) continue;
    const inf = inferred.get(x);
    const deposits = outgoing.filter((t) => t.to === x && (!inf || inf.assets.has(t.asset)));
    if (!deposits.length) continue;
    offRamps.push({
      exchange: head(label.name),
      chain: deposits[0].chain,
      network: deposits[0].network,
      depositAddress: x,
      rule: inf ? 'D1' : 'L1',
      detail: inf
        ? `Adres ${short(x)} nie ma etykiety, ale ${Math.min(100, Math.round(inf.share * 100))}% otrzymanych środków przekazał na oznaczony portfel giełdy ${head(label.name)}. Tak działa adres depozytowy przypisany jednemu klientowi.`
        : `Adres ${short(x)} jest oznaczony jako „${label.name}” (${label.source}).`,
      deposits,
      sweeps: inf?.sweeps ?? [],
    });
  }
  offRamps.sort((a, b) => a.exchange.localeCompare(b.exchange) || a.depositAddress.localeCompare(b.depositAddress));

  return { activity, indicators, offRamps };
}

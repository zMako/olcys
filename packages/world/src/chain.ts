import { BUNDLED_LABELS, sha256Hex, type Chain, type LabelCategory } from '@olcys/core';
import type { ChainEntity, LedgerTx, Persona, World, WorldChain } from './model';
import { priceUsd, usdPlnBefore } from './fixtures';
import { Rng } from './rng';
import { makeWallet, type WalletKind } from './wallet';

/** Address of the contract the scripted subject deployed from an address he never published. */
export const skarbonkaAddress = (seed: string) => makeWallet(`${seed}|contract`, 'eth', 'skarbonka').address;

const NATIVE: Record<Chain, string> = { bitcoin: 'BTC', ethereum: 'ETH', tron: 'TRX' };
const round = (n: number) => Math.round(n * 1e8) / 1e8;

/**
 * Builds the synthetic ledger: who paid whom, when and in what.
 * Counterparties are fictional services (an exchange, a P2P escrow, a card provider,
 * a payment gateway, an OTC desk) plus the real public contracts from the bundled list.
 */
export function generateChain(world: Pick<World, 'personas' | 'seed' | 'now'>, heroId: string): WorldChain {
  const seed = world.seed;
  const rng = new Rng(`${seed}|chain`);
  const now = Date.parse(world.now);
  const chain: WorldChain = { entities: [], txs: [], codes: {}, expected: [], wallets: [], names: [], deployments: [] };

  let extCounter = 0;
  /** A fresh outside address nobody in the world knows anything about. */
  const ext = (kind: WalletKind) => makeWallet(`${seed}|ext`, kind, String(extCounter++)).address;
  const kindOf = (c: Chain): WalletKind => (c === 'bitcoin' ? 'btc-segwit' : c === 'ethereum' ? 'eth' : 'tron');

  const service = (name: string, category: LabelCategory, c: Chain): string => {
    const w = makeWallet(`${seed}|service`, kindOf(c), `${name}|${c}`);
    chain.entities.push({ address: w.address, chain: c, name, category, synthetic: true });
    return w.address;
  };

  const tx = (c: Chain, at: string, legs: LedgerTx['legs']) => {
    const clean = legs.map((l) => ({ ...l, amount: round(l.amount) }));
    const hash = (c === 'ethereum' ? '0x' : '') + sha256Hex(JSON.stringify([c, at, clean, chain.txs.length]));
    chain.txs.push({ hash, chain: c, at, legs: clean });
  };
  const pay = (c: Chain, at: string, from: string, to: string, amount: number, asset = NATIVE[c]) => tx(c, at, [{ from, to, asset, amount }]);
  const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
  const ago = (minDays: number, maxDays: number) => new Date(now - rng.int(minDays * 24, maxDays * 24) * 3_600_000).toISOString();
  const warsawDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' });
  /** The same day in Poland, at an hour when the subject is awake: his transfers follow his daily rhythm. */
  const daytime = (iso: string) => {
    const d = new Date(iso);
    return `${warsawDay.format(d)}T${String(8 + ((d.getUTCHours() * 60 + d.getUTCMinutes()) % 12)).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:00.000Z`;
  };

  // Real public institutions and contracts: labelled, contracts carry bytecode.
  for (const l of BUNDLED_LABELS) {
    chain.entities.push({ address: l.address, chain: l.chain, name: l.name, category: l.category, synthetic: false });
    if (['token', 'dex', 'mixer', 'contract'].includes(l.category)) chain.codes[l.address] = '0x608060405234801561001057600080fd5b50' + sha256Hex(l.address).slice(0, 40);
  }
  const router = BUNDLED_LABELS[5].address;

  // Fictional services.
  const exHot = { bitcoin: service('BałtykEx: Hot Wallet', 'exchange', 'bitcoin'), ethereum: service('BałtykEx: Hot Wallet', 'exchange', 'ethereum'), tron: service('BałtykEx: Hot Wallet', 'exchange', 'tron') };
  const exDeposit = service('BałtykEx: adres depozytowy', 'exchange_deposit', 'ethereum');
  const escrow = { tron: service('HandelP2P: Escrow', 'p2p', 'tron'), bitcoin: service('HandelP2P: Escrow', 'p2p', 'bitcoin'), ethereum: service('HandelP2P: Escrow', 'p2p', 'ethereum') };
  const card = service('KartaKrypto: doładowanie karty', 'card', 'tron');
  const gateway = service('PłacKrypto: bramka płatnicza', 'payment_gateway', 'bitcoin');
  const otc = service('Kantor Wisła: skup OTC', 'otc', 'bitcoin');

  // ---------- the scripted subject ----------
  const hero = world.personas.find((p) => p.id === heroId)!;
  const w = (kind: WalletKind, label = 'main') => hero.wallets.find((x) => x.kind === kind && x.label === label)!.address;
  const btc = w('btc-segwit');
  const btcOld = w('btc-legacy', 'old');
  const eth = w('eth');
  const tron = w('tron', 'trading');
  // A personal deposit address at the exchange: unlabelled, but everything it receives is swept to the hot wallet.
  const heroDeposit = makeWallet(`${seed}|deposit`, 'btc-segwit', 'hero').address;
  const pool = ext('btc-segwit');

  pay('bitcoin', '2022-05-09T07:30:00.000Z', ext('btc-segwit'), btcOld, 0.19);
  pay('bitcoin', '2023-01-17T19:05:00.000Z', ext('btc-segwit'), btcOld, 0.12);
  pay('bitcoin', '2025-03-01T21:10:00.000Z', btcOld, btc, 0.31); // old wallet emptied into the new one
  for (const [at, amount] of [['2024-02-11T08:12:00.000Z', 0.042], ['2024-04-03T08:10:00.000Z', 0.055], ['2024-06-19T08:14:00.000Z', 0.038], ['2024-08-27T08:09:00.000Z', 0.061], ['2024-10-08T08:11:00.000Z', 0.047], ['2024-11-30T08:13:00.000Z', 0.066]] as const) {
    pay('bitcoin', at, pool, btc, amount);
  }
  // Like any modern wallet, the subject's wallet uses several receiving addresses. Only the first was ever
  // published; the others are tied to it because they are spent together in the same transactions.
  const recv = [1, 2, 3, 4, 5].map((i) => makeWallet(`${seed}|${hero.id}`, 'btc-segwit', `recv${i}`).address);
  for (const [i, at, amount] of [[0, '2024-07-14T18:22:00.000Z', 0.05], [1, '2024-09-02T09:47:00.000Z', 0.06], [2, '2025-05-19T20:03:00.000Z', 0.08], [3, '2025-06-27T07:55:00.000Z', 0.07], [4, '2025-09-11T16:30:00.000Z', 0.04]] as const) {
    pay('bitcoin', at, ext('btc-segwit'), recv[i], amount);
  }
  chain.wallets.push({ root: btc, members: [btc, ...recv] });

  const spend = (at: string, to: string, inputs: [string, number][]) => tx('bitcoin', at, inputs.map(([from, amount]) => ({ from, to, asset: 'BTC', amount })));
  for (const [at, inputs] of [
    ['2024-12-10T17:42:00.000Z', [[btc, 0.07], [recv[0], 0.05], [recv[1], 0.06]]],
    ['2025-08-15T11:20:00.000Z', [[btc, 0.1], [recv[2], 0.08], [recv[3], 0.07]]],
  ] as [string, [string, number][]][]) {
    spend(at, heroDeposit, inputs);
    pay('bitcoin', plus(at, 40), heroDeposit, exHot.bitcoin, inputs.reduce((n, [, x]) => n + x, 0));
  }
  pay('bitcoin', '2025-04-22T13:05:00.000Z', btc, gateway, 0.08);
  spend('2025-10-03T15:48:00.000Z', otc, [[btc, 0.05], [recv[4], 0.04]]);

  // The address from the QR code on his ad: buyers pay in, the proceeds go to an OTC desk.
  const sales = w('btc-segwit', 'sales');
  // Buyers paid the prices from his ads (3 200 zł and 1 900 zł) in bitcoin at the rate of the day.
  const btcFor = (pln: number, iso: string) => Math.round((pln / ((priceUsd('BTC', iso.slice(0, 10)) ?? 100_000) * (usdPlnBefore(iso.slice(0, 10))?.mid ?? 4))) * 1e5) / 1e5;
  const rigPaid = btcFor(3190, '2025-07-08T17:12:00.000Z');
  const cardPaid = btcFor(1895, '2025-08-02T09:40:00.000Z');
  pay('bitcoin', '2025-07-08T17:12:00.000Z', ext('btc-segwit'), sales, rigPaid);
  pay('bitcoin', '2025-08-02T09:40:00.000Z', ext('btc-segwit'), sales, cardPaid);
  pay('bitcoin', '2025-09-20T14:05:00.000Z', sales, otc, Math.round((rigPaid + cardPaid) * 0.96 * 1e5) / 1e5);
  chain.expected.push({ address: sales, personaId: hero.id, indicators: ['otc'] });

  // The address in the signature of his second, unlinked forum account.
  const tronAlt = w('tron', 'alt');
  for (const [at, amount] of [['2025-03-11T19:20:00.000Z', 1800], ['2025-04-27T21:05:00.000Z', 2500], ['2025-06-03T18:44:00.000Z', 3200], ['2025-08-19T20:31:00.000Z', 1500], ['2025-09-14T22:10:00.000Z', 2600]] as const) {
    pay('tron', at, ext('tron'), tronAlt, amount, 'USDT');
  }
  pay('tron', '2025-06-12T10:15:00.000Z', tronAlt, escrow.tron, 6000, 'USDT');
  pay('tron', '2025-09-25T11:40:00.000Z', tronAlt, card, 3500, 'USDT');
  chain.expected.push({ address: tronAlt, personaId: hero.id, indicators: ['card', 'p2p'] });

  // Swaps at the market price of the day, less a small fee.
  const swapOut = (iso: string, eth: number) => Math.round((eth * (priceUsd('ETH', iso.slice(0, 10)) ?? 2500) * 0.997) / 10) * 10;
  const usdt = swapOut('2024-09-18', 1.5);
  const usdc = swapOut('2025-05-30', 1.8);
  pay('ethereum', '2024-03-05T10:00:00.000Z', ext('eth'), eth, 2.5);
  pay('ethereum', '2024-06-21T16:30:00.000Z', ext('eth'), eth, 1.2);
  tx('ethereum', '2024-09-18T09:14:00.000Z', [{ from: eth, to: router, asset: 'ETH', amount: 1.5 }, { from: router, to: eth, asset: 'USDT', amount: usdt }]);
  pay('ethereum', '2024-09-20T12:02:00.000Z', eth, exDeposit, usdt, 'USDT');
  pay('ethereum', '2025-02-14T20:20:00.000Z', ext('eth'), eth, 0.01); // giveaway prize
  tx('ethereum', '2025-05-30T08:47:00.000Z', [{ from: eth, to: router, asset: 'ETH', amount: 1.8 }, { from: router, to: eth, asset: 'USDC', amount: usdc }]);
  pay('ethereum', '2025-06-02T10:31:00.000Z', eth, exDeposit, usdc, 'USDC');

  // A second Ethereum address of his, never published on his accounts. It pays into the same personal
  // deposit address at the exchange — which only one customer can do.
  const cold = w('eth', 'cold');
  pay('ethereum', '2024-11-04T07:50:00.000Z', ext('eth'), cold, 3);
  pay('ethereum', '2025-01-15T16:25:00.000Z', cold, exDeposit, 2.4);
  chain.wallets.push({ root: eth, members: [eth, cold] });

  // His Ethereum address has a name; the records on it were written by whoever controls the address.
  chain.names.push({ name: 'szklanedomy.eth', address: eth, personaId: hero.id, records: { 'com.github': 'szklanedomy', email: hero.email, description: 'Szklane domy z kodu' } });

  {
    // Buyers pay in USDT on Tron; the proceeds leave through a P2P escrow and a crypto card.
    let balance = 0;
    let day = Date.parse('2025-01-20T12:00:00.000Z');
    for (let i = 0; i < 12; i++) {
      day += rng.int(9, 26) * 86_400_000 + rng.int(0, 600) * 60_000;
      const amount = rng.int(4, 60) * 50;
      pay('tron', new Date(day).toISOString(), ext('tron'), tron, amount, 'USDT');
      balance += amount;
      if (i % 3 === 2) {
        const out = Math.floor((balance * 0.8) / 50) * 50;
        pay('tron', daytime(new Date(day + 2 * 86_400_000).toISOString()), tron, i % 2 ? card : escrow.tron, out, 'USDT');
        balance -= out;
      }
    }
  }
  chain.expected.push(
    { address: btc, personaId: hero.id, indicators: ['exchange', 'otc', 'payment_gateway'] },
    { address: eth, personaId: hero.id, indicators: ['exchange', 'stablecoin_swap'] },
    { address: tron, personaId: hero.id, indicators: ['card', 'p2p'] },
  );

  // ---------- background personas ----------
  const background = (p: Persona) => {
    for (const wallet of p.wallets) {
      const c = wallet.chain;
      const stable = c === 'tron' || (c === 'ethereum' && rng.chance(0.3));
      const asset = stable ? 'USDT' : NATIVE[c];
      const unit = stable ? 100 : c === 'bitcoin' ? 0.01 : 0.1;
      let balance = 0;
      const n = rng.int(1, 5);
      const times = Array.from({ length: n }, () => ago(30, 900)).sort();
      for (const at of times) {
        const amount = rng.int(1, 30) * unit;
        pay(c, at, ext(wallet.kind), wallet.address, amount, asset);
        balance += amount;
      }
      if (p.archetype === 'p2p_trader' && balance > 0) {
        pay(c, plus(times[times.length - 1], rng.int(60, 3000)), wallet.address, escrow[c], round(balance * 0.6), asset);
        chain.expected.push({ address: wallet.address, personaId: p.id, indicators: ['p2p'] });
      }
    }
  };
  for (const p of world.personas) if (p.id !== heroId) background(p);

  // ---------- added after everything else, so earlier addresses and transaction ids keep their values ----------
  // A contract the subject deployed from an address he never published anywhere. The contract is named in a
  // repository of his work account; the explorer knows which address created it.
  const deployer = hero.wallets.find((x) => x.kind === 'eth' && x.label === 'deployer')?.address;
  if (deployer) {
    const skarbonka = skarbonkaAddress(seed);
    chain.codes[skarbonka] = '0x6080604052600436106100345760003560e01c' + sha256Hex(skarbonka).slice(0, 40);
    chain.deployments.push({ contract: skarbonka, creator: deployer, txHash: '0x' + sha256Hex(`deploy|${skarbonka}`), at: '2025-03-04T18:40:00.000Z' });
    pay('ethereum', '2025-02-20T18:05:00.000Z', ext('eth'), deployer, 0.4);
    for (const [at, amount] of [['2025-03-09T11:20:00.000Z', 1.1], ['2025-04-14T16:45:00.000Z', 0.9], ['2025-05-28T09:30:00.000Z', 1.4]] as const) pay('ethereum', at, ext('eth'), skarbonka, amount);
    pay('ethereum', '2025-06-30T17:15:00.000Z', skarbonka, deployer, 3.2); // withdrawal after the term
    pay('ethereum', '2025-07-02T18:22:00.000Z', deployer, escrow.ethereum, 1.9);
    pay('ethereum', '2025-08-11T19:03:00.000Z', deployer, escrow.ethereum, 1.2);
    chain.expected.push({ address: deployer, personaId: hero.id, indicators: ['p2p'] });
  }

  // A friend overseas whose address the subject once posted. His transfers go out in the evening of his own
  // time zone — the middle of the night in Poland, when the subject is never active.
  const friend = world.personas.find((p) => p.id === 'kolega')?.wallets[0]?.address;
  if (friend) {
    for (const [at, amount] of [['2025-03-28T16:10:00.000Z', 0.21], ['2025-05-02T23:40:00.000Z', 0.18], ['2025-06-21T00:15:00.000Z', 0.26]] as const) pay('bitcoin', at, ext('btc-segwit'), friend, amount);
    for (const [at, amount] of [
      ['2025-04-09T02:12:00.000Z', 0.03], ['2025-04-30T03:05:00.000Z', 0.05], ['2025-05-17T01:48:00.000Z', 0.04], ['2025-06-08T02:37:00.000Z', 0.06],
      ['2025-07-01T03:22:00.000Z', 0.05], ['2025-07-26T01:55:00.000Z', 0.07], ['2025-08-19T02:44:00.000Z', 0.04],
    ] as const) pay('bitcoin', at, friend, ext('btc-segwit'), amount);
  }

  // One ordinary user has upgraded their address with an EIP-7702 delegation: it has bytecode but is still a personal wallet.
  // A forum user who only dropped an address in a discussion, but whose address carries a name pointing back at the forum nick.
  const named = world.personas.filter((p) => p.archetype === 'forum_talker' && p.wallets[0]?.kind === 'eth')[2];
  if (named) chain.names.push({ name: `${named.handles.forum!.replace(/[^a-z0-9]/g, '')}.eth`, address: named.wallets[0].address, personaId: named.id, records: { 'com.twitter': named.handles.forum! } });

  const delegated = world.personas.find((p) => p.archetype === 'open_dev')?.wallets.find((x) => x.kind === 'eth');
  if (delegated) chain.codes[delegated.address] = '0xef0100' + sha256Hex('delegate').slice(0, 40);

  chain.txs.sort((a, b) => a.at.localeCompare(b.at));
  return chain;
}

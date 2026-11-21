import { describe, expect, it } from 'vitest';
import { classifyCode, makeIdentifier, type AccountInfo } from '@olcys/core';
import { DEFAULT_RULESET, analyzeActivity, assess, buildEstimate, draftRequest, matchAmounts, valueTransfer, warsawDay, type CandidateTransfer, type DocFact, type MentionFact, type RunFacts, type StatedAmount } from '../src';

const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const seed = makeIdentifier('username', 'ala');

let n = 0;
const doc = (origin: string, handle: string, docType: string, extra: Partial<DocFact> = {}): DocFact => ({
  id: `d${++n}`, origin, connectorId: origin, url: `http://${origin}.test/${handle}/${n}`, docType, authorHandle: handle,
  authorProfileUrl: `http://${origin}.test/${handle}`, relation: 'author', discovered: [], fetchedAt: '2026-11-21T10:00:00.000Z', snapshotSha256: 'a'.repeat(64), ...extra,
});
const mention = (d: DocFact, extra: Partial<MentionFact> = {}): MentionFact => ({
  documentId: d.id, chain: 'ethereum', address: ADDR, segmentKind: 'body', method: 'plain', obfuscation: [], raw: ADDR, context: '', ...extra,
});
const facts = (documents: DocFact[], mentions: MentionFact[], accounts: AccountInfo[] = []): RunFacts => ({
  seeds: [seed],
  documents,
  mentions,
  accounts,
  hits: documents.filter((d) => d.authorHandle === 'ala').map((d) => ({ documentId: d.id, identifier: seed, relation: d.relation })),
});
const account = (code: string): AccountInfo => ({ chain: 'ethereum', address: ADDR, ...classifyCode(code), code, labels: [], txCount: 3, balances: [] });

describe('bytecode classification', () => {
  it('tells contracts, delegated accounts and contract wallets apart', () => {
    expect(classifyCode('0x').kind).toBe('eoa');
    expect(classifyCode(undefined).kind).toBe('eoa');
    expect(classifyCode('0xef0100' + 'ab'.repeat(20))).toEqual({ kind: 'delegated_eoa', delegate: '0x' + 'ab'.repeat(20) });
    expect(classifyCode('0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e00000000').kind).toBe('smart_wallet');
    expect(classifyCode('0x6080604052348015600f57600080fd5b50').kind).toBe('contract');
  });
});

describe('score rules', () => {
  it('forum discussion alone is MEDIUM; the same nick selling on another service makes it VERY HIGH', () => {
    const post = doc('forum', 'ala', 'post');
    const one = assess(facts([post], [mention(post)]));
    expect(one.links[0]).toMatchObject({ score: 45, band: 'medium' });

    const ad = doc('market', 'ala', 'ad');
    const two = assess(facts([post, ad], [mention(post), mention(ad)]));
    expect(two.links[0]).toMatchObject({ score: 80, band: 'very_high' }); // strongest place is now the ad: 65 + 15
  });

  it('mass comments stay noise even when repeated, detected by keyword or by thread statistics', () => {
    const byKeyword = doc('forum', 'ala', 'post', { container: { kind: 'thread', title: 'Wielki KONKURS świąteczny' } });
    const byStats = doc('forum', 'ala', 'post', { container: { kind: 'thread', title: 'Zapisy', stats: { posts: 20, postsWithAddress: 17 } } });
    const a = assess(facts([byKeyword, byStats], [mention(byKeyword), mention(byStats)]));
    expect(a.links[0]).toMatchObject({ score: 20, band: 'noise' });
    expect(a.links[0].occurrences.map((o) => o.placement)).toEqual(['mass_comment', 'mass_comment']);
    expect(a.links[0].receipt.map((r) => r.rule)).toEqual(['P4', 'S2']);
  });

  it('excludes a contract by bytecode, but not a delegated account or a contract wallet', () => {
    const profile = doc('code', 'ala', 'profile', { relation: 'profile_owner' });
    const run = (code: string) => assess(facts([profile], [mention(profile, { segmentKind: 'bio' })], [account(code)])).links[0];
    expect(run('0x6080604052348015600f57600080fd5b50')).toMatchObject({ status: 'excluded', score: 0 });
    expect(run('0x6080604052348015600f57600080fd5b50').receipt[0].rule).toBe('X2');
    expect(run('0xef0100' + 'ab'.repeat(20))).toMatchObject({ status: 'attributed', score: 85 });
    expect(run('0xef0100' + 'ab'.repeat(20)).receipt.map((r) => r.rule)).toContain('K1');
    expect(run('0x6080a619486e00').receipt.map((r) => r.rule)).toContain('K2');
  });

  it('excludes an explorer-labelled address even when it is not on the bundled list', () => {
    const profile = doc('code', 'ala', 'profile', { relation: 'profile_owner' });
    const labelled = { ...account('0x'), labels: [{ name: 'Giełda Testowa: Hot Wallet', category: 'exchange' as const, source: 'API' }] };
    const l = assess(facts([profile], [mention(profile, { segmentKind: 'bio' })], [labelled])).links[0];
    expect(l.status).toBe('excluded');
    expect(l.receipt[0].detail).toContain('Giełda Testowa');
  });

  it('treats an address published by three unrelated accounts as public', () => {
    const mine = doc('forum', 'ala', 'post');
    const others = ['bob', 'cy', 'dee'].map((h) => doc('forum', h, 'post', { relation: 'mention' }));
    const two = assess(facts([mine, ...others.slice(0, 2)], [mention(mine), ...others.slice(0, 2).map((d) => mention(d))]));
    expect(two.links[0]).toMatchObject({ status: 'attributed', score: 45 });
    expect(two.links[0].receipt.map((r) => r.rule)).toContain('M1');
    const three = assess(facts([mine, ...others], [mention(mine), ...others.map((d) => mention(d))]));
    expect(three.links[0]).toMatchObject({ status: 'excluded', score: 0 });
    expect(three.links[0].receipt[0].rule).toBe('X3');
  });

  it('never joins accounts because a name matches', () => {
    const name = makeIdentifier('full_name', 'Jan Rzecki');
    const a = doc('forum', 'jan1', 'profile', { relation: 'profile_owner', authorDisplayName: 'Jan Rzecki' });
    const b = doc('code', 'jan2', 'profile', { relation: 'profile_owner', authorDisplayName: 'Jan Rzecki' });
    const f: RunFacts = { seeds: [name], documents: [a, b], accounts: [], mentions: [mention(a, { segmentKind: 'signature' })], hits: [a, b].map((d) => ({ documentId: d.id, identifier: name, relation: 'profile_owner' })) };
    const r = assess(f);
    expect(r.clusters.map((c) => c.level)).toEqual(['name_ambiguous', 'name_ambiguous']);
    expect(r.links[0]).toMatchObject({ score: 39 });
    // a single match is "unique": capped at the top of MEDIUM instead
    const single = assess({ ...f, documents: [a], hits: [f.hits[0]] });
    expect(single.clusters[0].level).toBe('name_unique');
    expect(single.links[0]).toMatchObject({ score: 59, band: 'medium' });
  });

  it('is deterministic', () => {
    const post = doc('forum', 'ala', 'post');
    const f = facts([post], [mention(post)]);
    expect(JSON.stringify(assess(f, DEFAULT_RULESET))).toBe(JSON.stringify(assess(f, DEFAULT_RULESET)));
  });
});

describe('on-chain indicators', () => {
  const me = 'ME';
  const t = (from: string, to: string, asset: string, amount: number, at: string, txHash = at) => ({ chain: 'ethereum' as const, txHash, at, from, to, asset, amount });
  const labels = (a: string) => (a === 'EX' ? [{ name: 'Giełda', category: 'exchange' as const, source: 'x' }] : a === 'CARD' ? [{ name: 'Karta', category: 'card' as const, source: 'x' }] : []);

  it('flags only swaps above the threshold and groups transfers by kind of service', () => {
    const { activity, indicators } = analyzeActivity({ addresses: [me], labelsOf: labels, transfers: [
      t('A', me, 'ETH', 3, '2025-01-01'),
      t(me, 'DEX', 'ETH', 1, '2025-02-01', 'swap1'), t('DEX', me, 'USDT', 2500, '2025-02-01', 'swap1'),
      t(me, 'DEX', 'ETH', 0.1, '2025-02-02', 'swap2'), t('DEX', me, 'USDT', 250, '2025-02-02', 'swap2'),
      t(me, 'EX', 'USDT', 2500, '2025-02-03'), t(me, 'CARD', 'USDT', 100, '2025-02-04'), t(me, 'CARD', 'USDT', 150, '2025-03-04'),
      t('EX', me, 'ETH', 0.5, '2025-04-01'),
    ] });
    expect(activity.sent).toEqual([{ asset: 'ETH', amount: 1.1 }, { asset: 'USDT', amount: 2750 }]);
    expect(indicators.map((i) => [i.type, i.count, i.cashOut, i.certainty])).toEqual([
      ['exchange', 1, true, 'possible'], ['card', 2, true, 'probable'], ['stablecoin_swap', 1, true, undefined], ['exchange_inflow', 1, false, undefined],
    ]);
    expect(indicators[1].totals).toEqual([{ asset: 'USDT', amount: 250 }]);
  });

  it('treats several addresses as one wallet: moves between them are neither income nor spending', () => {
    const { activity } = analyzeActivity({ addresses: [me, 'ME2'], labelsOf: labels, transfers: [
      t('A', me, 'BTC', 1, '2025-01-01'), t(me, 'ME2', 'BTC', 0.4, '2025-01-02'), t('ME2', 'CARD', 'BTC', 0.1, '2025-01-03'),
      t(me, 'ME2', 'BTC', 0.4, '2025-01-02'), // the same transfer seen from the other address
    ] });
    expect(activity).toMatchObject({ transfers: 3, internal: 1, received: [{ asset: 'BTC', amount: 1 }], sent: [{ asset: 'BTC', amount: 0.1 }] });
  });

  it('recognises an unlabelled exchange deposit address by where its money goes next', () => {
    const transfers = [t(me, 'DEP', 'BTC', 0.5, '2025-01-10T10:00'), t(me, 'FRIEND', 'BTC', 0.2, '2025-01-11T10:00')];
    const hops = new Map([
      ['DEP', [t(me, 'DEP', 'BTC', 0.5, '2025-01-10T10:00'), t('DEP', 'EX', 'BTC', 0.5, '2025-01-10T10:40')]],
      ['FRIEND', [t(me, 'FRIEND', 'BTC', 0.2, '2025-01-11T10:00'), t('FRIEND', 'EX', 'BTC', 0.05, '2025-01-12T10:00')]], // keeps most of it: not a deposit address
    ]);
    const { indicators, offRamps } = analyzeActivity({ addresses: [me], transfers, labelsOf: labels, hops });
    expect(indicators).toHaveLength(1);
    expect(indicators[0]).toMatchObject({ type: 'exchange', inferred: true, count: 1, totals: [{ asset: 'BTC', amount: 0.5 }] });
    expect(offRamps).toEqual([expect.objectContaining({ exchange: 'Giełda', depositAddress: 'DEP', rule: 'D1' })]);
    expect(offRamps[0].sweeps).toHaveLength(1);
    // without the look-ahead nothing is claimed
    expect(analyzeActivity({ addresses: [me], transfers, labelsOf: labels }).indicators).toEqual([]);

    const draft = draftRequest(offRamps[0], { caseTitle: 'test', runId: 'r1', generatedAt: '2026-11-21T12:00:00.000Z' });
    expect(draft).toContain('Adresat: Giełda');
    expect(draft).toContain('0,5 BTC');
    expect(draft).toContain('[do uzupełnienia]');
  });
});

describe('PLN estimate', () => {
  const tr = (at: string, asset: string, amount: number) => ({ chain: 'bitcoin' as const, txHash: at, at, from: 'ME', to: 'X', asset, amount });
  const rate = { currency: 'USD', mid: 4, effectiveDate: '2024-12-30', table: '251/A/NBP/2024', source: 'NBP', url: '' };
  const meta = { channel: 'otc' as const, channelTitle: 'Kantor / OTC', certainty: 'probable' as const };

  it('assigns the tax year by the Polish calendar day', () => {
    expect(warsawDay('2024-12-31T22:30:00.000Z')).toBe('2024-12-31');
    expect(warsawDay('2024-12-31T23:30:00.000Z')).toBe('2025-01-01'); // already New Year in Poland
  });

  it('values a transfer as amount × price × NBP rate and sums by year and certainty', () => {
    const a = valueTransfer(tr('2024-12-31T12:00:00.000Z', 'BTC', 0.1), meta, { asset: 'BTC', usd: 90000, date: '2024-12-31', source: 's', url: '' }, rate);
    expect(a).toMatchObject({ taxYear: 2024, valueUsd: 9000, valuePln: 36000, rate: { table: '251/A/NBP/2024' } });
    const b = valueTransfer(tr('2025-03-01T12:00:00.000Z', 'USDT', 500), { ...meta, channel: 'exchange', channelTitle: 'Wpłaty na giełdę', certainty: 'possible' }, { asset: 'USDT', usd: 1, date: '2025-03-01', source: 's', url: '' }, rate);
    const c = valueTransfer(tr('2025-04-01T12:00:00.000Z', 'DOGE', 5), meta, undefined, rate);
    expect(c.valuePln).toBeUndefined();
    expect(c.note).toContain('brak kursu DOGE');

    const e = buildEstimate([a, b, c], { minScore: 60, addresses: [], leftOut: [] });
    expect(e.years).toEqual([
      { year: 2024, probablePln: 36000, possiblePln: 0, totalPln: 36000, channels: [{ channel: 'otc', title: 'Kantor / OTC', certainty: 'probable', pln: 36000, count: 1 }] },
      { year: 2025, probablePln: 0, possiblePln: 2000, totalPln: 2000, channels: [{ channel: 'exchange', title: 'Wpłaty na giełdę', certainty: 'possible', pln: 2000, count: 1 }] },
    ]);
    expect(e).toMatchObject({ totalPln: 38000, unvalued: 1 });
  });
});

describe('stated amounts and transfers', () => {
  const ad = (raw: string, value: number, at: string): StatedAmount => ({ documentId: raw, url: `http://ads.test/${raw}`, docType: 'ad', title: 'Koparka', at, value, unit: 'PLN', raw, kind: 'price' });
  const tr = (at: string, valuePln: number, direction: 'in' | 'out' = 'in'): CandidateTransfer => ({
    chain: 'bitcoin', txHash: at, at, from: direction === 'in' ? 'BUYER' : 'ME', to: direction === 'in' ? 'ME' : 'SHOP', asset: 'BTC', amount: 0.03,
    address: 'ME', walletRoot: 'ME', direction, valuePln, rate: { mid: 3.6, table: '130/A/NBP/2025' },
  });

  it('matches an ad price to a payment of that value in the weeks after the ad', () => {
    const m = matchAmounts([ad('3 200 zł', 3200, '2025-07-03T10:00:00.000Z')], [tr('2025-07-08T12:00:00.000Z', 3185), tr('2025-07-20T12:00:00.000Z', 900)]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ unique: true, valuePln: 3185, statedRaw: '3 200 zł' });
    expect(m[0].deviation).toBeLessThan(0.01);
    expect(m[0].detail).toContain('tab. 130/A/NBP/2025');
  });

  it('ignores payments before the ad, outgoing payments, and values that are too far off', () => {
    const s = [ad('3 200 zł', 3200, '2025-07-03T10:00:00.000Z')];
    expect(matchAmounts(s, [tr('2025-06-20T12:00:00.000Z', 3200)])).toEqual([]);
    expect(matchAmounts(s, [tr('2025-07-08T12:00:00.000Z', 3200, 'out')])).toEqual([]);
    expect(matchAmounts(s, [tr('2025-07-08T12:00:00.000Z', 3500)])).toEqual([]);
    expect(matchAmounts(s, [tr('2025-09-30T12:00:00.000Z', 3200)])).toEqual([]);
  });

  it('flags a match as ambiguous when several payments fit, and gives each transfer to one ad only', () => {
    const twoFit = matchAmounts([ad('3 200 zł', 3200, '2025-07-03T10:00:00.000Z')], [tr('2025-07-08T12:00:00.000Z', 3190), tr('2025-07-15T12:00:00.000Z', 3150)]);
    expect(twoFit).toHaveLength(1);
    expect(twoFit[0]).toMatchObject({ unique: false, valuePln: 3190 });
    const twoAds = matchAmounts([ad('3 200 zł', 3200, '2025-07-03T10:00:00.000Z'), ad('3 250 zł', 3250, '2025-07-04T10:00:00.000Z')], [tr('2025-07-08T12:00:00.000Z', 3240)]);
    expect(twoAds).toHaveLength(1);
    expect(twoAds[0].statedRaw).toBe('3 250 zł');
  });

  it('matches a crypto amount mentioned in a post to a transfer of that asset within days', () => {
    const post: StatedAmount = { documentId: 'p', url: 'http://forum.test/p', docType: 'post', at: '2025-02-15T08:30:00.000Z', value: 0.01, unit: 'ETH', raw: '0,01 ETH', kind: 'text' };
    const t: CandidateTransfer = { chain: 'ethereum', txHash: 'x', at: '2025-02-14T20:20:00.000Z', from: 'A', to: 'ME', asset: 'ETH', amount: 0.01, address: 'ME', walletRoot: 'ME', direction: 'in' };
    expect(matchAmounts([post], [t])[0]).toMatchObject({ unique: true, kind: 'text', deviation: 0 });
    expect(matchAmounts([post], [{ ...t, asset: 'USDT' }])).toEqual([]);
    expect(matchAmounts([post], [{ ...t, at: '2025-03-01T00:00:00.000Z' }])).toEqual([]);
  });
});

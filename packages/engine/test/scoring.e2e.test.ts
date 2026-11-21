import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNbpConnector, createWorldArchiveConnector, createWorldChainConnector, createWorldConnectors, createWorldNameService, createWorldPriceConnector } from '@olcys/connectors';
import { makeIdentifier } from '@olcys/core';
import { Store, migrate, openDatabase, type SqlExecutor } from '@olcys/db';
import { DEFAULT_RULESET, type Link } from '@olcys/scoring';
import { HERO_ID, NAMESAKE_ID, NBP, generateWorld, priceUsd, startWorld, type Placement, type RunningWorld } from '@olcys/world';
import { reassessRun, runAnalysis, type RunSummary } from '../src';

const world = generateWorld();
const hero = world.personas.find((p) => p.id === HERO_ID)!;
const wallet = (kind: string, label?: string) => hero.wallets.find((w) => w.kind === kind && (!label || w.label === label))!.address;

let running: RunningWorld;
let db: SqlExecutor;
let store: Store;
let deps: Parameters<typeof runAnalysis>[0];

beforeAll(async () => {
  running = await startWorld(world);
  db = await openDatabase('pglite://memory');
  await migrate(db);
  store = new Store(db);
  const connectors = createWorldConnectors(running.bases);
  const chain = [createWorldChainConnector(running.bases.explorer)];
  const rates = createNbpConnector(running.bases.rates, true);
  const prices = createWorldPriceConnector(running.bases.rates);
  const archive = createWorldArchiveConnector(running.bases.archive);
  const names = createWorldNameService(running.bases.explorer);
  deps = { store, connectors, chain, rates, prices, archive, names, allowlist: [...connectors, ...chain, rates, prices, archive].flatMap((c) => c.descriptor.hosts) };
});

afterAll(async () => {
  await running.close();
  await db.close();
});

const analyze = async (kind: Parameters<typeof makeIdentifier>[0], value: string, params = {}) => {
  const c = await store.createCase(value, [makeIdentifier(kind, value)]);
  return runAnalysis(deps, c.id, params);
};
const linkOf = (s: RunSummary, address: string, clusterId = 'T1') => s.assessment!.links.find((l) => l.address === address && l.clusterId === clusterId)!;
const rules = (l: Link) => l.receipt.map((r) => r.rule);

describe('mandatory scenario: the scripted subject, from one forum nick', () => {
  let s: RunSummary;
  beforeAll(async () => {
    s = await analyze('username', 'szklane_domy');
  });

  it('joins the accounts of one person on hard evidence only', () => {
    const [subject, other] = s.assessment!.clusters;
    expect(subject).toMatchObject({ id: 'T1', level: 'entered', identityCap: 100 });
    expect(subject.accounts.map((a) => `${a.origin}:${a.handle}`).sort()).toEqual(['bazarek:SzklaneDomy', 'bazarek:eth_od_reki', 'bitrozmowy:nocny_kantor', 'bitrozmowy:szklane_domy', 'kodownia:szklanedomy']);
    expect(new Set(subject.joins.map((j) => j.rule))).toEqual(new Set(['J1', 'J2', 'J3', 'J4', 'J6', 'J7']));
    // the namesake is found, kept apart, and marked as ambiguous
    expect(other).toMatchObject({ id: 'T2', level: 'name_ambiguous', identityCap: 39 });
    expect(other.accounts).toEqual([expect.objectContaining({ handle: 'czarek_b' })]);
  });

  it('scores each address by the published rules and explains every point', () => {
    const btc = linkOf(s, wallet('btc-segwit'));
    expect(btc).toMatchObject({ status: 'attributed', score: 100, band: 'very_high' });
    expect(rules(btc)).toEqual(['P1', 'S1', 'S2']);
    expect(btc.receipt[0]).toMatchObject({ effect: 'base', points: 85, total: 85 });
    expect(btc.receipt[1]).toMatchObject({ effect: 'bonus', points: 15, total: 100 });
    expect(btc.receipt[0].evidence.length).toBeGreaterThan(0);

    // ad (65) + a second independent source (+15) + deliberately hidden (+3)
    const tron = linkOf(s, wallet('tron'));
    expect(tron).toMatchObject({ status: 'attributed', score: 83, band: 'very_high' });
    expect(rules(tron)).toEqual(['P2', 'P0', 'S1', 'O1']);

    // own profile (85) + giveaway post on another service (+15)
    expect(linkOf(s, wallet('eth'))).toMatchObject({ score: 100, band: 'very_high' });
  });

  it('reads an address that exists only in a QR code on an ad photo', () => {
    const sales = linkOf(s, wallet('btc-segwit', 'sales'));
    expect(sales.receipt[0]).toMatchObject({ rule: 'P2', points: 65 });
    expect(rules(sales).slice(0, 2)).toEqual(['P2', 'G1']);
    expect(sales.occurrences).toHaveLength(1);
    expect(sales.occurrences[0]).toMatchObject({ method: 'qr', placement: 'sale', segmentKind: 'image' });
    expect(sales.occurrences[0].image!.url).toMatch(/\/zdjecia\/\d+\.png$/);
    expect(sales.challenges.map((c) => c.text).join(' ')).toContain('kodu QR');
    // the photo itself is kept as evidence
    expect(s.addresses.find((a) => a.address === sales.address)!.occurrences[0].source_snapshot_id).toBeTruthy();
  });

  it('goes from the blockchain back to the web and finds an account nothing on the web links to the person', async () => {
    const hidden = wallet('btc-segwit', 'recv3');
    const alt = wallet('tron', 'alt');
    // the hidden address is part of the wallet of the address on his profile; searching it finds the second account
    expect(s.identifiers.filter((i) => i.origin === 'wallet').map((i) => i.value)).toEqual(expect.arrayContaining([hidden, running.bases.forum + '/uzytkownik/nocny_kantor']));
    const join = s.assessment!.clusters[0].joins.find((j) => j.rule === 'J6')!;
    expect(join.detail).toContain('nocny_kantor');
    expect(join.detail).toContain('w jednej transakcji');

    // the hidden address, advertised by that account in a forum post, takes the strength of the wallet it belongs to
    const h = linkOf(s, hidden);
    expect(h).toMatchObject({ status: 'attributed', score: 90, band: 'very_high' });
    expect(rules(h)).toEqual(['P3', 'W2']);
    expect(h.receipt.at(-1)).toMatchObject({ effect: 'bonus', points: 45, total: 90 });
    // and the account's own address, found only because the account was then read in full
    expect(linkOf(s, alt)).toMatchObject({ status: 'attributed', score: 85 });
    expect(s.chain.activity.find((x) => x.address === alt)!.indicators.map((i) => i.type).sort()).toEqual(['card', 'p2p']);
    // the hidden address is not analysed twice: it is part of the main wallet
    expect(s.chain.activity.some((x) => x.address === hidden)).toBe(false);

    // without a view of the blockchain there is no way to tie that account in
    const blind = await runAnalysis({ ...deps, chain: undefined }, (await store.createCase('blind', [makeIdentifier('username', 'szklane_domy')])).id);
    expect(blind.assessment!.clusters[0].accounts.map((a) => a.handle)).not.toContain('nocny_kantor');
    expect(blind.assessment!.links.some((l) => l.address === alt)).toBe(false);
  });

  it('finds another address of the same exchange customer, and through it a third account', () => {
    const cold = wallet('eth', 'cold');
    // the profile address and the unpublished one both paid into one personal deposit address at the exchange
    const chain = s.chain.activity.find((x) => x.address === wallet('eth'))!;
    expect(chain.wallet.map((m) => [m.address, m.rule])).toEqual([[wallet('eth'), undefined], [cold, 'D2']]);
    expect(chain.indicators.find((i) => i.type === 'exchange')!.totals).toEqual([{ asset: 'ETH', amount: 2.4 }, expect.objectContaining({ asset: 'USDC' }), expect.objectContaining({ asset: 'USDT' })]);
    // searching that address on the web finds the ad-board account that advertises it
    const join = s.assessment!.clusters[0].joins.find((j) => j.rule === 'J6' && j.detail.includes('eth_od_reki'))!;
    expect(join.detail).toContain('ten sam adres depozytowy giełdy');
    const l = linkOf(s, cold);
    expect(l).toMatchObject({ status: 'attributed', score: 90 });
    expect(rules(l)).toEqual(['P2', 'W2']);
    expect(l.receipt.at(-1)!.detail).toContain('giełda przydziela taki adres jednemu klientowi');
  });

  it('reads on-chain names: a name in the text, and the records an address owner attached', () => {
    const eth = linkOf(s, wallet('eth'));
    // "szklanedomy.eth" in the profile text resolves to the address; the address's own name points back at the account
    expect(eth.occurrences.some((o) => o.method === 'ens' && o.raw === 'szklanedomy.eth')).toBe(true);
    expect(rules(eth)).toEqual(expect.arrayContaining(['E1', 'N1']));
    expect(eth.receipt.find((r) => r.rule === 'N1')!.detail).toMatch(/nazwę szklanedomy\.eth, której rekord „(com\.github: szklanedomy|email: cezary\.baryka@poczta\.test)”/);
    expect(s.assessment!.clusters[0].joins.some((j) => j.rule === 'J7')).toBe(true);
  });

  it('a name whose record points back at the account lifts a weak link', async () => {
    const n = world.chain.names.find((x) => x.personaId !== HERO_ID)!;
    const owner = world.personas.find((p) => p.id === n.personaId)!;
    const r = await analyze('username', owner.handles.forum!);
    const l = r.assessment!.links.find((x) => x.address === n.address)!;
    expect(l.receipt[0]).toMatchObject({ rule: 'P3', points: 45 });
    expect(l.receipt.find((x) => x.rule === 'N1')).toMatchObject({ effect: 'bonus', total: 95 });
    expect(l.score).toBe(95);
  });

  it('matches publicly stated amounts to payments', () => {
    const sales = linkOf(s, wallet('btc-segwit', 'sales'));
    expect(sales).toMatchObject({ status: 'attributed', score: 85, band: 'very_high' });
    expect(rules(sales)).toEqual(['P2', 'G1', 'A1', 'A1']);
    const [rig, card] = sales.receipt.filter((r) => r.rule === 'A1');
    expect(rig).toMatchObject({ effect: 'bonus', points: 10, total: 75 });
    expect(rig.detail).toContain('3 200 zł');
    expect(rig.detail).toMatch(/kurs NBP \d,\d{4}, tab\. \d+\/A\/NBP\/2025/);
    // the second ad shows no address at all; the payment worth its price ties it to this address
    expect(card).toMatchObject({ effect: 'bonus', points: 10, total: 85 });
    expect(card.detail).toContain('1 900 zł');
    for (const m of world.matches.filter((x) => x.personaId === HERO_ID)) {
      const l = linkOf(s, m.address);
      expect(l.receipt.some((r) => r.rule === 'A1' && r.evidence.some((u) => u.endsWith(m.path.split('#')[0]) || u.endsWith(m.path))), m.stated).toBe(true);
    }
    // a crypto amount mentioned in a post ("0,01 ETH doszło") is matched to the transfer of that asset
    expect(linkOf(s, wallet('eth')).receipt.find((r) => r.rule === 'A1')!.detail).toContain('0,01 ETH');
  });

  it('treats a signed message that names the account as proof', () => {
    const old = linkOf(s, wallet('btc-legacy'));
    expect(old).toMatchObject({ status: 'attributed', score: 100, band: 'very_high', proven: true });
    expect(rules(old)).toEqual(['P1', 'P0', 'S2', 'H1', 'C1']);
    expect(old.receipt.at(-1)).toMatchObject({ rule: 'C1', effect: 'bonus', points: 15, total: 100 });
    expect(old.receipt.at(-1)!.detail).toContain('szklane_domy');
    expect(old.challenges.at(-1)!.text).toContain('Klucz mógł później zmienić właściciela');
  });

  it('finds the address that used to be on the profile and reports the swap', () => {
    const h = s.assessment!.histories.find((x) => x.handle === 'szklane_domy')!;
    expect(h.versions.map((v) => v.source)).toEqual(['archive', 'archive', 'archive', 'archive', 'live']);
    expect(h.versions.map((v) => v.addresses.map((a) => a.address))).toEqual([
      [wallet('btc-legacy')], [wallet('btc-legacy')], [wallet('btc-legacy')], [wallet('btc-segwit')], [wallet('btc-segwit')],
    ]);
    expect(h.changes).toEqual([expect.objectContaining({ kind: 'swap', from: wallet('btc-legacy'), to: wallet('btc-segwit'), after: '2024-09-20T10:15:00.000Z', before: '2025-06-01T12:00:00.000Z' })]);
    // the old address is not on the live site at all: it comes from the archive and the signed post
    const old = linkOf(s, wallet('btc-legacy'));
    expect(old.occurrences.filter((o) => o.archivedAt)).toHaveLength(3);
    expect(old.receipt.find((r) => r.rule === 'H1')!.detail).toContain('został na profilu zastąpiony adresem');
    // moving funds between the person's own addresses is not counted as income or spending
    const chain = s.chain.activity.find((a) => a.address === old.address)!;
    expect(chain.activity).toMatchObject({ internal: 1, sent: [] });
    expect(chain.indicators).toEqual([]);
  });

  it('rejects institutions and contracts with a stated reason, and keeps the mention on record', () => {
    for (const t of world.truth.filter((p) => p.postedBy === HERO_ID && p.expected === 'excluded')) {
      const l = linkOf(s, t.address);
      expect(l, t.entity!.name).toMatchObject({ status: 'excluded', score: 0, band: 'excluded' });
      expect(rules(l)).toEqual(['X1', 'F1']);
      expect(l.receipt[0].detail).toContain(t.entity!.name);
    }
  });

  it('does not attribute a quoted address to the person who quoted it', () => {
    const quoted = world.truth.find((p) => p.postedBy === HERO_ID && p.where === 'quote')!;
    expect(linkOf(s, quoted.address)).toMatchObject({ status: 'not_attributable', score: 0 });
    expect(rules(linkOf(s, quoted.address))).toEqual(['Q1']);
  });

  it('caps the namesake by identity confidence instead of merging him with the subject', () => {
    const namesake = world.personas.find((p) => p.id === NAMESAKE_ID)!;
    const l = linkOf(s, namesake.wallets[0].address, 'T2');
    expect(l).toMatchObject({ status: 'attributed', score: 39, band: 'noise' });
    expect(l.receipt.at(-1)).toMatchObject({ rule: 'T1', effect: 'cap', points: 39 });
    expect(s.assessment!.links.some((x) => x.address === namesake.wallets[0].address && x.clusterId === 'T1')).toBe(false);
  });

  it('finds the cash-out patterns planted in the ledger', () => {
    for (const exp of world.chain.expected.filter((e) => e.personaId === HERO_ID)) {
      const a = s.chain.activity.find((x) => x.address === exp.address)!;
      expect(a, exp.address).toBeDefined();
      expect(a.indicators.filter((i) => i.cashOut).map((i) => i.type).sort()).toEqual(exp.indicators);
      for (const i of a.indicators) expect(i.transfers.every((t) => t.snapshotId)).toBe(true);
    }
    const eth = s.chain.activity.find((x) => x.address === wallet('eth'))!;
    expect(eth.indicators.find((i) => i.type === 'stablecoin_swap')).toMatchObject({ count: 2 });
    expect(eth.indicators.find((i) => i.type === 'stablecoin_swap')!.certainty).toBeUndefined();
    expect(eth.indicators.find((i) => i.type === 'exchange')!.counterparties[0].name).toBe('BałtykEx: adres depozytowy');
  });

  it('expands one published address into the whole wallet', () => {
    const truth = world.chain.wallets[0];
    const btc = s.chain.activity.find((x) => x.address === truth.root)!;
    expect(btc.wallet.map((m) => m.address).sort()).toEqual([...truth.members].sort());
    expect(btc.wallet[0].via).toBeUndefined();
    expect(btc.wallet.slice(1).every((m) => m.via && truth.members.includes(m.via.with))).toBe(true);
    // what the hidden addresses received and sent is part of the picture
    expect(btc.activity.received.find((a) => a.asset === 'BTC')!.amount).toBeGreaterThan(0.6);
  });

  it('names the exchange behind an unlabelled deposit address', () => {
    const btc = s.chain.activity.find((x) => x.address === wallet('btc-segwit'))!;
    const exchange = btc.indicators.find((i) => i.type === 'exchange')!;
    expect(exchange).toMatchObject({ inferred: true, certainty: 'possible', totals: [{ asset: 'BTC', amount: 0.43 }] });
    expect(btc.offRamps).toEqual([expect.objectContaining({ exchange: 'BałtykEx', rule: 'D1' })]);
    expect(btc.offRamps[0].sweeps).toHaveLength(2);
    // the same exchange is reached from the Ethereum address through a labelled deposit address
    expect(s.chain.activity.find((x) => x.address === wallet('eth'))!.offRamps).toEqual([expect.objectContaining({ exchange: 'BałtykEx', rule: 'L1' })]);
  });

  it('estimates the value in złoty with real NBP tables and leaves weak links out', () => {
    const e = s.estimate!;
    expect(e.years.map((y) => y.year)).toEqual([2024, 2025]);
    expect(e.unvalued).toBe(0);
    expect(e.addresses.map((a) => a.address).sort()).toEqual([wallet('btc-segwit'), wallet('btc-segwit', 'sales'), wallet('btc-legacy'), wallet('eth'), wallet('tron'), wallet('tron', 'alt')].sort());
    expect(e.addresses.find((a) => a.address === wallet('eth'))!.walletSize).toBe(2);
    expect(e.addresses.find((a) => a.address === wallet('btc-segwit'))!.walletSize).toBe(6);
    const namesake = world.personas.find((p) => p.id === NAMESAKE_ID)!;
    expect(e.leftOut).toEqual([expect.objectContaining({ address: namesake.wallets[0].address, score: 39 })]);

    // the payment-gateway transfer of 22 April 2025: the day before was Easter Monday, so the table is from Friday the 18th
    const gateway = e.transfers.find((t) => t.channel === 'payment_gateway')!;
    const table = NBP.rates.filter((r) => r.d < '2025-04-22').at(-1)!;
    expect(table.d).toBe('2025-04-18');
    expect(gateway.rate).toEqual({ mid: table.mid, table: table.no, effectiveDate: '2025-04-18' });
    expect(gateway.valuePln).toBeCloseTo(0.08 * priceUsd('BTC', '2025-04-22')! * table.mid, 1);
    expect(gateway).toMatchObject({ certainty: 'probable', taxYear: 2025 });

    // swaps between crypto assets are not counted; stablecoins are taken at 1 USD
    expect(e.transfers.some((t) => t.channel === 'stablecoin_swap')).toBe(false);
    expect(e.transfers.find((t) => t.asset === 'USDT' && t.channel === 'card')!.priceUsd).toBe(1);
    const sum = e.transfers.reduce((n, t) => n + t.valuePln!, 0);
    expect(Math.abs(e.totalPln - sum)).toBeLessThan(2);
    expect(e.years.every((y) => y.probablePln + y.possiblePln === y.totalPln || Math.abs(y.probablePln + y.possiblePln - y.totalPln) <= 1)).toBe(true);
  });

  it('re-scores a stored run with changed rules and keeps both results', async () => {
    const changed = { ...DEFAULT_RULESET, version: '1.0.1-test', placements: { ...DEFAULT_RULESET.placements, own_profile: { ...DEFAULT_RULESET.placements.own_profile, base: 70 } } };
    const again = await reassessRun(store, s.runId, changed);
    expect(linkOf(again, wallet('btc-segwit'))).toMatchObject({ score: 85, band: 'very_high' });
    expect(again.assessment!.ruleset.version).toBe('1.0.1-test');
    const stored = await db.query<{ n: string }>('SELECT count(*) AS n FROM assessments WHERE run_id = $1', [s.runId]);
    expect(Number(stored.rows[0].n)).toBe(2);
  });
});

describe('other entry points', () => {
  it('entered name: two unrelated people, both capped until a second trace is added', async () => {
    const s = await analyze('full_name', 'Cezary Baryka');
    expect(s.assessment!.clusters.map((c) => c.level)).toEqual(['name_ambiguous', 'name_ambiguous']);
    expect(Math.max(...s.assessment!.links.map((l) => l.score))).toBe(39);
  });

  it('entered address: names the account that published it', async () => {
    const s = await analyze('crypto_address', wallet('tron'), { maxDepth: 0 });
    expect(s.assessment!.clusters).toHaveLength(1);
    expect(s.assessment!.clusters[0]).toMatchObject({ level: 'publisher' });
    expect(linkOf(s, wallet('tron'))).toMatchObject({ status: 'attributed', score: 65, band: 'probable' });
  });
});

describe('acceptance scenarios: every background persona, checked against ground truth', () => {
  const PLACEMENT: Record<Placement['where'], string> = {
    profile: 'own_profile', signature: 'own_profile', repo: 'own_profile', ad: 'sale', discussion: 'discussion', giveaway: 'mass_comment', quote: 'quoted',
  };
  const background = world.personas.filter((p) => p.id !== HERO_ID && p.id !== NAMESAKE_ID);

  it('classifies every found placement as the ground truth says', async () => {
    let checked = 0;
    let viaImage = 0;
    let variantClusters = 0;
    const proofRules = new Set<string>();
    const seen = new Set<string>();
    for (const p of background) {
      const s = await analyze('username', p.handles.forum!, { pivotOnAddresses: false });
      expect(s.status, p.id).toBe('completed');
      variantClusters += s.assessment!.clusters.filter((c) => c.level === 'handle_variant' && c.identityCap === 79).length;
      const subject = s.assessment!.clusters.find((c) => c.level === 'entered');
      if (!subject) continue;
      const links = s.assessment!.links.filter((l) => l.clusterId === subject.id);
      for (const t of world.truth.filter((x) => x.postedBy === p.id)) {
        const url = running.bases[t.site] + t.path;
        const link = links.find((l) => l.address === t.address && l.occurrences.some((o) => o.url === url));
        if (!link) continue; // placed on an account this nick does not lead to
        const occ = link.occurrences.filter((o) => o.url === url);
        expect(occ.map((o) => o.placement), `${p.id} ${t.where} ${url}`).toContain(PLACEMENT[t.where]);
        if (t.expected === 'excluded') expect(link.status, `${p.id} ${t.entity?.name}`).toBe('excluded');
        if (t.obfuscated) expect(occ.some((o) => o.method === 'joined')).toBe(true);
        if (t.viaImage) {
          expect(occ.some((o) => o.method === 'qr' && o.image)).toBe(true);
          viaImage++;
        }
        const proof = world.proofs.find((x) => x.personaId === p.id && x.address === t.address);
        if (proof && t.path.includes(`post-${proof.postId}`)) {
          const rule = link.receipt.find((r) => r.rule.startsWith('C'))?.rule;
          expect(rule, `${p.id} proof`).toBe(!proof.valid ? 'C0' : proof.namesAccount ? 'C1' : 'C2');
          proofRules.add(rule!);
        }
        seen.add(t.expected);
        checked++;
      }
      // nothing labelled as an institution or contract is ever attributed to a person
      for (const l of links) if (world.chain.entities.some((e) => e.address === l.address)) expect(l.status).toBe('excluded');
    }
    expect(checked).toBeGreaterThan(40);
    expect(viaImage).toBeGreaterThan(1);
    expect([...proofRules].sort()).toEqual(['C0', 'C2']); // a forged signature and a genuine one that names no account
    expect(variantClusters).toBeGreaterThan(0); // some accounts are reached only through another spelling of the nick
    expect([...seen].sort()).toEqual(['excluded', 'medium', 'noise', 'not_attributable', 'probable', 'very_high']);
  }, 120_000);

  it('keeps a private address with an EIP-7702 delegation attributed', async () => {
    const delegated = Object.entries(world.chain.codes).find(([, code]) => code.startsWith('0xef0100'))!;
    const owner = world.personas.find((p) => p.wallets.some((w) => w.address === delegated[0]))!;
    const s = await analyze('username', owner.handles.forum!);
    const l = s.assessment!.links.find((x) => x.address === delegated[0]);
    if (!l) return; // profile not reachable from the forum nick in this seed
    expect(l.status).toBe('attributed');
    expect(rules(l)).toContain('K1');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNbpConnector, createWorldArchiveConnector, createWorldChainConnector, createWorldConnectors, createWorldNameService, createWorldPriceConnector } from '@olcys/connectors';
import { emailHashes, makeIdentifier, sshKeyFingerprint, type IdentifierKind, type SourceConnector } from '@olcys/core';
import { Store, migrate, openDatabase, type SqlExecutor } from '@olcys/db';
import type { Link } from '@olcys/scoring';
import { HERO_ID, generateWorld, skarbonkaAddress, startWorld, type RunningWorld } from '@olcys/world';
import { runAnalysis, type EngineDeps, type RunSummary } from '../src';

const world = generateWorld();
const hero = world.personas.find((p) => p.id === HERO_ID)!;
const deployer = hero.wallets.find((w) => w.label === 'deployer')!.address;
const contract = skarbonkaAddress(world.seed);
const krk = world.personas.find((p) => p.id === 'krk')!;
const friend = world.personas.find((p) => p.id === 'kolega')!.wallets[0].address;

let running: RunningWorld;
let db: SqlExecutor;
let store: Store;
let deps: EngineDeps;

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

const analyze = async (kind: IdentifierKind, value: string, d: EngineDeps = deps) => runAnalysis(d, (await store.createCase(value, [makeIdentifier(kind, value)])).id);
const linkOf = (s: RunSummary, address: string, clusterId = 'T1') => s.assessment!.links.find((l) => l.address === address && l.clusterId === clusterId)!;
const rules = (l: Link) => l.receipt.map((r) => r.rule);
const clusterOf = (s: RunSummary, handle: string) => s.assessment!.clusters.find((c) => c.accounts.some((a) => a.handle === handle))!;

describe('signals that need no blockchain: similar nicks, avatar hashes, public keys', () => {
  let s: RunSummary;
  beforeAll(async () => {
    s = await analyze('username', 'szklane_domy');
  });

  it('reads a nick with a suffix as a candidate, and confirms it by what the profile gives away', () => {
    expect(s.identifiers.filter((i) => i.origin === 'similar').map((i) => i.value).sort()).toEqual(['szklanedomy-krk', 'szklanedomy-labs']);
    const subject = clusterOf(s, 'szklanedomy-labs');
    expect(subject).toMatchObject({ id: 'T1', level: 'entered' });

    // the avatar address carries the hash of the e-mail his main account lists; the work account shows no e-mail itself
    const byHash = subject.joins.find((j) => j.rule === 'J8')!;
    expect(byHash.detail).toContain(emailHashes(hero.email).md5.slice(0, 12));
    expect(byHash.detail).toContain(hero.email);
    expect(subject.identifiers.filter((i) => i.kind === 'email').map((i) => i.value)).toEqual([hero.email]);
    // and both accounts uploaded the same SSH key
    const key = world.code.users.find((u) => u.handle === 'szklanedomy')!.sshKeys![0];
    expect(subject.joins.find((j) => j.rule === 'J9')!.detail).toContain(sshKeyFingerprint(key)!.slice(0, 20));
  });

  it('keeps a look-alike account apart when nothing confirms it', () => {
    const other = clusterOf(s, 'szklanedomy-krk');
    expect(other).toMatchObject({ level: 'handle_similar', identityCap: 49 });
    expect(other.accounts).toHaveLength(1);
    expect(other.identityNote).toContain('skrót adresu e-mail w adresie awatara, klucz publiczny SSH');
    const l = linkOf(s, krk.wallets[0].address, other.id);
    expect(l).toMatchObject({ status: 'attributed', score: 49, band: 'medium' });
    expect(l.receipt.at(-1)).toMatchObject({ rule: 'T1', effect: 'cap', points: 49 });
    // never among the subject's addresses, never in the estimate
    expect(s.assessment!.links.some((x) => x.address === krk.wallets[0].address && x.clusterId === 'T1')).toBe(false);
    expect(s.estimate!.addresses.map((a) => a.address)).not.toContain(krk.wallets[0].address);
  });

  it('without those fingerprints the work account stays a candidate too', async () => {
    const blind: SourceConnector[] = deps.connectors.map((c) => ({
      ...c,
      search: async function* (id, ctx) {
        for await (const item of c.search(id, ctx)) yield { ...item, fingerprints: [] };
      },
    }));
    const b = await analyze('username', 'szklane_domy', { ...deps, connectors: blind });
    expect(clusterOf(b, 'szklanedomy-labs')).toMatchObject({ level: 'handle_similar', identityCap: 49 });
    expect(clusterOf(b, 'szklane_domy').accounts.map((a) => a.handle)).not.toContain('szklanedomy-labs');
    // so the address behind his contract is not counted as his
    expect(linkOf(b, deployer)).toBeUndefined();
    expect(b.estimate!.addresses.map((a) => a.address)).not.toContain(deployer);
    expect(b.estimate!.totalPln).toBeLessThan(s.estimate!.totalPln);
  });
});

describe('contract deployer', () => {
  it('from a contract in his repository to the address that created it', async () => {
    const s = await analyze('username', 'szklane_domy');
    // the contract itself is not a wallet
    const c = linkOf(s, contract);
    expect(c).toMatchObject({ status: 'excluded' });
    expect(rules(c)).toEqual(['X2', 'F1']);
    expect(c.receipt[1].detail).toContain(`${deployer.slice(0, 10)}…`);

    // the address that created it was never published; it enters through the contract, limited to 70%
    expect(s.addresses.some((a) => a.address === deployer)).toBe(false);
    const l = linkOf(s, deployer);
    expect(l).toMatchObject({ status: 'attributed', score: 70, band: 'probable' });
    expect(rules(l)).toEqual(['P1', 'K3']);
    expect(l.receipt[1]).toMatchObject({ effect: 'cap', points: 70 });
    expect(l.receipt[1].detail).toContain('2025-03-04');
    expect(l.occurrences).toEqual([expect.objectContaining({ method: 'deployer', raw: contract, url: `${running.bases.code}/szklanedomy-labs/skarbonka` })]);
    expect(l.challenges.map((x) => x.text).join(' ')).toContain('współpracownik');

    // its money went to a P2P escrow, and that enters the estimate
    const a = s.chain.activity.find((x) => x.address === deployer)!;
    expect(a.indicators.map((i) => i.type)).toEqual(['p2p']);
    expect(a.indicators[0].totals).toEqual([{ asset: 'ETH', amount: 3.1 }]);
    expect(s.estimate!.addresses.find((x) => x.address === deployer)).toMatchObject({ score: 70 });
    expect(s.estimate!.transfers.filter((t) => t.from === deployer)).toHaveLength(2);
  });

  it('from an address to whoever shows its contract as their own', async () => {
    const s = await analyze('crypto_address', deployer);
    expect(s.status).toBe('completed');
    const c = s.assessment!.clusters[0];
    expect(c).toMatchObject({ level: 'publisher', identityCap: 100 });
    expect(c.accounts.map((a) => a.handle)).toEqual(['szklanedomy-labs']);
    expect(c.identityNote).toContain('utworzono z wprowadzonego adresu');
    expect(linkOf(s, deployer)).toMatchObject({ status: 'attributed', score: 70 });
    // the account was then read in full
    expect(s.addresses.find((a) => a.address === contract)!.occurrences.some((o) => o.url.endsWith('/szklanedomy-labs/skarbonka'))).toBe(true);
  });
});

describe('daily rhythm', () => {
  it('finds the hours the person is never active and checks every address against them', async () => {
    const s = await analyze('username', 'szklane_domy');
    const r = clusterOf(s, 'szklane_domy').rhythm!;
    expect(r.verdict).toBe('consistent');
    expect(r.quiet).toMatchObject({ from: 0, to: 7, webInside: 0 });
    expect(r.webCount).toBeGreaterThanOrEqual(15);
    expect(r.chainCount).toBeGreaterThanOrEqual(15);
    expect(r.chainInQuiet).toBe(0);
    expect(r.chance).toBeLessThan(0.01);
    expect(r.web.reduce((a, b) => a + b, 0)).toBe(r.webCount);

    // the address of a friend overseas, which he once posted: its transfers leave in the middle of the Polish night
    expect(r.conflicting).toEqual([expect.objectContaining({ chain: 'bitcoin', address: friend, transfers: 7, inQuiet: 7 })]);
    expect(r.conflicting[0].hours!.reduce((a, b) => a + b, 0)).toBe(7);
    const l = linkOf(s, friend);
    expect(rules(l)).toEqual(['P3', 'R2']);
    expect(l).toMatchObject({ status: 'attributed', score: 35, band: 'noise' });
    expect(l.receipt[1]).toMatchObject({ effect: 'penalty', points: 10 });
    expect(l.challenges[0]).toMatchObject({ weight: 'duże' });
    expect(s.estimate!.leftOut.find((x) => x.address === friend)).toMatchObject({ score: 35 });
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorldArchiveConnector, createWorldChainConnector, createWorldConnectors } from '@olcys/connectors';
import { makeIdentifier } from '@olcys/core';
import { Store, migrate, openDatabase, type SqlExecutor } from '@olcys/db';
import { HERO_ID, NAMESAKE_ID, generateWorld, startWorld, type RunningWorld } from '@olcys/world';
import { runAnalysis } from '../src';

const world = generateWorld();
const hero = world.personas.find((p) => p.id === HERO_ID)!;
const heroTruth = world.truth.filter((p) => p.postedBy === HERO_ID);

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
  const archive = createWorldArchiveConnector(running.bases.archive);
  deps = { store, connectors, chain, archive, allowlist: [...connectors, ...chain, archive].flatMap((c) => c.descriptor.hosts) };
});

afterAll(async () => {
  await running.close();
  await db.close();
});

describe('end-to-end run on the synthetic world', () => {
  it('starts from one forum nick and finds every address the subject published', async () => {
    const c = await store.createCase('hero', [makeIdentifier('username', 'szklane_domy')]);
    const s = await runAnalysis(deps, c.id);
    expect(s.status).toBe('completed');

    const found = new Map(s.addresses.map((a) => [a.address, a]));
    for (const t of heroTruth) {
      const f = found.get(t.address);
      expect(f, `${t.where} ${t.address}`).toBeDefined();
      // an address that is gone from the live page is found in the archived copy of that page
      expect(f!.occurrences.some((o) => (t.archivedOnly ? o.url.endsWith(running.bases[t.site] + t.path) && o.url !== running.bases[t.site] + t.path : o.url === running.bases[t.site] + t.path)), `${t.where} at ${t.path}`).toBe(true);
    }

    // leads followed across sites: forum → code profile → e-mail → ad board → phone
    const leads = s.identifiers.map((i) => `${i.kind}:${i.value}`);
    expect(leads).toContain(`email:${hero.email}`);
    expect(leads).toContain(`phone:${hero.phone}`);
    expect(leads).toContain('full_name:Cezary Baryka');

    const btc = found.get(hero.wallets.find((w) => w.kind === 'btc-segwit')!.address)!;
    expect(btc.origins.sort()).toEqual(['bitrozmowy', 'kodownia']);
    expect(btc.occurrences.map((o) => o.segment_kind)).toEqual(expect.arrayContaining(['signature', 'readme']));

    const tron = found.get(hero.wallets.find((w) => w.kind === 'tron')!.address)!;
    expect(tron.origins.sort()).toEqual(['bazarek', 'bitrozmowy']);
    expect(tron.occurrences.find((o) => o.origin === 'bitrozmowy')).toMatchObject({ method: 'joined', obfuscation: ['split'] });

    // the ETH address on the code profile exists only inside a link target
    const eth = found.get(hero.wallets.find((w) => w.kind === 'eth')!.address)!;
    expect(eth.occurrences.some((o) => o.segment_kind === 'link' && o.doc_type === 'profile')).toBe(true);

    // an address the subject merely quoted is kept apart from his own words
    const quoted = heroTruth.find((t) => t.where === 'quote')!;
    expect(found.get(quoted.address)!.occurrences.some((o) => o.segment_kind === 'quote' && o.quoted_author)).toBe(true);

    // the namesake surfaces through the name lead and stays a separate account
    const namesake = world.personas.find((p) => p.id === NAMESAKE_ID)!;
    expect(found.get(namesake.wallets[0].address)!.occurrences.every((o) => o.author_handle === 'czarek_b')).toBe(true);

    // every occurrence carries its provenance
    for (const o of s.addresses.flatMap((a) => a.occurrences)) {
      expect(o.url).toMatch(/^http/);
      expect(o.snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Date.parse(o.fetched_at)).not.toBeNaN();
    }
  });

  it('answers the reverse question: who published this address?', async () => {
    const tron = hero.wallets.find((w) => w.kind === 'tron')!.address;
    const c = await store.createCase('reverse', [makeIdentifier('crypto_address', tron)]);
    const s = await runAnalysis(deps, c.id, { maxDepth: 0 });
    const authors = new Set(s.addresses.find((a) => a.address === tron)!.occurrences.map((o) => o.author_handle));
    expect(authors).toEqual(new Set(['SzklaneDomy']));
    expect(s.addresses.find((a) => a.address === tron)!.occurrences.every((o) => o.relation === 'mention')).toBe(true);
  });

  it('keeps a tamper-evident record of everything it fetched', async () => {
    const c = await store.createCase('vault', [makeIdentifier('username', 'szklane_domy')]);
    const s = await runAnalysis(deps, c.id, { maxDepth: 1, pivotOnAddresses: false });
    const before = await store.verifyEvidence(s.runId);
    expect(before).toMatchObject({ ok: true, broken: [] });
    expect(before.checked).toBe(s.counts.snapshots);

    const victim = (await store.snapshots(s.runId))[1];
    await db.query('UPDATE snapshots SET url = $2 WHERE id = $1', [victim.id, victim.url + '?edited']);
    const after = await store.verifyEvidence(s.runId);
    expect(after.ok).toBe(false);
    expect(after.broken).toContain(victim.seq);
  });

  it('refuses hosts that are not on the allowlist and records the attempt', async () => {
    const c = await store.createCase('egress', [makeIdentifier('email', hero.email)]);
    const adsHost = new URL(running.bases.ads).host;
    const s = await runAnalysis({ ...deps, allowlist: deps.allowlist.filter((h) => h !== adsHost) }, c.id, { maxDepth: 0 });
    expect(s.status).toBe('completed');
    expect(s.counts.denied).toBeGreaterThan(0);
    const log = await store.egressLog(s.runId);
    expect(log.filter((e) => !e.allowed).every((e) => e.host === adsHost)).toBe(true);
    expect(log.some((e) => e.allowed && e.host === new URL(running.bases.code).host)).toBe(true);
  });
});

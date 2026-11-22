import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNbpConnector, createWorldArchiveConnector, createWorldChainConnector, createWorldConnectors, createWorldNameService, createWorldPriceConnector } from '@olcys/connectors';
import { makeIdentifier } from '@olcys/core';
import { Store, migrate, openDatabase, type SqlExecutor } from '@olcys/db';
import { runAnalysis, type RunSummary } from '@olcys/engine';
import { HERO_ID, generateWorld, startWorld, type RunningWorld } from '@olcys/world';
import { renderReport } from '../src';

const world = generateWorld();
const hero = world.personas.find((p) => p.id === HERO_ID)!;
let running: RunningWorld;
let db: SqlExecutor;
let html: string;
let summary: RunSummary;

beforeAll(async () => {
  running = await startWorld(world);
  db = await openDatabase('pglite://memory');
  await migrate(db);
  const store = new Store(db);
  const connectors = createWorldConnectors(running.bases);
  const chain = [createWorldChainConnector(running.bases.explorer)];
  const rates = createNbpConnector(running.bases.rates, true);
  const prices = createWorldPriceConnector(running.bases.rates);
  const seeds = [makeIdentifier('username', 'szklane_domy')];
  const c = await store.createCase('szklane_domy', seeds);
  const archive = createWorldArchiveConnector(running.bases.archive);
  summary = await runAnalysis({ store, connectors, chain, rates, prices, archive, names: createWorldNameService(running.bases.explorer), allowlist: [...connectors, ...chain, rates, prices, archive].flatMap((x) => x.descriptor.hosts) }, c.id);
  const run = (await store.getRun(summary.runId))!;
  html = renderReport({
    summary: JSON.parse(JSON.stringify(summary)),
    caseTitle: 'szklane_domy',
    seeds,
    startedAt: new Date(run.started_at).toISOString(),
    generatedAt: '2026-11-21T16:00:00.000Z',
    snapshots: await store.snapshots(summary.runId),
    verification: await store.verifyEvidence(summary.runId),
    transfers: await store.transfers(summary.runId),
    sources: (run.params as { connectors: { id: string; name: string; hosts: string[]; synthetic?: boolean }[] }).connectors,
  });
});
afterAll(async () => {
  await running.close();
  await db.close();
});

describe('OSINT report', () => {
  it('contains every part the brief asks for', () => {
    for (const heading of [
      'Podsumowanie', 'Osoba i jej konta w sieci', 'Adresy powiązane z osobą', 'Odrzucone przypisania', 'Aktywność w łańcuchu bloków',
      'Zmiany na profilach w czasie', 'Szacunek wartości w złotych', 'Chronologiczny przebieg przepływu środków', 'Projekty zapytań', 'Źródła i odtwarzalność', 'Słowniczek',
    ]) expect(html, heading).toContain(heading);
    // the report follows the order of the analysis: input, traces, addresses, rejections, blockchain, conclusion, sources
    const order = ['Wejście i parametry wyszukiwania', 'Osoba i jej konta w sieci', 'Adresy powiązane z osobą', 'Odrzucone przypisania', 'Aktywność w łańcuchu bloków', 'Chronologiczny przebieg przepływu środków', 'Szacunek wartości w złotych', 'Projekty zapytań', 'Źródła i odtwarzalność'];
    const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
    const at = order.map((h) => headings.findIndex((x) => x.includes(h)));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // the three kinds of statement are explained and used
    for (const kind of ['fakt źródłowy', 'wynik obliczeń', 'wniosek do weryfikacji']) expect(html.split(kind).length).toBeGreaterThan(3);
  });

  it('carries sources, scores, the wallet, the exchange and real NBP tables', () => {
    for (const w of hero.wallets) expect(html).toContain(w.address);
    for (const text of ['Dowód kryptograficzny', 'Co może podważyć ten wynik', 'kod QR na zdjęciu', 'wersja archiwalna z 2024-09-20', 'został na profilu zastąpiony adresem']) expect(html, text).toContain(text);
    for (const m of world.chain.wallets[0].members) expect(html).toContain(m);
    for (const text of ['Synergia śladów', 'Binance: Hot Wallet 14', 'Do tej samej osoby należy 6 adresów', 'Adresat: BałtykEx', '/A/NBP/2025', 'danych syntetycznych', 'Magazyn dowodów jest nienaruszony']) {
      expect(html, text).toContain(text);
    }
    // every stored snapshot is listed with its full hash
    const hashes = html.match(/[0-9a-f]{64}/g) ?? [];
    expect(new Set(hashes).size).toBeGreaterThanOrEqual(summary.counts.snapshots - 5);
  });

  it('is one self-contained document: no scripts and nothing loaded from elsewhere', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link[^>]+href/i);
    expect(html).not.toMatch(/url\((?!data:)/);
    expect(html).toContain('@font-face');
  });
});

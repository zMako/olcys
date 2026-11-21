import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNbpConnector, createWorldArchiveConnector, createWorldChainConnector, createWorldConnectors, createWorldNameService, createWorldPriceConnector } from '@olcys/connectors';
import { BUNDLED_LABELS, makeIdentifier } from '@olcys/core';
import { Store, migrate, openDatabase, type SqlExecutor } from '@olcys/db';
import { HERO_ID, generateWorld, makeWallet, startWorld, type RunningWorld } from '@olcys/world';
import { diffRuns, runAnalysis, startScheduler, type EngineDeps } from '../src';

const world = generateWorld();
const hero = world.personas.find((p) => p.id === HERO_ID)!;
const fresh = makeWallet('recurring', 'btc-segwit', 'new-on-profile').address;
const dropped = makeWallet('recurring', 'eth', 'new-in-post').address;
const kraken = BUNDLED_LABELS[2];

let running: RunningWorld;
let db: SqlExecutor;
let store: Store;
let deps: EngineDeps;
let caseId: string;

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

/** Does what a person would do in the browser: submits a form on the demo forum. */
const submit = async (path: string, fields: Record<string, string>) => {
  const res = await fetch(running.bases.forum + path, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual' });
  expect(res.status).toBe(303);
  return res.headers.get('location')!;
};

describe('repeated analyses of one case', () => {
  it('keeps one case for the same identifiers and a separate one for other sources', async () => {
    const seeds = [makeIdentifier('username', 'szklane_domy')];
    const a = await store.findOrCreateCase('szklane_domy', seeds, 'synthetic');
    const b = await store.findOrCreateCase('again', seeds, 'synthetic');
    const c = await store.findOrCreateCase('live', seeds, 'live');
    expect([a.created, b.created, c.created]).toEqual([true, false, true]);
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    caseId = a.id;
  });

  it('reports no change when nothing changed', async () => {
    const first = await runAnalysis(deps, caseId);
    expect(await diffRuns(store, first.runId)).toBeUndefined(); // nothing to compare with yet
    const second = await runAnalysis(deps, caseId);
    const diff = (await diffRuns(store, second.runId))!;
    expect(diff).toMatchObject({ baseRunId: first.runId, runId: second.runId, changed: false, summary: 'Bez zmian od poprzedniej analizy.' });
    expect(diff.pages).toEqual({ changed: 0, added: 0, gone: 0 });
    // every analysis is kept
    expect((await store.listRuns(caseId)).map((r) => r.status)).toEqual(['completed', 'completed']);
  });

  it('catches what changed on the web between two analyses', async () => {
    const before = (await store.listRuns(caseId)).at(-1)!;
    // In the meantime the subject posts a new address, pastes an exchange address, and swaps the address in his signature.
    const where = await submit(`/watek/${world.forum.threads[2].id}/odpowiedz`, { nick: 'szklane_domy', tresc: `Zmieniłem portfel, teraz wysyłajcie na ${dropped}` });
    await submit(`/watek/${world.forum.threads[2].id}/odpowiedz`, { nick: 'szklane_domy', tresc: `Depozyt poszedł na Krakena: ${kraken.address}` });
    await submit('/uzytkownik/szklane_domy/sygnatura', { tresc: `BTC: ${fresh}` });
    expect(where).toMatch(/\/watek\/\d+#post-\d+/);

    const after = await runAnalysis(deps, caseId);
    const diff = (await diffRuns(store, after.runId))!;
    expect(diff.baseRunId).toBe(before.id);
    expect(diff.changed).toBe(true);

    const added = Object.fromEntries(diff.links.filter((l) => l.kind === 'added').map((l) => [l.address, l]));
    expect(added[dropped]).toMatchObject({ after: { status: 'attributed', score: 45, band: 'medium' } });
    expect(added[dropped].text).toContain('dyskusja na forum');
    expect(added[kraken.address].after!.status).toBe('excluded');
    expect(added[kraken.address].text).toContain('odrzucony: Kraken');
    expect(added[fresh]).toMatchObject({ after: { status: 'attributed', score: 85 } });

    // the swap on the profile is reported as such: the optional criterion of the brief
    const main = hero.wallets.find((w) => w.kind === 'btc-segwit')!.address;
    expect(diff.profiles).toEqual([expect.objectContaining({ kind: 'swap', handle: 'szklane_domy', from: main, to: fresh })]);
    expect(diff.profiles[0].text).toContain('został zastąpiony adresem');
    // the old address stays the person's: it is still on his other profile and in the archive
    expect(diff.links.some((l) => l.address === main && l.kind === 'removed')).toBe(false);
    expect(diff.pages.changed).toBeGreaterThan(0);
    expect(diff.summary).toMatch(/^Od poprzedniej analizy: 3 nowe adresy, .*1 zmiana na profilu/);

    // any two analyses can be compared, not only neighbours
    const first = (await store.listRuns(caseId))[0];
    expect((await diffRuns(store, after.runId, first.id))!.links.filter((l) => l.kind === 'added')).toHaveLength(3);
    // compared the other way round, the same addresses are reported as gone
    const back = (await diffRuns(store, first.id, after.runId))!;
    expect(back.links.filter((l) => l.kind === 'removed').map((l) => l.address).sort()).toEqual([dropped, fresh, kraken.address].sort());
    expect(back.links.find((l) => l.address === dropped)!.text).toContain('nie ma już w źródłach (poprzednio 45%)');
    expect(back.profiles).toEqual([expect.objectContaining({ kind: 'swap', from: fresh, to: main })]);
    // the list of analyses carries each one's note
    const notes = await store.changeNotes(caseId);
    expect(notes.get(after.runId)).toMatchObject({ changed: true });
    expect(notes.get(before.id)).toEqual({ changed: false, summary: 'Bez zmian od poprzedniej analizy.' });
    expect(notes.has(first.id)).toBe(false);
    // the run itself announces the change to the interface
    const event = (await store.events<{ changed: boolean; added: { address: string }[] }>(after.runId)).find((e) => e.type === 'diff')!;
    expect(event.changed).toBe(true);
    expect(event.added.map((x) => x.address).sort()).toEqual([dropped, fresh, kraken.address].sort());
  });

  it('runs a case again on its schedule, once per slot and never twice at once', async () => {
    const count = async () => (await store.listRuns(caseId)).length;
    const n = await count();
    const scheduler = startScheduler({ store, depsFor: () => deps, intervalMs: 60_000 });
    try {
      await store.setSchedule(caseId, 3600);
      expect(await scheduler.tick()).toEqual([]); // not due yet
      await db.query("UPDATE case_schedules SET next_run_at = $2 WHERE case_id = $1", [caseId, new Date(Date.now() - 1000).toISOString()]);
      const started = await scheduler.tick();
      expect(started).toHaveLength(1);
      expect(await scheduler.tick()).toEqual([]); // the slot was taken; the next one is an hour away
      for (let i = 0; i < 200 && (await store.getRun(started[0]))!.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
      const run = (await store.getRun(started[0]))!;
      expect(run).toMatchObject({ status: 'completed', trigger: 'schedule' });
      expect(await count()).toBe(n + 1);
      expect((await diffRuns(store, run.id))!.changed).toBe(false);

      await store.setSchedule(caseId, null);
      expect(await store.schedule(caseId)).toBeUndefined();
    } finally {
      scheduler.stop();
    }
  }, 30_000);
});

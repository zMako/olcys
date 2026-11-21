import Fastify from 'fastify';
import { z } from 'zod';
import { guessIdentifier, makeIdentifier } from '@olcys/core';
import { beginRun, diffRuns, reassessRun, startScheduler, summarizeRun } from '@olcys/engine';
import { caseFacts, renderReport } from '@olcys/report';
import { StatementReader, createOllamaClient, llmAvailable, narrate, readWithLlm } from '@olcys/reader';
import { DEFAULT_RULESET, type Ruleset } from '@olcys/scoring';
import { loadRuntime } from './config';

const Mode = z.enum(['synthetic', 'live']).optional();
const IdentifierInput = z.union([
  z.string().min(1),
  z.object({
    kind: z.enum(['full_name', 'username', 'email', 'phone', 'messenger_id', 'profile_url', 'crypto_address']),
    value: z.string().min(1),
  }),
]);
const CreateCase = z.object({ title: z.string().min(1).optional(), identifiers: z.array(IdentifierInput).min(1) });
const StartRun = z.object({ maxDepth: z.number().int().min(0).max(6).optional(), pivotOnAddresses: z.boolean().optional() }).default({});
const Sources = z.object({ sources: Mode });

const rt = await loadRuntime();
// The reader of posts: a classifier trained on real posts, running here. Loaded on first use (the model takes a few seconds).
let readerLoading: Promise<StatementReader | undefined> | undefined;
const reader = {
  triage: async (posts: Parameters<StatementReader['triage']>[0], opts?: Parameters<StatementReader['triage']>[1]) => {
    const r = await (readerLoading ??= StatementReader.load().catch(() => undefined));
    return r ? r.triage(posts, opts) : { posts: posts.length, generated: 0, read: 0, statements: [] };
  },
};
// The language model: a second reader and the author of the case description. Served locally; swappable through LLM_URL and LLM_MODEL.
const llm = createOllamaClient();

/** Engine dependencies for the chosen set of sources. */
const depsFor = (mode?: 'synthetic' | 'live') => ({ store: rt.store, ...rt.sets[mode ?? rt.defaultMode], reader: process.env.READER === 'off' ? undefined : reader, log: (m: string) => app.log.debug(m) });
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_request', issues: err.issues });
  app.log.error(err);
  return reply.status(500).send({ error: 'internal_error' });
});

app.get('/health', async () => ({ ok: true }));

app.get('/api/sources', async () => ({
  default: rt.defaultMode,
  sets: Object.fromEntries(
    Object.entries(rt.sets).map(([mode, s]) => [
      mode,
      { allowlist: s.allowlist, sources: [...s.connectors, ...s.chain, s.rates, s.prices, s.archive, s.names].map((c) => ({ id: c.id, name: c.descriptor.name, hosts: c.descriptor.hosts })) },
    ]),
  ),
}));

app.get('/api/cases', async () => rt.store.listCases());

app.post('/api/cases', async (req, reply) => {
  const body = CreateCase.parse(req.body);
  const identifiers = body.identifiers.map((i) => (typeof i === 'string' ? guessIdentifier(i) : makeIdentifier(i.kind, i.value)));
  const c = await rt.store.createCase(body.title ?? identifiers.map((i) => i.value).join(', '), identifiers);
  return reply.status(201).send({ ...c, identifiers });
});

app.get<{ Params: { id: string } }>('/api/cases/:id', async (req, reply) => {
  const c = await rt.store.getCase(req.params.id);
  if (!c) return reply.status(404).send({ error: 'not_found' });
  const schedule = await rt.store.schedule(c.id);
  const notes = await rt.store.changeNotes(c.id);
  const runs = (await rt.store.listRuns(c.id)).map((r) => ({
    id: r.id, status: r.status, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at, stats: r.stats,
    /** What this analysis found changed since the one before it; null for the first one. */
    changes: notes.get(r.id) ?? null,
  }));
  return { ...c, identifiers: await rt.store.caseIdentifiers(c.id), schedule: schedule ? { everySeconds: schedule.every_seconds, nextRunAt: schedule.next_run_at } : null, runs };
});

// Analyse the case again now. Answers at once with the run id.
app.post<{ Params: { id: string } }>('/api/cases/:id/runs', async (req, reply) => {
  const c = await rt.store.getCase(req.params.id);
  if (!c) return reply.status(404).send({ error: 'not_found' });
  if (await rt.store.hasRunningRun(c.id)) return reply.status(409).send({ error: 'already_running' });
  const body = z.object({ params: StartRun, wait: z.boolean().optional() }).parse(req.body ?? {});
  const run = await beginRun(depsFor(c.sources as 'synthetic' | 'live'), c.id, body.params);
  if (body.wait) return reply.status(201).send(await run.done);
  run.done.catch((err) => app.log.error(err));
  return reply.status(202).send({ caseId: c.id, runId: run.runId });
});

// How often the case is analysed again on its own; null switches repetition off.
app.put<{ Params: { id: string } }>('/api/cases/:id/schedule', async (req, reply) => {
  const c = await rt.store.getCase(req.params.id);
  if (!c) return reply.status(404).send({ error: 'not_found' });
  const { everySeconds } = z.object({ everySeconds: z.number().int().min(15).max(7 * 86_400).nullable() }).parse(req.body);
  await rt.store.setSchedule(c.id, everySeconds);
  const schedule = await rt.store.schedule(c.id);
  return { schedule: schedule ? { everySeconds: schedule.every_seconds, nextRunAt: schedule.next_run_at } : null };
});

// What changed between this analysis and an earlier one of the same case (by default, the one before it).
app.get<{ Params: { id: string }; Querystring: { against?: string } }>('/api/runs/:id/diff', async (req, reply) => {
  if (!(await rt.store.getRun(req.params.id))) return reply.status(404).send({ error: 'not_found' });
  return { diff: (await diffRuns(rt.store, req.params.id, req.query.against)) ?? null };
});

// One call for the UI: open a case for the entered identifiers and start the analysis.
// Answers at once with the run id; the run's progress is read from /api/runs/:id/events.
app.post('/api/analyze', async (req, reply) => {
  const body = CreateCase.extend({ params: StartRun, wait: z.boolean().optional(), sources: Mode }).parse(req.body);
  const identifiers = body.identifiers.map((i) => (typeof i === 'string' ? guessIdentifier(i) : makeIdentifier(i.kind, i.value)));
  // The same identifiers and sources mean the same case: a repeated analysis can then be compared with the earlier ones.
  const mode = body.sources ?? rt.defaultMode;
  const c = await rt.store.findOrCreateCase(body.title ?? identifiers.map((i) => i.value).join(', '), identifiers, mode);
  if (await rt.store.hasRunningRun(c.id)) return reply.status(409).send({ error: 'already_running', caseId: c.id });
  const run = await beginRun(depsFor(mode), c.id, body.params);
  if (body.wait) return reply.status(201).send(await run.done);
  run.done.catch((err) => app.log.error(err));
  return reply.status(202).send({ caseId: c.id, runId: run.runId });
});

app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/runs/:id/events', async (req, reply) => {
  const run = await rt.store.getRun(req.params.id);
  if (!run) return reply.status(404).send({ error: 'not_found' });
  return { status: run.status, events: await rt.store.events(req.params.id, Number(req.query.after ?? 0) || 0) };
});

app.get('/api/ruleset', async () => DEFAULT_RULESET);

// Score a stored run again with changed rules; the earlier result stays in the database.
app.post<{ Params: { id: string } }>('/api/runs/:id/reassess', async (req, reply) => {
  if (!(await rt.store.getRun(req.params.id))) return reply.status(404).send({ error: 'not_found' });
  const ruleset = z.object({ ruleset: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {}).ruleset;
  return reassessRun(rt.store, req.params.id, ruleset ? ({ ...DEFAULT_RULESET, ...ruleset } as Ruleset) : DEFAULT_RULESET);
});

app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
  if (!(await rt.store.getRun(req.params.id))) return reply.status(404).send({ error: 'not_found' });
  return summarizeRun(rt.store, req.params.id);
});

// Is a language model being served, and which one?
app.get('/api/llm', async () => ({ available: await llmAvailable(), model: llm.name }));

// The language model reads the posts the classifier picked out, one by one, and records what it found.
app.post<{ Params: { id: string } }>('/api/runs/:id/read', async (req, reply) => {
  const reading = await rt.store.reading(req.params.id);
  if (!reading) return reply.status(404).send({ error: 'no_reading' });
  if (!(await llmAvailable())) return reply.status(503).send({ error: 'llm_unavailable' });
  for (const s of reading.statements.filter((x) => !x.detail)) {
    const detail = await readWithLlm(llm, { text: s.text, at: s.at });
    if (detail) await rt.store.setStatementDetail(req.params.id, s.documentId, detail);
  }
  return { reading: await rt.store.reading(req.params.id) };
});

// The language model describes the case — from the findings of the run and nothing else.
app.post<{ Params: { id: string } }>('/api/runs/:id/narrative', async (req, reply) => {
  if (!(await rt.store.getRun(req.params.id))) return reply.status(404).send({ error: 'not_found' });
  if (!(await llmAvailable())) return reply.status(503).send({ error: 'llm_unavailable' });
  const facts = caseFacts(await summarizeRun(rt.store, req.params.id));
  const text = await narrate(llm, facts);
  await rt.store.saveNarrative(req.params.id, llm.name, text);
  return { narrative: await rt.store.narrative(req.params.id), facts };
});

app.get<{ Params: { id: string } }>('/api/runs/:id/evidence', async (req, reply) => {
  if (!(await rt.store.getRun(req.params.id))) return reply.status(404).send({ error: 'not_found' });
  return {
    verification: await rt.store.verifyEvidence(req.params.id),
    snapshots: await rt.store.snapshots(req.params.id),
    egress: await rt.store.egressLog(req.params.id),
  };
});

// A stored picture from the evidence vault (e.g. the ad photo an address was read from). Images only.
app.get<{ Params: { id: string; snapshotId: string } }>('/api/runs/:id/snapshots/:snapshotId/image', async (req, reply) => {
  const blob = await rt.store.snapshotBlob(req.params.id, req.params.snapshotId).catch(() => undefined);
  if (!blob || !/^image\/(png|jpeg|gif|webp)$/i.test(blob.contentType.split(';')[0].trim())) return reply.status(404).send({ error: 'not_found' });
  return reply.type(blob.contentType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=3600').send(Buffer.from(blob.body));
});

/** The full OSINT report of a run as one self-contained HTML document. */
async function reportHtml(runId: string): Promise<string | undefined> {
  const run = await rt.store.getRun(runId);
  if (!run) return undefined;
  const c = await rt.store.getCase(run.case_id);
  const params = run.params as { connectors?: { id: string; name: string; hosts: string[]; synthetic?: boolean }[] };
  return renderReport({
    summary: await summarizeRun(rt.store, runId),
    caseTitle: c?.title ?? runId,
    seeds: await rt.store.caseIdentifiers(run.case_id),
    startedAt: new Date(run.started_at).toISOString(),
    generatedAt: new Date().toISOString(),
    snapshots: await rt.store.snapshots(runId),
    verification: await rt.store.verifyEvidence(runId),
    transfers: await rt.store.transfers(runId),
    sources: params.connectors ?? [],
    diff: await diffRuns(rt.store, runId),
  });
}

app.get<{ Params: { id: string } }>('/api/runs/:id/report', async (req, reply) => {
  const html = await reportHtml(req.params.id);
  if (!html) return reply.status(404).send({ error: 'not_found' });
  return reply.type('text/html; charset=utf-8').send(html);
});

// The same report as a PDF, printed by a local headless browser. Nothing leaves the machine.
app.get<{ Params: { id: string } }>('/api/runs/:id/report.pdf', async (req, reply) => {
  const html = await reportHtml(req.params.id);
  if (!html) return reply.status(404).send({ error: 'not_found' });
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  } catch (err) {
    app.log.warn(err);
    return reply.status(501).send({ error: 'pdf_unavailable', hint: 'Brak przeglądarki do wydruku. Uruchom: npx playwright install chromium-headless-shell — albo wydrukuj raport HTML z przeglądarki.' });
  }
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;padding:0 15mm;font-size:7.5pt;color:#5f6b7e;font-family:Georgia,serif;display:flex;justify-content:space-between"><span>OŁCyŚ — raport z analizy ${req.params.id}</span><span>strona <span class="pageNumber"></span> z <span class="totalPages"></span></span></div>`,
      margin: { top: '16mm', bottom: '18mm', left: '15mm', right: '15mm' },
    });
    return reply.type('application/pdf').header('content-disposition', `inline; filename="raport-osint-${req.params.id.slice(0, 8)}.pdf"`).send(pdf);
  } finally {
    await browser.close();
  }
});

// Repeats analyses on their schedules, inside this process.
startScheduler({ store: rt.store, depsFor: (sources) => depsFor(sources as 'synthetic' | 'live'), log: (m) => app.log.warn(m) });

await app.listen({ port: rt.port, host: rt.host });

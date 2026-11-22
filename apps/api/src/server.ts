import Fastify from 'fastify';
import { z } from 'zod';
import { guessIdentifier, knowsIdentity, makeIdentifier } from '@olcys/core';
import { beginRun, diffRuns, reassessRun, startScheduler, summarizeRun } from '@olcys/engine';
import { caseFacts, caseFindings, openLeads, renderReport } from '@olcys/report';
import { StatementReader, createOllamaClient, judgeSamePerson, justifyRequest, llmAvailable, narrate, rankLeads, readWithLlm, writeDossier } from '@olcys/reader';
import { registerRows, registerStats } from '@olcys/corpus';
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
// Analyses cut short by the previous shutdown are marked as such before anything else happens.
const interrupted = await rt.store.closeInterruptedRuns();
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
// The scoring rules in force: the built-in ones, or the ones the analysts last saved.
const savedRules = await rt.store.activeRuleset<Ruleset>();
let rules: Ruleset = savedRules?.body ?? DEFAULT_RULESET;
let ruleChanges = savedRules?.changes ?? [];
const depsFor = (mode?: 'synthetic' | 'live') => ({ store: rt.store, ruleset: rules, ...rt.sets[mode ?? rt.defaultMode], reader: process.env.READER === 'off' ? undefined : reader, log: (m: string) => app.log.debug(m) });
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

/** The few numbers of a run that a list of cases shows. A finished run does not change, so they are kept once computed. */
const headlineCache = new Map<string, { attributed: number; rejected: number; uncertain: number; totalPln: number; exchanges: string[]; attesters: string[]; gaps: number }>();
async function headline(runId: string) {
  const cached = headlineCache.get(runId);
  if (cached) return cached;
  const s = await summarizeRun(rt.store, runId);
  const firm = new Set((s.assessment?.clusters ?? []).filter((c) => c.level === 'entered' || c.level === 'publisher').map((c) => c.id));
  const links = s.assessment?.links ?? [];
  const h = {
    attributed: links.filter((l) => l.status === 'attributed' && firm.has(l.clusterId)).length,
    uncertain: links.filter((l) => l.status === 'attributed' && !firm.has(l.clusterId)).length,
    rejected: links.filter((l) => l.status !== 'attributed').length,
    totalPln: s.estimate?.totalPln ?? 0,
    exchanges: [...new Set(s.chain.activity.flatMap((a) => a.offRamps.map((o) => o.exchange)))],
    attesters: [...new Set((s.attestations ?? []).filter(knowsIdentity).map((a) => a.issuer))],
    gaps: s.gaps?.length ?? 0,
  };
  headlineCache.set(runId, h);
  return h;
}

export const CASE_STATUSES = ['new', 'in_analysis', 'request_sent', 'answered', 'closed'] as const;

// Every case with where it stands and what its latest analysis found: the analyst's desk.
app.get('/api/cases', async () => {
  const out = [];
  for (const c of await rt.store.listCases()) {
    const runs = await rt.store.listRuns(c.id);
    const notes = await rt.store.changeNotes(c.id);
    const schedule = await rt.store.schedule(c.id);
    const last = [...runs].reverse().find((r) => r.status === 'completed');
    out.push({
      id: c.id, title: c.title, sources: c.sources, status: c.status, statusAt: c.status_at, createdAt: c.created_at,
      identifiers: (await rt.store.caseIdentifiers(c.id)).map((i) => ({ kind: i.kind, value: i.value })),
      runs: runs.length, running: runs.some((r) => r.status === 'running'), latestRunId: runs[runs.length - 1]?.id ?? null,
      failed: runs.length > 0 && runs[runs.length - 1].status === 'failed',
      lastRun: last ? { id: last.id, startedAt: last.started_at, changes: notes.get(last.id) ?? null, ...(await headline(last.id)) } : null,
      schedule: schedule ? { everySeconds: schedule.every_seconds, nextRunAt: schedule.next_run_at } : null,
    });
  }
  return out;
});

// Removes a case and everything analysed in it, so it can be started afresh. The removal itself stays in the audit log.
app.delete<{ Params: { id: string } }>('/api/cases/:id', async (req, reply) => {
  const c = await rt.store.getCase(req.params.id);
  if (!c) return reply.status(404).send({ error: 'not_found' });
  if (await rt.store.hasRunningRun(c.id)) return reply.status(409).send({ error: 'already_running' });
  const runs = await rt.store.listRuns(c.id);
  for (const r of runs) headlineCache.delete(r.id);
  await rt.store.deleteCase(c.id);
  await rt.store.audit({ actor: actorOf(req), action: 'case.deleted', detail: { title: c.title, sources: c.sources, analyses: runs.length } });
  return { deleted: true };
});

// The analyst moves a case along: analysed, request sent, answered, closed.
app.put<{ Params: { id: string } }>('/api/cases/:id/status', async (req, reply) => {
  const c = await rt.store.getCase(req.params.id);
  if (!c) return reply.status(404).send({ error: 'not_found' });
  const { status } = z.object({ status: z.enum(CASE_STATUSES) }).parse(req.body);
  await rt.store.setCaseStatus(c.id, status);
  await rt.store.audit({ actor: actorOf(req), action: 'case.status', caseId: c.id, detail: { from: c.status, to: status } });
  return { status };
});

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
  const audit = await rt.store.auditTrail({ caseId: c.id, limit: 30 });
  const runs = (await rt.store.listRuns(c.id)).map((r) => ({
    id: r.id, status: r.status, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at, stats: r.stats,
    /** What this analysis found changed since the one before it; null for the first one. */
    changes: notes.get(r.id) ?? null,
  }));
  return { ...c, identifiers: await rt.store.caseIdentifiers(c.id), schedule: schedule ? { everySeconds: schedule.every_seconds, nextRunAt: schedule.next_run_at } : null, runs, audit };
});

// Analyse the case again now. Answers at once with the run id.
app.post<{ Params: { id: string } }>('/api/cases/:id/runs', async (req, reply) => {
  const c = await rt.store.getCase(req.params.id);
  if (!c) return reply.status(404).send({ error: 'not_found' });
  if (await rt.store.hasRunningRun(c.id)) return reply.status(409).send({ error: 'already_running' });
  const body = z.object({ params: StartRun, wait: z.boolean().optional() }).parse(req.body ?? {});
  const run = await beginRun(depsFor(c.sources as 'synthetic' | 'live'), c.id, body.params);
  await rt.store.audit({ actor: actorOf(req), action: 'analysis.repeated', caseId: c.id, runId: run.runId });
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
  await rt.store.audit({ actor: actorOf(req), action: everySeconds ? 'schedule.set' : 'schedule.cleared', caseId: c.id, detail: everySeconds ? { everySeconds } : {} });
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
  if (c.status === 'new') await rt.store.setCaseStatus(c.id, 'in_analysis');
  await rt.store.audit({ actor: actorOf(req), action: 'analysis.started', caseId: c.id, runId: run.runId, detail: { identifiers: identifiers.map((i) => `${i.kind}: ${i.value}`), sources: mode } });
  if (body.wait) return reply.status(201).send(await run.done);
  run.done.catch((err) => app.log.error(err));
  return reply.status(202).send({ caseId: c.id, runId: run.runId });
});

app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/runs/:id/events', async (req, reply) => {
  const run = await rt.store.getRun(req.params.id);
  if (!run) return reply.status(404).send({ error: 'not_found' });
  return { status: run.status, events: await rt.store.events(req.params.id, Number(req.query.after ?? 0) || 0) };
});

app.get('/api/ruleset', async () => rules);
app.get('/api/rules', async () => ({ ruleset: rules, defaults: DEFAULT_RULESET, changes: ruleChanges }));

/** Reads or sets one number inside the rules by its path, e.g. "placements.sale.base". */
const numberAt = (root: unknown, path: string, set?: number): number | undefined => {
  const keys = path.split('.');
  let at = root as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (!at || typeof at[k] !== 'object') return undefined;
    at = at[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (typeof at?.[last] !== 'number') return undefined;
  if (set !== undefined) at[last] = set;
  return at[last] as number;
};

// The analysts change the numbers of the rules. Only numbers that exist in the built-in rules can be set; the
// result gets its own version, is used by every analysis started afterwards, and the change is written to the audit log.
app.put('/api/rules', async (req) => {
  const { values } = z.object({ values: z.record(z.string(), z.number().finite().min(0).max(1_000_000)) }).parse(req.body);
  const next = structuredClone(DEFAULT_RULESET) as Ruleset;
  const changes: { path: string; from: number; to: number }[] = [];
  for (const [path, to] of Object.entries(values)) {
    const from = numberAt(DEFAULT_RULESET, path);
    if (from === undefined || from === to) continue;
    numberAt(next, path, to);
    changes.push({ path, from, to });
  }
  const saved = ((await rt.store.activeRuleset())?.saved ?? 0) + 1;
  next.version = changes.length ? `${DEFAULT_RULESET.version}-z${saved}` : DEFAULT_RULESET.version;
  next.name = changes.length ? `${DEFAULT_RULESET.name} (zmienione przez analityka)` : DEFAULT_RULESET.name;
  await rt.store.saveRuleset(next.version, next, changes, actorOf(req));
  await rt.store.audit({ actor: actorOf(req), action: changes.length ? 'rules.changed' : 'rules.reset', detail: { version: next.version, changes } });
  rules = next;
  ruleChanges = changes;
  return { ruleset: rules, defaults: DEFAULT_RULESET, changes };
});

// Score a stored run again with changed rules; the earlier result stays in the database.
app.post<{ Params: { id: string } }>('/api/runs/:id/reassess', async (req, reply) => {
  if (!(await rt.store.getRun(req.params.id))) return reply.status(404).send({ error: 'not_found' });
  const ruleset = z.object({ ruleset: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {}).ruleset;
  await rt.store.audit({ actor: actorOf(req), action: 'run.rescored', caseId: await caseOfRun(req.params.id), runId: req.params.id, detail: { changedRules: Object.keys(ruleset ?? {}) } });
  return reassessRun(rt.store, req.params.id, ruleset ? ({ ...rules, ...ruleset } as Ruleset) : rules);
});

app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
  if (!(await rt.store.getRun(req.params.id))) return reply.status(404).send({ error: 'not_found' });
  return summarizeRun(rt.store, req.params.id);
});

/** Who is acting: the analyst named by the client (header x-analyst), or the configured default. No login in this version. */
const actorOf = (req: { headers: Record<string, unknown> }) => String(req.headers['x-analyst'] ?? process.env.ANALYST ?? 'analityk').slice(0, 80);
const caseOfRun = async (runId: string) => (await rt.store.getRun(runId))?.case_id;

// The audit log: of one case, or of everything; and a check that nobody edited it.
app.get<{ Params: { id: string } }>('/api/cases/:id/audit', async (req) => ({ entries: await rt.store.auditTrail({ caseId: req.params.id }) }));
app.get('/api/audit', async () => ({ entries: await rt.store.auditTrail({ limit: 500 }), verification: await rt.store.verifyAudit() }));

// The locally built register of Polish wallets: counts, and the wallets that paid into exchanges, largest first.
// It is read from files kept outside the repository; without them the endpoints say so.
const corpusDir = process.env.CORPUS_DIR ?? '.corpus';
let registerCache: { at: number; stats: ReturnType<typeof registerStats>; rows: ReturnType<typeof registerRows> } | undefined;
const register = () => {
  if (!registerCache || Date.now() - registerCache.at > 60_000) registerCache = { at: Date.now(), stats: registerStats(corpusDir), rows: registerRows(corpusDir) };
  return registerCache;
};
app.get('/api/register', async () => {
  const { stats } = register();
  return { available: stats.wallets > 0, stats };
});
// The register page by page, the most telling wallets first.
app.get<{ Querystring: { page?: string; size?: string; only?: string } }>('/api/register/wallets', async (req) => {
  const size = Math.min(100, Math.max(5, Number(req.query.size ?? 20) || 20));
  const only = req.query.only ?? 'all';
  const rows = register().rows.filter((r) => (only === 'cashout' ? r.deposits > 0 : only === 'account' ? !!r.account : only === 'attested' ? r.attested : only === 'binance' ? r.binance : true));
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const page = Math.min(pages, Math.max(1, Number(req.query.page ?? 1) || 1));
  if (page === 1) await rt.store.audit({ actor: actorOf(req), action: 'register.viewed', detail: { only } });
  return { rows: rows.slice((page - 1) * size, page * size), total: rows.length, page, pages, size };
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
  await rt.store.audit({ actor: actorOf(req), action: 'posts.read', caseId: await caseOfRun(req.params.id), runId: req.params.id, detail: { model: llm.name } });
  return { reading: await rt.store.reading(req.params.id) };
});

// The language model describes the case — from the findings of the run and nothing else.
app.post<{ Params: { id: string } }>('/api/runs/:id/narrative', async (req, reply) => {
  if (!(await rt.store.getRun(req.params.id))) return reply.status(404).send({ error: 'not_found' });
  if (!(await llmAvailable())) return reply.status(503).send({ error: 'llm_unavailable' });
  const facts = caseFacts(await summarizeRun(rt.store, req.params.id));
  const text = await narrate(llm, facts);
  await rt.store.saveNarrative(req.params.id, llm.name, text);
  await rt.store.audit({ actor: actorOf(req), action: 'case.described', caseId: await caseOfRun(req.params.id), runId: req.params.id, detail: { model: llm.name } });
  return { narrative: await rt.store.narrative(req.params.id), facts };
});

/**
 * The language model works the case up: a description in which every sentence names the findings it rests on,
 * the open leads in the order worth following, an opinion on each unconfirmed account, and the reasoning of the
 * request drafts. Everything it writes is checked against the findings; what fails is kept apart, with the reason.
 */
app.post<{ Params: { id: string }; Querystring: { part?: string } }>('/api/runs/:id/dossier', async (req, reply) => {
  const runId = req.params.id;
  if (!(await rt.store.getRun(runId))) return reply.status(404).send({ error: 'not_found' });
  if (!(await llmAvailable())) return reply.status(503).send({ error: 'llm_unavailable' });
  // One part at a time lets the screen show each result as soon as it is ready; without `part` everything is done.
  const parts = z.enum(['describe', 'leads', 'accounts', 'requests']).array().parse(req.query.part ? [req.query.part] : ['describe', 'leads', 'accounts', 'requests']);
  const summary = await summarizeRun(rt.store, runId);
  const findings = caseFindings(summary);
  const detail: Record<string, unknown> = { model: llm.name, parts, findings: findings.length };

  if (parts.includes('describe')) {
    const dossier = await writeDossier(llm, findings);
    await rt.store.saveModelOutput(runId, 'dossier', '', llm.name, { findings, ...dossier });
    Object.assign(detail, { sentences: dossier.sentences.length, rejectedSentences: dossier.rejected.length });
  }

  if (parts.includes('leads')) {
    const ranked = await rankLeads(llm, openLeads(summary, findings), findings);
    await rt.store.saveModelOutput(runId, 'triage', '', llm.name, ranked);
    Object.assign(detail, { leads: ranked.leads.length, orderedByModel: ranked.byModel });
  }

  // Unconfirmed accounts against the confirmed ones. The opinion moves scores a little; it never joins accounts.
  if (parts.includes('accounts')) {
    const clusters = summary.assessment?.clusters ?? [];
    const subject = clusters.find((c) => c.level === 'entered' || c.level === 'publisher');
    const cards = await rt.store.profileCards(runId);
    const cardOf = (x: { origin: string; handle: string; source: string; displayName?: string }) => {
      const c = cards.find((k) => k.origin === x.origin && k.handle.toLowerCase() === x.handle.toLowerCase());
      return { origin: x.origin, service: x.source, handle: x.handle, displayName: c?.displayName ?? x.displayName, profile: c?.profile ?? '', posts: c?.posts ?? [] };
    };
    // The anchor is the account the addresses came from: that is the account the case rests on.
    const published = new Map<string, number>();
    for (const l of summary.assessment?.links ?? []) {
      if (l.clusterId !== subject?.id || l.status !== 'attributed') continue;
      for (const o of l.occurrences) if (o.authorHandle) published.set(`${o.origin}|${o.authorHandle.toLowerCase()}`, (published.get(`${o.origin}|${o.authorHandle.toLowerCase()}`) ?? 0) + 1);
    }
    const weight = (c: { origin: string; handle: string }) => published.get(`${c.origin}|${c.handle.toLowerCase()}`) ?? 0;
    const known = (subject?.accounts ?? []).map(cardOf).filter((c) => c.profile || c.posts.length).sort((a, b) => weight(b) - weight(a)).slice(0, 4);
    let judged = 0;
    // Two kinds of account are compared with the person's anchor account (the first one that says something about itself):
    // accounts kept apart as unconfirmed, and accounts joined to the person by nothing but carrying the same nick.
    const nickOnly = subject && subject.joins.length > 0 && subject.joins.every((j) => j.rule === 'J5');
    const candidates = [
      ...clusters.filter((c) => c !== subject && c.identityCap < 100).flatMap((c) => c.accounts).map((a) => ({ account: a, scope: 'unconfirmed' as const })),
      ...(nickOnly ? known.slice(1).map((c) => ({ account: subject.accounts.find((a) => a.origin === c.origin && a.handle === c.handle)!, scope: 'same_nick' as const })) : []),
    ].slice(0, 5);
    await rt.store.clearModelOutputs(runId, 'judgement');
    if (known.length) {
      for (const { account, scope } of candidates) {
        const candidate = cardOf(account);
        if (!candidate.profile && !candidate.posts.length) continue;
        const against = scope === 'same_nick' ? known.slice(0, 1) : known;
        const j = await judgeSamePerson(llm, against, candidate);
        await rt.store.saveModelOutput(runId, 'judgement', `${account.origin}|${account.handle}`, llm.name, { origin: account.origin, handle: account.handle, source: account.source, scope, ...j });
        judged++;
      }
    }
    if (judged) await reassessRun(rt.store, runId, rules);
    detail.judged = judged;
  }

  // Reasoning for the requests: to the exchanges the money went to, and to the institutions that attest an address.
  if (parts.includes('requests')) {
    const requests: { key: string; addressee: string; subject: string }[] = [];
    // one request per exchange is reasoned; the others follow the same pattern
    for (const o of summary.chain.activity.flatMap((w) => w.offRamps).filter((x, i, all) => all.findIndex((y) => y.exchange === x.exchange) === i).slice(0, 3)) {
      requests.push({ key: `deposit:${o.depositAddress}`, addressee: `giełda ${o.exchange}`, subject: `klienta, któremu przypisano adres depozytowy ${o.depositAddress}` });
    }
    for (const a of (summary.attestations ?? []).filter(knowsIdentity).filter((x, i, all) => all.findIndex((y) => y.issuer === x.issuer) === i).slice(0, 2)) {
      requests.push({ key: `attestation:${a.issuer}:${a.address}`, addressee: a.issuer, subject: `klienta, którego adres ${a.address} adresat publicznie poświadczył` });
    }
    for (const r of requests) await rt.store.saveModelOutput(runId, 'request', r.key, llm.name, { addressee: r.addressee, ...(await justifyRequest(llm, findings, r.addressee, r.subject)) });
    detail.requests = requests.length;
  }

  await rt.store.audit({ actor: actorOf(req), action: 'case.described', caseId: await caseOfRun(runId), runId, detail });
  return summarizeRun(rt.store, runId);
});

// Every transfer of the analysed wallets, oldest first: the chronology of where the money went.
app.get<{ Params: { id: string } }>('/api/runs/:id/transfers', async (req, reply) => {
  if (!(await rt.store.getRun(req.params.id))) return reply.status(404).send({ error: 'not_found' });
  return { transfers: await rt.store.transfers(req.params.id) };
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
    audit: await rt.store.auditTrail({ caseId: run.case_id, limit: 100 }),
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
  await rt.store.audit({ actor: actorOf(req), action: 'report.viewed', caseId: await caseOfRun(req.params.id), runId: req.params.id });
  return reply.type('text/html; charset=utf-8').send(html);
});

// The same report as a PDF, printed by a local headless browser. Nothing leaves the machine.
app.get<{ Params: { id: string } }>('/api/runs/:id/report.pdf', async (req, reply) => {
  const html = await reportHtml(req.params.id);
  if (!html) return reply.status(404).send({ error: 'not_found' });
  await rt.store.audit({ actor: actorOf(req), action: 'report.exported', caseId: await caseOfRun(req.params.id), runId: req.params.id, detail: { format: 'pdf' } });
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
startScheduler({
  store: rt.store, depsFor: (sources) => depsFor(sources as 'synthetic' | 'live'), log: (m) => app.log.warn(m),
  onRun: (caseId, runId) => rt.store.audit({ actor: 'harmonogram', action: 'analysis.scheduled', caseId, runId }),
});

await app.listen({ port: rt.port, host: rt.host });

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { RunDiff, RunSummary, StoredRunEvent } from '@olcys/engine';
import { SOURCES, STATUS, STATUS_ORDER, getJson, sendJson } from './api';
import { buildGraph, layoutGraph, type GNode } from './graph/model';
import { Detail, changeNote, second, type CaseActions, type CaseInfo, type LlmState, type Vault } from './Panel';
import { pln, shortAddress } from './pl';
import { markSensitive } from './mask';
import { RunLog, phaseOf } from './RunLog';
import { Board, StepAddresses, StepChain, StepOverview, StepConclusion, StepEvidence, StepInput, StepTraces, type StepProps } from './steps';

/** How long each kind of step stays on screen at normal speed, in milliseconds. */
const PACE: Record<string, number> = {
  'run.started': 250, lead: 240, search: 80, document: 190, hit: 0, address: 300, account: 130,
  identities: 700, link: 420, ranked: 650, wallet: 700, trail: 600, match: 900, activity: 110, indicator: 520, estimate: 1100, 'run.finished': 200,
};

interface Props {
  runId: string;
  /** True for an analysis just started: its steps are played as they happen. An earlier analysis opens at its result. */
  replay: boolean;
  llm?: LlmState;
  setLlm: Dispatch<SetStateAction<LlmState | undefined>>;
  onOpenRun(id: string, replay?: boolean): void;
  onError(message: string | undefined): void;
  /** Tells the shell what the open case is about, so the search field shows it. */
  onLoaded(seeds: string, sources: string): void;
  onRules(): void;
}

/**
 * One case, read in the order the analysis is done: what was entered, what was found on the web, which addresses
 * and how sure, what the blockchain shows, the conclusion, and the evidence behind all of it.
 */
export function CaseView({ runId, replay, llm, setLlm, onOpenRun, onError, onLoaded, onRules }: Props) {
  // Decided once, when the case is opened: an analysis started just now is watched as it goes; any other is a stored result.
  const watched = useRef(replay).current;
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [events, setEvents] = useState<StoredRunEvent[]>([]);
  const [status, setStatus] = useState<'running' | 'completed' | 'failed'>('running');
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [summary, setSummary] = useState<RunSummary>();
  const [vault, setVault] = useState<Vault>();
  const [selected, setSelected] = useState<string | undefined>(query.get('select') ?? undefined);
  const [diff, setDiff] = useState<RunDiff | null>();
  const [caseInfo, setCaseInfo] = useState<CaseInfo>();
  const [step, setStep] = useState(() => {
    const asked = Number(query.get('step'));
    return query.get('step') !== null && asked >= 0 && asked <= 6 ? asked : watched ? 2 : 0;
  });
  const following = useRef(true); // open new analyses of this case as they finish
  const followSteps = useRef(watched); // while a new analysis plays, the path moves with it — until the analyst picks a step
  const [logOpen, setLogOpen] = useState(watched);
  const autoSelected = useRef(false);
  const jumpToEnd = useRef(!watched);

  // Follow the run: read new events until it has finished, then load the full result.
  useEffect(() => {
    let stop = false;
    let last = 0;
    const poll = async () => {
      try {
        const res = await getJson<{ status: string; events: StoredRunEvent[] }>(`/api/runs/${runId}/events?after=${last}`);
        if (stop) return;
        if (res.events.length) {
          last = res.events[res.events.length - 1].seq;
          setEvents((old) => [...old, ...res.events]);
        }
        if (res.status === 'running' || res.events.length) {
          setTimeout(poll, 250);
          return;
        }
        const result = await getJson<RunSummary>(`/api/runs/${runId}`);
        if (stop) return;
        setSummary(result);
        setVault((await getJson<{ verification: Vault }>(`/api/runs/${runId}/evidence`)).verification);
        setDiff((await getJson<{ diff: RunDiff | null }>(`/api/runs/${runId}/diff`)).diff);
        const info = await getJson<CaseInfo>(`/api/cases/${result.caseId}`);
        setCaseInfo(info);
        onLoaded(result.identifiers.filter((i) => i.origin === 'seed').map((i) => i.value).join(', '), info.sources ?? '');
        setStatus(res.status === 'failed' ? 'failed' : 'completed');
      } catch (err) {
        if (!stop) onError(err instanceof Error ? err.message : String(err));
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [runId, onError, onLoaded]);

  // Replay: show the steps one by one at a pace a person can follow.
  useEffect(() => {
    if (jumpToEnd.current && status !== 'running') {
      setCursor(events.length);
      return;
    }
    if (!playing || cursor >= events.length) return;
    const t = setTimeout(() => setCursor((c) => Math.min(c + 1, events.length)), (PACE[events[cursor].type] ?? 150) / speed);
    return () => clearTimeout(t);
  }, [playing, cursor, events, speed, status]);

  // In presentation mode these are covered wherever they appear: who the case is about and what they call themselves.
  useEffect(() => {
    markSensitive(events.flatMap((e) => (e.type === 'lead' && e.kind !== 'crypto_address' ? [e.value] : e.type === 'document' ? [e.handle] : e.type === 'name' ? [e.name, e.name.split('.')[0]] : [])));
    if (summary) markSensitive([...(summary.assessment?.clusters ?? []).flatMap((c) => c.accounts.flatMap((a) => [a.handle, a.displayName])), ...summary.names.map((n) => n.name)]);
  }, [events, summary]);
  const graph = useMemo(() => buildGraph(events, cursor), [events, cursor]);
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const atEnd = status !== 'running' && events.length > 0 && cursor >= events.length;
  const shown = atEnd ? summary : undefined; // the result is shown once the watched has reached it

  // While the case is open, watch for new analyses of it: scheduled ones arrive on their own.
  useEffect(() => {
    if (!summary || status === 'running') return;
    const timer = setInterval(async () => {
      try {
        const info = await getJson<CaseInfo>(`/api/cases/${summary.caseId}`);
        setCaseInfo(info);
        // Open a newer analysis only if it found something changed: one that found nothing must not pull the analyst away.
        const openAt = info.runs.find((r) => r.id === summary.runId)?.startedAt ?? '';
        const news = [...info.runs].reverse().find((r) => r.status === 'completed' && r.startedAt > openAt && r.changes?.changed);
        if (following.current && news) onOpenRun(news.id);
      } catch {
        // the API may be restarting; try again on the next tick
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [summary, status, onOpenRun]);

  // A new analysis is watched as it goes: the path moves to the step the engine is working on, never backwards
  // (the engine returns to the web after the blockchain; the log shows that, the path does not jump about).
  const live = watched && !atEnd;
  useEffect(() => {
    if (!watched || !followSteps.current || cursor === 0) return;
    const phase = phaseOf(events[Math.min(cursor, events.length) - 1]);
    setStep((now) => Math.max(now, phase));
  }, [cursor, events, watched]);
  // When the analysis being watched is over, the analyst lands on the short overview, not on the last step.
  useEffect(() => {
    if (watched && atEnd && followSteps.current && summary) {
      followSteps.current = false;
      setStep(0);
      setLogOpen(false); // the log has done its job; it stays one click away
    }
  }, [watched, atEnd, summary]);
  const pick = (n: number) => {
    followSteps.current = false;
    setStep(n);
  };

  const fail = useCallback((err: unknown) => onError(err instanceof Error ? err.message : String(err)), [onError]);
  const actions: CaseActions | undefined = summary && {
    rerun: () => {
      following.current = true;
      void sendJson<{ runId: string }>(`/api/cases/${summary.caseId}/runs`).then((r) => onOpenRun(r.runId, true)).catch(fail);
    },
    setSchedule: (everySeconds) => {
      following.current = true;
      void sendJson(`/api/cases/${summary.caseId}/schedule`, { everySeconds }, 'PUT').then(() => getJson<CaseInfo>(`/api/cases/${summary.caseId}`)).then(setCaseInfo).catch(fail);
    },
    setStatus: (next) => {
      void sendJson(`/api/cases/${summary.caseId}/status`, { status: next }, 'PUT').then(() => getJson<CaseInfo>(`/api/cases/${summary.caseId}`)).then(setCaseInfo).catch(fail);
    },
    readPosts: () => {
      setLlm((x) => x && { ...x, busy: 'read' });
      void sendJson(`/api/runs/${summary.runId}/read`).then(() => getJson<RunSummary>(`/api/runs/${summary.runId}`)).then(setSummary).catch(fail)
        .finally(() => setLlm((x) => x && { ...x, busy: undefined }));
    },
    describeCase: () => {
      setLlm((x) => x && { ...x, busy: 'describe' });
      // One part after another, so each result appears as soon as the model has written it.
      const part = (name: string) => () => sendJson<RunSummary>(`/api/runs/${summary.runId}/dossier?part=${name}`).then(setSummary);
      void part('describe')().then(part('leads')).then(part('accounts')).then(part('requests')).catch(fail)
        .finally(() => setLlm((x) => x && { ...x, busy: undefined }));
    },
    openRun: (id) => {
      // Looking at an older analysis on purpose: do not jump away when a newer one arrives.
      following.current = id === [...(caseInfo?.runs ?? [])].reverse().find((r) => r.status === 'completed')?.id;
      onOpenRun(id);
    },
  };

  // What the analyst chose: a node of the graph, or an address picked from the table that the graph has no box for.
  const node: GNode | undefined = useMemo(() => {
    if (!selected) return undefined;
    const inGraph = graph.nodes.find((n) => n.id === selected);
    if (inGraph) return inGraph.type === 'seed' ? undefined : inGraph;
    const [, chain, address] = selected.match(/^addr:([^:]+):(.+)$/) ?? [];
    const link = summary?.assessment?.links.find((l) => l.chain === chain && l.address === address);
    return link && { id: selected, type: 'address', col: 2, title: shortAddress(link.address), firstSeq: 0, chain: link.chain, address: link.address, link: { clusterId: link.clusterId, status: link.status, score: link.score, band: link.band, rule: '', reason: '' } };
  }, [selected, graph, summary]);

  const seeds = summary?.identifiers.filter((i) => i.origin === 'seed').map((i) => i.value) ?? events.flatMap((e) => (e.type === 'lead' && e.origin === 'seed' ? [e.value] : []));
  const firm = new Set((shown?.assessment?.clusters ?? []).filter((c) => c.level === 'entered' || c.level === 'publisher').map((c) => c.id));
  const links = shown?.assessment?.links ?? [];
  const mine = links.filter((l) => l.status === 'attributed' && firm.has(l.clusterId)).length;
  const rejected = links.filter((l) => l.status !== 'attributed').length;
  const accounts = (shown?.assessment?.clusters ?? []).filter((c) => firm.has(c.id)).reduce((n, c) => n + c.accounts.length, 0);
  const ramps = (shown?.chain.activity ?? []).flatMap((a) => a.offRamps).length;
  const wait = status === 'running' || !atEnd ? 'w toku' : '—';

  const STEPS: { n: number; title: string; note: string }[] = [
    { n: 0, title: 'Podsumowanie', note: shown ? 'najważniejsze ustalenia' : wait },
    { n: 1, title: 'Wejście', note: seeds.length ? `${seeds.length === 1 ? 'jeden identyfikator' : `identyfikatorów: ${seeds.length}`}` : wait },
    { n: 2, title: 'Ślady w sieci', note: shown ? `kont osoby: ${accounts}, dokumentów: ${shown.counts.documents}` : `${graph.nodes.filter((n) => n.type === 'account').length} kont, w toku` },
    { n: 3, title: 'Adresy i pewność', note: shown ? `przypisane: ${mine}, odrzucone: ${rejected}` : wait },
    { n: 4, title: 'Łańcuch bloków', note: shown ? (ramps ? `wpłaty na giełdy: ${ramps}` : `portfeli: ${shown.chain.activity.length}`) : wait },
    { n: 5, title: 'Wniosek', note: shown ? (shown.estimate?.totalPln ? `${pln(shown.estimate.totalPln)} do wyjaśnienia` : 'brak kwoty do wyjaśnienia') : wait },
    { n: 6, title: 'Źródła i raport', note: shown ? `zapisów dowodowych: ${shown.counts.snapshots}` : wait },
  ];

  const props: StepProps = {
    summary: shown, graph, layout, events, cursor, caseInfo, actions, llm, diff: atEnd ? diff : undefined, vault: atEnd ? vault : undefined, runId, selected, status,
    onSelect: setSelected, onRules, onStep: pick,
    playback: { playing, setPlaying, speed, setSpeed, setCursor, atEnd },
  };
  const run = caseInfo?.runs.find((r) => r.id === runId);

  return (
    <main className={playing && cursor < events.length ? 'case' : 'case still'}>
      <header className="case-head">
        <div className="case-title">
          <p className="kicker">Sprawa{caseInfo?.sources ? `, ${SOURCES[caseInfo.sources]?.toLowerCase() ?? caseInfo.sources}` : ''}</p>
          <h1>{seeds.join(', ') || 'Analiza'}</h1>
          <p className="quiet">
            {status === 'running' ? 'Analiza trwa.' : status === 'failed' ? `Analiza przerwana${summary?.error ? `: ${summary.error}` : ''}.` : run ? `Analiza z ${second(run.startedAt)} UTC.` : 'Analiza zakończona.'}
          </p>
          {atEnd && diff && (
            <p className={diff.changed ? 'case-changes changed' : 'case-changes'}>
              {diff.changed ? diff.summary : 'Od poprzedniej analizy nic się nie zmieniło.'}{' '}
              <button className="linklike" onClick={() => pick(1)}>
                Pokaż porównanie
              </button>
            </p>
          )}
        </div>
        {summary && caseInfo && actions && (
          <div className="case-tools">
            <label>
              Stan sprawy
              <select value={caseInfo.status ?? 'new'} onChange={(e) => actions.setStatus(e.target.value)}>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS[s]}
                  </option>
                ))}
              </select>
            </label>
            {caseInfo.runs.length > 1 && (
              <label>
                Która analiza
                <select value={runId} onChange={(e) => actions.openRun(e.target.value)}>
                  {[...caseInfo.runs].reverse().filter((r) => r.status === 'completed' || r.id === runId).map((r) => (
                    <option key={r.id} value={r.id}>
                      {second(r.startedAt)} — {changeNote(r)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button onClick={() => setLogOpen(!logOpen)} aria-pressed={logOpen}>
              Dziennik
            </button>
            <button onClick={actions.rerun}>Analizuj ponownie</button>
            <a className="button" href={`/api/runs/${summary.runId}/report.pdf`} target="_blank" rel="noreferrer">
              Raport PDF
            </a>
          </div>
        )}
      </header>

      <nav className="path" aria-label="Kroki analizy">
        <ol>
          {STEPS.map((s) => (
            <li key={s.n} className={`${step === s.n ? 'on' : s.n < step ? 'past' : ''}${s.n === 0 ? ' sum' : ''}`}>
              <button onClick={() => pick(s.n)} aria-current={step === s.n ? 'step' : undefined}>
                <span className="path-n">{s.n === 0 ? '∑' : s.n}</span>
                <span className="path-t">{s.title}</span>
                <span className="path-s">{s.note}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div className={node || logOpen ? 'case-body with-detail' : 'case-body'}>
        <div className="step" key={live ? 'live' : step}>
          {/* While the analysis is being watched, the picture stays on screen whatever step the engine has reached. */}
          {live && step !== 2 && <Board {...props} />}
          {step === 0 ? <StepOverview {...props} /> : step === 1 ? <StepInput {...props} /> : step === 2 ? <StepTraces {...props} /> : step === 3 ? <StepAddresses {...props} /> : step === 4 ? <StepChain {...props} /> : step === 5 ? <StepConclusion {...props} /> : <StepEvidence {...props} />}
        </div>
        {node ? (
          <Detail node={node} summary={shown} onClose={() => setSelected(undefined)} />
        ) : logOpen ? (
          <aside className="side drawer" aria-label="Dziennik analizy">
            <button className="drawer-close" onClick={() => setLogOpen(false)}>
              Ukryj dziennik
            </button>
            <h2>{live ? 'Analiza trwa' : 'Dziennik analizy'}</h2>
            <p className="quiet">Zdarzenia zapisane przez silnik w chwili, gdy nastąpiły (czas UTC). Cyfra to krok scenariusza.</p>
            <RunLog events={events} cursor={cursor} follow={live} working={status === 'running'} />
          </aside>
        ) : null}
      </div>
    </main>
  );
}

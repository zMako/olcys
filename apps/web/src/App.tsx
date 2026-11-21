import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { RunDiff, RunSummary, StoredRunEvent } from '@olcys/engine';
import { GraphView, Legend } from './graph/Graph';
import { buildGraph, layoutGraph } from './graph/model';
import { Panel, type CaseActions, type CaseInfo, type Vault } from './Panel';
import { describe } from './pl';

/** How long each kind of step stays on screen at normal speed, in milliseconds. */
const PACE: Record<string, number> = {
  'run.started': 250, lead: 240, search: 80, document: 190, hit: 0, address: 300, account: 130,
  identities: 700, link: 420, ranked: 650, wallet: 700, trail: 600, match: 900, activity: 110, indicator: 520, estimate: 1100, 'run.finished': 200,
};
const SPEEDS = [1, 2, 4];

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`serwer odpowiedział kodem ${res.status}`);
  return (await res.json()) as T;
}

export function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [input, setInput] = useState(query.get('q') ?? 'szklane_domy');
  const [runId, setRunId] = useState<string | undefined>(query.get('run') ?? undefined);
  const [events, setEvents] = useState<StoredRunEvent[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'failed'>('idle');
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [summary, setSummary] = useState<RunSummary>();
  const [vault, setVault] = useState<Vault>();
  const [selected, setSelected] = useState<string | undefined>(query.get('select') ?? undefined);
  const [sources, setSources] = useState<'synthetic' | 'live'>(query.get('sources') === 'live' ? 'live' : 'synthetic');
  const [view, setView] = useState<'graph' | 'report'>(query.get('view') === 'report' ? 'report' : 'graph');
  const [error, setError] = useState<string>();
  const [diff, setDiff] = useState<RunDiff | null>();
  const [caseInfo, setCaseInfo] = useState<CaseInfo>();
  const following = useRef(true); // open new analyses of this case as they finish
  const autoSelected = useRef(false);
  const jumpToEnd = useRef(query.get('end') === '1');
  const startAt = useRef(query.get('step'));

  // Follow a run: read new events until it has finished, then load the full result.
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    let last = 0;
    setEvents([]);
    setSummary(undefined);
    setVault(undefined);
    setDiff(undefined);
    setStatus('running');
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
        setSummary(result);
        setVault((await getJson<{ verification: Vault }>(`/api/runs/${runId}/evidence`)).verification);
        setDiff((await getJson<{ diff: RunDiff | null }>(`/api/runs/${runId}/diff`)).diff);
        setCaseInfo(await getJson<CaseInfo>(`/api/cases/${result.caseId}`));
        setStatus(res.status === 'failed' ? 'failed' : 'completed');
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [runId]);

  // Replay: show the steps one by one at a pace a person can follow.
  useEffect(() => {
    if (jumpToEnd.current && status === 'completed') {
      setCursor(events.length);
      return;
    }
    if (startAt.current && events.length >= Number(startAt.current)) {
      setCursor(Number(startAt.current));
      setPlaying(false);
      startAt.current = null;
      return;
    }
    if (!playing || cursor >= events.length) return;
    const t = setTimeout(() => setCursor((c) => Math.min(c + 1, events.length)), (PACE[events[cursor].type] ?? 150) / speed);
    return () => clearTimeout(t);
  }, [playing, cursor, events, speed, status]);

  const graph = useMemo(() => buildGraph(events, cursor), [events, cursor]);
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const atEnd = status !== 'running' && events.length > 0 && cursor >= events.length;

  /** Opens another analysis of the case, at its result. */
  const openRun = useCallback((id: string) => {
    jumpToEnd.current = true;
    autoSelected.current = false;
    setSelected(undefined);
    setCursor(0);
    setRunId(id);
  }, []);

  // While a case is open, watch for new analyses of it: scheduled ones arrive on their own.
  useEffect(() => {
    if (!summary || status === 'running') return;
    const timer = setInterval(async () => {
      try {
        const info = await getJson<CaseInfo>(`/api/cases/${summary.caseId}`);
        setCaseInfo(info);
        // Open a newer analysis only if it found something changed: one that found nothing must not pull the analyst away from what they are reading.
        const openAt = info.runs.find((r) => r.id === summary.runId)?.startedAt ?? '';
        const news = [...info.runs].reverse().find((r) => r.status === 'completed' && r.startedAt > openAt && r.changes?.changed);
        if (following.current && news) openRun(news.id);
      } catch {
        // the API may be restarting; try again on the next tick
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [summary, status, openRun]);

  const actions: CaseActions | undefined = summary && {
    rerun: () => {
      following.current = true;
      void getJson<{ runId: string }>(`/api/cases/${summary.caseId}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then((r) => openRun(r.runId))
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    setSchedule: (everySeconds) => {
      following.current = true;
      void getJson(`/api/cases/${summary.caseId}/schedule`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ everySeconds }) })
        .then(() => getJson<CaseInfo>(`/api/cases/${summary.caseId}`))
        .then(setCaseInfo)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    },
    openRun: (id) => {
      // Looking at an older analysis on purpose: do not jump away when a newer one arrives.
      following.current = id === [...(caseInfo?.runs ?? [])].reverse().find((r) => r.status === 'completed')?.id;
      openRun(id);
    },
  };

  // When the replay reaches the end, open the strongest result so the receipt is on screen —
  // unless this is a repeated analysis, where the list of changes is what matters.
  useEffect(() => {
    if (!atEnd || autoSelected.current || selected || diff === undefined) return;
    autoSelected.current = true;
    if (diff) return;
    const best = graph.nodes.filter((n) => n.type === 'address' && n.link?.status === 'attributed').sort((a, b) => b.link!.score - a.link!.score)[0];
    if (best) setSelected(best.id);
  }, [atEnd, graph, selected, diff]);

  const analyze = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const identifiers = input.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      if (!identifiers.length) return;
      setError(undefined);
      setSelected(undefined);
      setCursor(0);
      setPlaying(true);
      autoSelected.current = false;
      jumpToEnd.current = false;
      following.current = true;
      try {
        const res = await getJson<{ runId: string }>('/api/analyze', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ identifiers, sources }),
        });
        setRunId(res.runId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [input, sources],
  );

  const node = graph.nodes.find((n) => n.id === selected);
  // The step shown is the latest one worth reading; repeat visits to known pages are skipped.
  const step = events.slice(0, cursor).reverse().find((e) => e.type !== 'hit');

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brand-name">OŁCyŚ</span>
          <span className="brand-sub">Osintowy Łapacz Cyfrowych Śladów</span>
        </div>
        <form className="ask" onSubmit={analyze}>
          <label htmlFor="identifier">Kogo sprawdzamy</label>
          <input id="identifier" value={input} onChange={(e) => setInput(e.target.value)} placeholder="nick, imię i nazwisko, e-mail, telefon lub adres" />
          <select value={sources} onChange={(e) => setSources(e.target.value as 'synthetic' | 'live')} aria-label="Skąd pobierać dane">
            <option value="synthetic">Środowisko testowe</option>
            <option value="live">Internet, na żywo</option>
          </select>
          <button className="primary" disabled={status === 'running' && cursor === 0 && events.length === 0}>
            Analizuj
          </button>
        </form>
        <nav className="views" aria-label="Widok">
          <button className={view === 'graph' ? 'on' : ''} onClick={() => setView('graph')} aria-pressed={view === 'graph'}>
            Graf powiązań
          </button>
          <button className={view === 'report' ? 'on' : ''} onClick={() => setView('report')} aria-pressed={view === 'report'} disabled={!summary}>
            Raport
          </button>
        </nav>
      </header>

      {error && <p className="error">Nie udało się wykonać analizy: {error}. Sprawdź, czy działa serwer API i środowisko źródeł.</p>}

      {view === 'report' && summary ? (
        <main className="report-view">
          <div className="report-bar">
            <span>Raport z analizy, gotowy do wydruku.</span>
            <a className="main" href={`/api/runs/${summary.runId}/report.pdf`} target="_blank" rel="noreferrer">
              Pobierz PDF
            </a>
            <a href={`/api/runs/${summary.runId}/report`} target="_blank" rel="noreferrer">
              Otwórz w nowej karcie
            </a>
          </div>
          <iframe className="report-frame" title="Raport z analizy" src={`/api/runs/${summary.runId}/report`} />
        </main>
      ) : (
        <main className="work">
          <div className="board">
            <div className="board-scroll">
              {events.length === 0 ? (
                <div className="empty">
                  <p>Graf powiązań pojawi się tutaj.</p>
                  <p className="quiet">Od wpisanego identyfikatora, przez konta w sieci i adresy kryptowalut, do usług, w których środki mogły zostać zamienione na walutę tradycyjną.</p>
                </div>
              ) : (
                <GraphView graph={graph} layout={layout} selected={selected} onSelect={setSelected} />
              )}
            </div>
            {events.length > 0 && (
              <>
                <Legend />
                <div className="playback">
                  <button
                    className="play"
                    onClick={() => {
                      if (atEnd) setCursor(0);
                      setPlaying(atEnd ? true : !playing);
                    }}
                    aria-label={atEnd ? 'Odtwórz od początku' : playing ? 'Wstrzymaj' : 'Odtwarzaj'}
                  >
                    {atEnd ? 'Od początku' : playing ? 'Wstrzymaj' : 'Odtwarzaj'}
                  </button>
                  <div className="track">
                    <input
                      type="range"
                      min={0}
                      max={events.length}
                      value={cursor}
                      aria-label="Krok analizy"
                      onChange={(e) => {
                        setPlaying(false);
                        setCursor(Number(e.target.value));
                      }}
                    />
                    <p className="step" aria-live="off">
                      <span className="step-count">
                        Krok {cursor} z {events.length}
                      </span>
                      {step ? describe(step) : 'Gotowe do odtworzenia.'}
                    </p>
                  </div>
                  <div className="speeds" role="group" aria-label="Tempo odtwarzania">
                    {SPEEDS.map((s) => (
                      <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)} aria-pressed={speed === s}>
                        {s}×
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        setPlaying(false);
                        setCursor(events.length);
                      }}
                    >
                      Pokaż wynik
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <Panel node={node} graph={graph} summary={atEnd || node ? summary : undefined} events={events} cursor={cursor} vault={atEnd ? vault : undefined} onSelect={setSelected} diff={atEnd ? diff : undefined} caseInfo={caseInfo} actions={actions} />
        </main>
      )}
    </div>
  );
}

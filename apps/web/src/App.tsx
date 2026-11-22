import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { getJson, sendJson, type CaseRow } from './api';
import { CaseView } from './CaseView';
import { Cases } from './Cases';
import { modelPlace, modelShort, type LlmState } from './Panel';
import { Register } from './Register';
import { Rules } from './Rules';
import { setMasking } from './mask';

type View = 'register' | 'cases' | 'rules' | 'case';
const VIEWS: View[] = ['register', 'cases', 'rules', 'case'];

/**
 * The analyst's workplace: a register of leads, a desk of cases, the rules the score is computed by, and one open
 * case at a time. A new analysis can be started from anywhere.
 */
export function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const asked = query.get('view') === 'report' ? 'case' : (query.get('view') as View | null);
  const [view, setView] = useState<View>(query.get('run') ? 'case' : asked && VIEWS.includes(asked) ? asked : 'register');
  const [run, setRun] = useState<{ id: string; replay: boolean } | undefined>(
    // An analysis opened by its address has been run before: it opens at its result. Only one started here and now is watched as it goes.
    query.get('run') ? { id: query.get('run')!, replay: false } : undefined,
  );
  const [input, setInput] = useState(query.get('q') ?? 'szklane_domy');
  const [sources, setSources] = useState<'synthetic' | 'live'>(query.get('sources') === 'live' ? 'live' : 'synthetic');
  const [error, setError] = useState<string>();
  const [llm, setLlm] = useState<LlmState>();
  const [open, setOpen] = useState<number>();
  const [starting, setStarting] = useState(false);
  // Presentation mode covers personal data on screen; it is remembered, and switching it off redraws the page from the data.
  const [mask, setMask] = useState(() => query.get('mask') === '1' || window.localStorage.getItem('olcys-mask') === '1');
  useEffect(() => {
    setMasking(mask);
  }, [mask]);
  const toggleMask = () => {
    window.localStorage.setItem('olcys-mask', mask ? '0' : '1');
    if (mask) window.location.reload(); // what was covered is drawn again from the data
    else setMask(true);
  };

  useEffect(() => {
    getJson<LlmState>('/api/llm').then(setLlm).catch(() => setLlm(undefined));
    getJson<CaseRow[]>('/api/cases').then((c) => setOpen(c.filter((x) => x.status !== 'closed').length)).catch(() => setOpen(undefined));
  }, [view]);

  // The address bar always names what is on screen, so a view can be bookmarked or sent to a colleague.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    q.delete('view');
    q.delete('run');
    if (view === 'case' && run) q.set('run', run.id);
    else q.set('view', view);
    window.history.replaceState(null, '', `${window.location.pathname}?${q}`);
  }, [view, run]);

  const start = useCallback(async (text: string, from: 'synthetic' | 'live') => {
    const identifiers = text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    if (!identifiers.length) return;
    setError(undefined);
    setStarting(true);
    try {
      const res = await sendJson<{ runId: string }>('/api/analyze', { identifiers, sources: from });
      setRun({ id: res.runId, replay: true });
      setView('case');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, []);

  const analyze = (e: FormEvent) => {
    e.preventDefault();
    void start(input, sources);
  };
  /** A row of the register becomes a case: the wallet is analysed against the live internet. */
  const analyzeWallet = useCallback(
    (address: string) => {
      setInput(address);
      setSources('live');
      void start(address, 'live');
    },
    [start],
  );
  const openRun = useCallback((id: string, replay = false) => {
    setRun({ id, replay });
    setView('case');
  }, []);
  const loaded = useCallback((seeds: string, from: string) => {
    // Once an analysis has finished it is a stored result: coming back to it never plays it again.
    setRun((r) => (r && r.replay ? { ...r, replay: false } : r));
    setInput(seeds);
    if (from === 'live' || from === 'synthetic') setSources(from);
  }, []);

  const nav = (v: View, label: string, note?: string) => (
    <button className={view === v ? 'on' : ''} onClick={() => setView(v)} aria-current={view === v ? 'page' : undefined} disabled={v === 'case' && !run}>
      <span>{label}</span>
      {note && <span className="rail-note">{note}</span>}
    </button>
  );

  return (
    <div className="shell">
      <nav className="rail" aria-label="Główna nawigacja">
        <div className="brand">
          <span className="brand-name">OŁCyŚ</span>
          <span className="brand-sub">Osintowy Łapacz Cyfrowych Śladów</span>
        </div>
        <div className="rail-links">
          {nav('register', 'Rejestr', 'kogo sprawdzić')}
          {nav('cases', 'Sprawy', open === undefined ? undefined : open === 0 ? 'brak otwartych' : `otwartych: ${open}`)}
          {nav('case', 'Otwarta sprawa', run ? input.slice(0, 24) : 'żadna')}
          {nav('rules', 'Reguły', 'jak liczony jest wynik')}
        </div>
        <button className="rail-mask" onClick={toggleMask} aria-pressed={mask}>
          {mask ? 'Odkryj dane osobowe' : 'Zakryj dane osobowe'}
          <span className="rail-note">{mask ? 'tryb prezentacji włączony' : 'do prezentacji i nagrań'}</span>
        </button>
        <p className="rail-foot" style={{ marginTop: 0 }}>
          Wynik liczą wyłącznie reguły. Model językowy {llm?.available ? `(${modelShort(llm.model)}, ${modelPlace(llm.model)})` : '(niedostępny)'} pomaga czytać i pisać projekty; na wynik nie ma wpływu.
        </p>
      </nav>

      <div className="main">
        <header className="topbar">
          <form className="ask" onSubmit={analyze}>
            <label htmlFor="identifier">Nowa analiza</label>
            <input id="identifier" value={input} onChange={(e) => setInput(e.target.value)} placeholder="nick, imię i nazwisko, e-mail, telefon, adres profilu lub adres kryptowalutowy" />
            <select value={sources} onChange={(e) => setSources(e.target.value as 'synthetic' | 'live')} aria-label="Skąd pobierać dane">
              <option value="synthetic">Środowisko testowe</option>
              <option value="live">Internet, na żywo</option>
            </select>
            <button className="primary" disabled={starting}>
              {starting ? 'Uruchamiam…' : 'Analizuj'}
            </button>
          </form>
        </header>

        {error && (
          <p className="error" role="alert">
            Nie udało się wykonać czynności: {error}. Sprawdź, czy działa serwer API i środowisko źródeł.
          </p>
        )}

        {view === 'register' ? (
          <Register onAnalyze={analyzeWallet} />
        ) : view === 'cases' ? (
          <Cases onOpen={(id) => openRun(id)} onError={setError} onDeleted={(id) => setRun((r) => (r && r.id === id ? undefined : r))} />
        ) : view === 'rules' ? (
          <Rules />
        ) : run ? (
          <CaseView key={run.id} runId={run.id} replay={run.replay} llm={llm} setLlm={setLlm} onOpenRun={openRun} onError={setError} onLoaded={loaded} onRules={() => setView('rules')} />
        ) : (
          <main className="page">
            <h1>Żadna sprawa nie jest otwarta</h1>
            <p>Wpisz identyfikator u góry, wybierz wiersz w rejestrze albo otwórz sprawę z listy.</p>
          </main>
        )}
      </div>
    </div>
  );
}

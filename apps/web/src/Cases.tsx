import { useCallback, useEffect, useState } from 'react';
import { SOURCES, STATUS, STATUS_ORDER, getJson, sendJson, type CaseRow } from './api';
import { markSensitive } from './mask';
import { KIND, pln, shortAddress } from './pl';

const EVERY: Record<number, string> = { 30: 'co 30 s', 300: 'co 5 min', 3600: 'co godzinę', 86400: 'co dobę' };
const when = (iso: string) => `${iso.slice(0, 10)}, ${iso.slice(11, 16)}`;

/**
 * The analyst's desk: every case, where it stands, and what its latest analysis found.
 * A case moves from analysis, through a request to whoever knows the owner, to an answer and closing.
 */
export function Cases({ onOpen, onError, onDeleted }: { onOpen(runId: string): void; onError(message: string | undefined): void; onDeleted(runId: string | null): void }) {
  const [cases, setCases] = useState<CaseRow[]>();
  const [only, setOnly] = useState<string>('open');
  const load = useCallback(() => {
    getJson<CaseRow[]>('/api/cases').then(setCases).catch((err) => onError(err instanceof Error ? err.message : String(err)));
  }, [onError]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 6000); // scheduled analyses arrive on their own
    return () => clearInterval(timer);
  }, [load]);

  const remove = (c: CaseRow) => {
    const name = c.identifiers.map((i) => i.value).join(', ') || c.title;
    if (!window.confirm(`Usunąć sprawę „${name}” razem ze wszystkimi jej analizami i zapisanymi dowodami? Tego nie da się cofnąć. W dzienniku czynności zostanie wpis o usunięciu.`)) return;
    void getJson(`/api/cases/${c.id}`, { method: 'DELETE' }).then(() => { onDeleted(c.lastRun?.id ?? c.latestRunId); load(); }).catch((err) => onError(String(err).includes('409') ? 'analiza tej sprawy jeszcze trwa; poczekaj, aż się zakończy' : String(err)));
  };
  const setStatus = (id: string, status: string) => void sendJson(`/api/cases/${id}/status`, { status }, 'PUT').then(load).catch((err) => onError(String(err)));
  if (cases) markSensitive(cases.filter((c) => c.sources === 'live').flatMap((c) => c.identifiers.filter((i) => i.kind !== 'crypto_address').map((i) => i.value)));
  if (!cases) return <main className="page"><p className="quiet">Wczytywanie spraw…</p></main>;

  const count = (k: string) => (k === 'all' ? cases.length : k === 'open' ? cases.filter((c) => c.status !== 'closed').length : cases.filter((c) => c.status === k).length);
  const shown = cases.filter((c) => (only === 'all' ? true : only === 'open' ? c.status !== 'closed' : c.status === only));
  const total = shown.reduce((n, c) => n + (c.lastRun?.totalPln ?? 0), 0);

  return (
    <main className="page">
      <h1>Sprawy</h1>
      <p className="lede">Każda analiza zaczyna sprawę. Sprawa przechodzi od analizy, przez zapytanie do podmiotu, który zna właściciela adresu, do odpowiedzi i zamknięcia. Stan zmienia analityk; każda zmiana trafia do dziennika.</p>

      <div className="chips" role="group" aria-label="Które sprawy pokazać">
        {[['open', 'Otwarte'], ...STATUS_ORDER.map((s) => [s, STATUS[s]]), ['all', 'Wszystkie']].map(([k, label]) => (
          <button key={k} className={only === k ? 'on' : ''} onClick={() => setOnly(k)} aria-pressed={only === k} disabled={count(k) === 0 && k !== 'open'}>
            {label} <span className="chip-n">{count(k)}</span>
          </button>
        ))}
      </div>

      {!cases.length ? (
        <section className="card">
          <p>Nie ma jeszcze żadnej sprawy. Wpisz identyfikator w polu „Nowa analiza” u góry albo wybierz portfel z rejestru.</p>
        </section>
      ) : !shown.length ? (
        <section className="card">
          <p>Żadna sprawa nie ma tego stanu. Wybierz inny filtr powyżej.</p>
        </section>
      ) : (
        <section className="card wide">
          <table className="grid rows-click cases">
            <thead>
              <tr>
                <th>Sprawa</th>
                <th>Stan</th>
                <th className="num">Adresy przypisane</th>
                <th className="num">Odrzucone</th>
                <th className="num">Do wyjaśnienia</th>
                <th>Kto zna właściciela</th>
                <th>Ostatnia analiza (UTC)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const r = c.lastRun;
                const openId = r?.id ?? c.latestRunId;
                const knows = [...new Set([...(r?.exchanges ?? []), ...(r?.attesters ?? [])])];
                return (
                  <tr key={c.id} onClick={() => openId && onOpen(openId)}>
                    <td>
                      <button className="linklike strong" onClick={() => openId && onOpen(openId)} disabled={!openId}>
                        {c.identifiers.map((i) => (i.kind === 'crypto_address' ? shortAddress(i.value) : i.value)).join(', ') || c.title}
                      </button>
                      <div className="quiet">
                        {c.identifiers.map((i) => KIND[i.kind] ?? i.kind).filter((x, i, all) => all.indexOf(x) === i).join(', ')}; {SOURCES[c.sources]?.toLowerCase() ?? c.sources}
                      </div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select value={c.status} onChange={(e) => setStatus(c.id, e.target.value)} aria-label={`Stan sprawy ${c.title}`} className={`status status-${c.status}`}>
                        {STATUS_ORDER.map((s) => (
                          <option key={s} value={s}>
                            {STATUS[s]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="num">{r ? r.attributed : '—'}</td>
                    <td className="num">{r ? r.rejected : '—'}</td>
                    <td className="num strong">{r?.totalPln ? pln(r.totalPln) : '—'}</td>
                    <td>{knows.length ? knows.join(', ') : <span className="quiet">nie ustalono</span>}</td>
                    <td>
                      {c.running ? 'analiza trwa' : r ? when(r.startedAt) : c.failed ? <span className="warn">analiza przerwana</span> : 'brak'}
                      <div className={r?.changes?.changed ? 'changes' : 'quiet'}>
                        {r?.changes ? (r.changes.changed ? r.changes.summary.replace(/^Od poprzedniej analizy: /, '').replace(/\.$/, '') : 'bez zmian względem poprzedniej') : c.runs > 1 ? '' : 'pierwsza analiza'}
                        {c.schedule ? `${r?.changes || c.runs <= 1 ? '; ' : ''}powtarzana ${EVERY[c.schedule.everySeconds] ?? `co ${c.schedule.everySeconds} s`}` : ''}
                        {r && r.gaps > 0 ? `; braki w źródłach: ${r.gaps}` : ''}
                      </div>
                    </td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => openId && onOpen(openId)} disabled={!openId}>
                        Otwórz
                      </button>{' '}
                      <button className="danger" onClick={(e) => { e.stopPropagation(); remove(c); }} disabled={c.running}>
                        Usuń
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {total > 0 && <p className="quiet">Łączna wartość do wyjaśnienia w pokazanych sprawach: {pln(total)}. To wartość skierowana do usług wyjścia do walut tradycyjnych, nie kwota podatku.</p>}
        </section>
      )}
    </main>
  );
}

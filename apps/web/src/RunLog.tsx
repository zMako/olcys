import { useEffect, useRef, useState } from 'react';
import type { StoredRunEvent } from '@olcys/engine';
import { describe } from './pl';

/** Which step of the scenario an event of the run belongs to. */
const PHASE: Record<string, number> = {
  'run.started': 1, lead: 2, search: 2, document: 2, hit: 2, archive: 2, history: 2, identities: 2, reading: 2, statement: 2, diff: 1,
  address: 3, proof: 3, account: 3, link: 3, ranked: 3, name: 3, deployment: 3, attestation: 3,
  wallet: 4, trail: 4, activity: 4, indicator: 4, match: 4, estimate: 5, 'run.finished': 6,
};
export const phaseOf = (e: StoredRunEvent): number => (e.type === 'progress' ? e.phase : PHASE[e.type] ?? 2);
export const PHASE_NAME = ['', 'Wejście', 'Ślady w sieci', 'Adresy i pewność', 'Łańcuch bloków', 'Wniosek', 'Źródła i raport'];

/** How a line should read at a glance: a rejection, a confirmed link, a possible cash-out, or plain progress. */
const toneOf = (e: StoredRunEvent): string =>
  e.type === 'link' ? (e.status === 'attributed' ? 'yes' : 'no')
  : e.type === 'proof' ? (e.valid ? 'yes' : 'no')
  : e.type === 'indicator' ? (e.cashOut ? 'cash' : '')
  : e.type === 'estimate' || e.type === 'attestation' || e.type === 'match' || e.type === 'trail' || e.type === 'history' ? 'key'
  : e.type === 'search' || e.type === 'document' || e.type === 'account' || e.type === 'activity' || e.type === 'progress' ? 'minor'
  : '';

/**
 * The analysis as it happened, one plain sentence per recorded step, with the time the engine recorded it.
 * Nothing here is staged: each line is an event the engine stored while it worked, shown in the order it occurred.
 */
export function RunLog({ events, cursor, only, follow = true, limit, working }: { events: StoredRunEvent[]; cursor: number; only?: number; follow?: boolean; limit?: number; working?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [working]);
  const last = events[events.length - 1];
  const idle = working && last && cursor >= events.length ? Math.max(0, Math.round((Date.now() - Date.parse(last.at)) / 1000)) : 0;
  const end = useRef<HTMLLIElement>(null);
  const lines = events.slice(0, cursor).filter((e) => e.type !== 'hit' && (only === undefined || phaseOf(e) === only));
  const shown = limit ? lines.slice(-limit) : lines;
  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: 'nearest' });
  }, [shown.length, follow]);
  if (!shown.length) return <p className="quiet">Jeszcze nic się tu nie wydarzyło.</p>;
  return (
    <ol className="runlog" aria-live="polite">
      {shown.map((e) => (
        <li key={e.seq} className={toneOf(e)}>
          <time>{e.at.slice(11, 19)}</time>
          <span className="runlog-step" title={PHASE_NAME[phaseOf(e)]}>
            {phaseOf(e)}
          </span>
          <span>{describe(e)}</span>
        </li>
      ))}
      {working && idle >= 3 && (
        <li className="runlog-working">
          <time>teraz</time>
          <span className="runlog-step">…</span>
          <span>Silnik pracuje nad tym krokiem; od ostatniego zapisanego zdarzenia minęło {idle} s. Źródła zewnętrzne odpowiadają po kilka sekund każde.</span>
        </li>
      )}
      <li ref={end} className="runlog-end" aria-hidden="true" />
    </ol>
  );
}

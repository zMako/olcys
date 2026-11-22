import type { ReactNode } from 'react';
import type { RunDiff, RunSummary, StoredRunEvent } from '@olcys/engine';
import type { Graph, Layout } from './graph/model';
import { PHASE_NAME, RunLog } from './RunLog';
import { Layer, type CaseActions, type CaseInfo, type LayerKind, type LlmState, type Vault } from './Panel';

/** What every step of the case is given. `summary` is absent until the analysis (or its replay) has reached the result. */
export interface StepProps {
  summary?: RunSummary;
  graph: Graph;
  layout: Layout;
  events: StoredRunEvent[];
  cursor: number;
  caseInfo?: CaseInfo;
  actions?: CaseActions;
  llm?: LlmState;
  diff?: RunDiff | null;
  vault?: Vault;
  runId: string;
  selected?: string;
  status: string;
  onSelect(id?: string): void;
  onRules(): void;
  onStep(n: number): void;
  playback: { playing: boolean; setPlaying(p: boolean): void; speed: number; setSpeed(n: number): void; setCursor(n: number): void; atEnd: boolean };
}

/** One block of a step. Its heading says which of the three kinds of statement it holds. */
export function Card({ title, layer, note, children, wide }: { title: string; layer?: LayerKind; note?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={wide ? 'card wide' : 'card'}>
      <header className="card-head">
        <h2>{title}</h2>
        {layer && <Layer kind={layer} />}
      </header>
      {note && <p className="card-note">{note}</p>}
      {children}
    </section>
  );
}

/** Shown in a step whose content does not exist yet. */
export function Waiting({ status, events, cursor, phase }: { status: string; events: StoredRunEvent[]; cursor: number; phase: number }) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{status === 'failed' ? 'Analiza przerwana' : `Analiza trwa: ${PHASE_NAME[phase].toLowerCase()}`}</h2>
      </header>
      <p className="card-note">{status === 'failed' ? 'Analiza została przerwana, zanim ten krok został ukończony.' : 'Pełny wynik tego kroku pojawi się, gdy analiza dojdzie do końca. Poniżej to, co już ustalono.'}</p>
      <RunLog events={events} cursor={cursor} only={phase} follow={false} limit={10} />
    </section>
  );
}

/** A figure with its caption, for the handful of numbers a step leads with. */
export function Figures({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="figures">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

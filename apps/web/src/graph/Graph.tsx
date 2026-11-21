import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from 'react';
import { BAND, GROUP, moreAddresses, pln } from '../pl';
import type { Box, GEdge, GNode, Graph, Layout } from './model';

/** Confidence is an ordered scale, so it wears one hue from light to dark (validated ordinal ramp). */
export const BAND_COLOR: Record<string, string> = { noise: '#86b6ef', medium: '#5598e7', probable: '#256abf', very_high: '#104281' };
export const CRITICAL = '#d03b3b';
export const WARNING = '#fab219';
export const STAMP = '#4b3fa8';

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Eases node positions towards the layout so re-ordering reads as movement, not a jump. */
function useAnimatedBoxes(target: Map<string, Box>): Map<string, Box> {
  const current = useRef(new Map<string, Box>());
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  for (const [id, b] of target) if (!current.current.has(id)) current.current.set(id, { ...b });
  for (const id of [...current.current.keys()]) if (!target.has(id)) current.current.delete(id);

  useEffect(() => {
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    const step = () => {
      let moving = false;
      for (const [id, b] of target) {
        const c = current.current.get(id);
        if (!c) continue;
        c.x = b.x;
        c.w = b.w;
        c.h = b.h;
        const d = b.y - c.y;
        if (Math.abs(d) > 0.5 && !still) {
          c.y += d * 0.2;
          moving = true;
        } else c.y = b.y;
      }
      repaint();
      if (moving) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return current.current;
}

function edgeGeometry(a: Box, b: Box, sameColumn: boolean): { d: string; mx: number; my: number } {
  const y1 = a.y + a.h / 2;
  const y2 = b.y + b.h / 2;
  if (sameColumn) {
    // Links between accounts run down the left side of the column; the return direction bows further out.
    const bulge = (y2 < y1 ? 44 : 28) + Math.min(18, Math.abs(y2 - y1) / 10);
    return { d: `M${a.x},${y1} C${a.x - bulge},${y1} ${b.x - bulge},${y2} ${b.x},${y2}`, mx: a.x - bulge * 0.78, my: (y1 + y2) / 2 };
  }
  const x1 = a.x + a.w;
  const dx = (b.x - x1) * 0.5;
  return { d: `M${x1},${y1} C${x1 + dx},${y1} ${b.x - dx},${y2} ${b.x},${y2}`, mx: (x1 + b.x) / 2, my: (y1 + y2) / 2 };
}

function Cross({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`} aria-hidden="true">
      <circle r="8" fill={CRITICAL} />
      <path d="M-3.2,-3.2 L3.2,3.2 M3.2,-3.2 L-3.2,3.2" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </g>
  );
}

/** Seal for an address whose ownership is proven by a signed message. */
export function Seal({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`} aria-hidden="true">
      <circle r="8.5" fill={STAMP} />
      <path d="M-4,0.4 L-1.2,3.2 L4.2,-3" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

function Warn({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x},${y})`} aria-hidden="true">
      <path d="M0,-8.5 L9,7 L-9,7 Z" fill={WARNING} stroke="#0b0b0b" strokeWidth="0.8" strokeLinejoin="round" />
      <path d="M0,-3 L0,2.2 M0,4.6 L0,4.7" stroke="#0b0b0b" strokeWidth="1.6" strokeLinecap="round" />
    </g>
  );
}

function NodeMark({ n, b }: { n: GNode; b: Box }) {
  if (n.type === 'seed') {
    return (
      <>
        <rect className="n-seed" width={b.w} height={b.h} rx="4" />
        <text className="t-seed" x="12" y="21">{cut(n.title, 15)}</text>
        <text className="t-seed-sub" x="12" y="38">{n.sub}</text>
      </>
    );
  }
  if (n.type === 'account') {
    if (n.thirdParty) {
      return (
        <>
          <rect className="n-third" width={b.w} height={b.h} rx="3" />
          <text className="t-third" x="10" y="20">{cut(`${n.title}, ${n.sub}`, 30)}</text>
        </>
      );
    }
    const nameOnly = n.clusterLevel?.startsWith('name');
    return (
      <>
        <rect className={`n-box${nameOnly ? ' dashed' : ''}`} width={b.w} height={b.h} rx="4" />
        {n.clusterId && !nameOnly && <rect className="n-bar" width="4" height={b.h} rx="2" />}
        <text className="t-title" x="16" y="21">{cut(n.title, 22)}</text>
        <text className="t-sub" x="16" y="38">{n.changed ? `${n.sub}, podmienił adres` : n.viaWallet ? `${n.sub}, przez łańcuch` : n.sub}</text>
        {n.fresh && <text className="t-fresh" x={b.w - 10} y="20" textAnchor="end">nowe</text>}
      </>
    );
  }
  if (n.type === 'estimate') {
    const years = n.years ?? [];
    return (
      <>
        <rect className="n-estimate" width={b.w} height={b.h} rx="4" />
        <text className="t-title" x="14" y="22">{n.title}</text>
        <text className="t-sub" x="14" y="38">skierowano do usług wyjścia</text>
        {years.map((y, i) => (
          <g key={y.year} transform={`translate(0,${62 + i * 24})`}>
            <text className="t-year" x="14" y="0">{y.year}</text>
            <text className="t-pln" x={b.w - 14} y="0" textAnchor="end">{pln(y.totalPln)}</text>
          </g>
        ))}
        <line className="sum-rule" x1="14" x2={b.w - 14} y1={50 + years.length * 24} y2={50 + years.length * 24} />
        <text className="t-year" x="14" y={70 + years.length * 24}>razem</text>
        <text className="t-pln total" x={b.w - 14} y={70 + years.length * 24} textAnchor="end">{pln(n.totalPln ?? 0)}</text>
      </>
    );
  }
  if (n.type === 'service') {
    return (
      <>
        <rect className="n-box" width={b.w} height={b.h} rx="4" />
        <text className="t-title" x="14" y="20">{cut(n.title, 20)}</text>
        <text className="t-sub" x="14" y="37">{cut(n.sub ?? '', 35)}</text>
        {n.cashOut && <Warn x={b.w - 20} y={18} />}
      </>
    );
  }
  // address
  const l = n.link;
  const rejected = l && l.status !== 'attributed';
  const sub = !l
    ? n.label ?? (n.accountKind ? 'sprawdzony w eksploratorze' : 'sprawdzam w eksploratorze…')
    : l.status === 'attributed'
      ? `${n.proven ? 'Potwierdzone podpisem' : BAND[l.band]}${n.walletSize ? `, ${moreAddresses(n.walletSize)}` : ''}`
      : l.status === 'excluded'
        ? `Wykluczone: ${n.label ?? l.reason.toLowerCase()}`
        : 'Cudzy adres, tylko zacytowany';
  return (
    <>
      <rect className="n-box" width={b.w} height={b.h} rx="4" />
      {rejected && <rect width="4" height={b.h} rx="2" fill={CRITICAL} />}
      <rect className="chain-tag" x="12" y="9" width="32" height="16" rx="2" />
      <text className="t-chain" x="28" y="21" textAnchor="middle">{n.sub}</text>
      <text className={`t-address${rejected ? ' struck' : ''}`} x="52" y="23">{n.title}</text>
      {l?.status === 'attributed' && (
        <>
          <text className="t-score" x={b.w - 12} y="23" textAnchor="end">{l.score}%</text>
          {n.proven && <Seal x={b.w - 68} y={17} />}
          <rect className="meter-track" x="12" y="29" width={b.w - 24} height="4" rx="2" />
          <rect x="12" y="29" width={Math.max(4, ((b.w - 24) * l.score) / 100)} height="4" rx="2" fill={BAND_COLOR[l.band]} />
        </>
      )}
      {rejected && <Cross x={b.w - 20} y={17} />}
      <text className="t-sub" x="12" y="45">{cut(sub, n.fresh ? 34 : 42)}</text>
      {n.fresh && <text className="t-fresh" x={b.w - 12} y="45" textAnchor="end">nowy</text>}
    </>
  );
}

function ariaLabel(n: GNode): string {
  if (n.type === 'seed') return `Wprowadzono: ${n.sub} ${n.title}`;
  if (n.type === 'account') return `Konto ${n.title} w serwisie ${n.sub}`;
  if (n.type === 'service') return `Usługa ${n.title}, ${n.sub}`;
  if (n.type === 'estimate') return `Szacunek do wyjaśnienia: razem ${pln(n.totalPln ?? 0)}`;
  return `Adres ${n.address}${n.link ? (n.link.status === 'attributed' ? `, Wskaźnik Pewności ${n.link.score}%` : ', odrzucony') : ''}`;
}

export function GraphView({ graph, layout, selected, onSelect }: { graph: Graph; layout: Layout; selected?: string; onSelect(id: string): void }) {
  const boxes = useAnimatedBoxes(layout.boxes);
  const [hover, setHover] = useState<string>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const near = new Set<string>();
  if (hover) {
    near.add(hover);
    for (const e of graph.edges) {
      if (e.from === hover) near.add(e.to);
      if (e.to === hover) near.add(e.from);
    }
  }
  const emphasised = (e: GEdge) => e.from === (hover ?? selected) || e.to === (hover ?? selected);
  const key = (id: string) => (ev: KeyboardEvent) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onSelect(id);
    }
  };

  // Outlines follow the animated positions of the accounts they hold.
  const groups = layout.groups.map((g) => {
    const members = graph.nodes.filter((n) => n.clusterId === g.id).map((n) => boxes.get(n.id)).filter((b): b is Box => !!b);
    if (!members.length) return { ...g, box: g.box };
    const top = Math.min(...members.map((b) => b.y)) - 8;
    const bottom = Math.max(...members.map((b) => b.y + b.h)) + 8;
    return { ...g, box: { x: g.box.x, w: g.box.w, y: top, h: bottom - top } };
  });

  return (
    <svg className="graph" viewBox={`0 0 ${layout.width} ${Math.max(layout.height, 320)}`} role="group" aria-label="Graf powiązań: od wprowadzonego identyfikatora do adresów i usług">
      {layout.columns.map((c) => (
        <g key={c.title}>
          <text className="col-title" x={c.x} y="18">{c.title}</text>
          <line className="col-rule" x1={c.x} x2={c.x + c.w} y1="28" y2="28" />
        </g>
      ))}

      {groups.map((g) => (
        <g key={g.id}>
          <rect className={`group${g.level.startsWith('name') ? ' dashed' : ''}`} x={g.box.x} y={g.box.y} width={g.box.w} height={g.box.h} rx="8" />
          <text className="group-title" x={g.box.x + 2} y={g.box.y - 6}>
            {GROUP[g.level]}{g.identityCap < 100 ? `, najwyżej ${g.identityCap}%` : ''}
          </text>
        </g>
      ))}
      {layout.othersY !== undefined && (
        <text className="group-title muted" x={layout.columns[1].x} y={layout.othersY}>Inne konta, które podały te same adresy</text>
      )}

      <g className="edges">
        {graph.edges.map((e) => {
          // Several flows into one service share one label block, so amounts never print over each other.
          const flowsIn = e.kind === 'flow' ? graph.edges.filter((x) => x.kind === 'flow' && x.to === e.to) : [];
          const flowLines = flowsIn[0]?.id === e.id ? flowsIn.flatMap((x) => (x.label ? x.label.split(' + ') : [])) : [];
          const [a, b] = [boxes.get(e.from), boxes.get(e.to)];
          if (!a || !b) return null;
          const g = edgeGeometry(a, b, byId.get(e.from)?.col === byId.get(e.to)?.col);
          const strong = emphasised(e);
          const cls = ['edge', `e-${e.kind}`, e.weak && 'weak', e.quoteOnly && 'quote', e.thirdParty && 'third', e.cashOut && 'cash', strong && 'strong', hover && !strong && 'dim']
            .filter(Boolean)
            .join(' ');
          const showLabel = e.kind === 'flow' ? flowLines.length > 0 : e.label && (e.kind === 'lead' || e.kind === 'wallet' || strong);
          // Labels sit where they cannot collide: amounts next to the service that received them,
          // places of publication at the far end from the node in focus.
          let label = { x: g.mx, y: g.my - 5, anchor: 'middle' as 'start' | 'middle' | 'end' };
          if (e.kind === 'lead') label = { x: g.mx - 4, y: g.my + 4, anchor: 'end' };
          else if (e.kind === 'flow') label = { x: b.x - 10, y: b.y + b.h / 2 - 7, anchor: 'end' };
          else if (e.kind === 'wallet') label = { x: a.x + a.w + 10, y: a.y + a.h / 2 + 14, anchor: 'start' };
          else if (e.kind === 'published') {
            label = (hover ?? selected) === e.to ? { x: a.x + a.w + 10, y: a.y + a.h / 2 - 7, anchor: 'start' } : { x: b.x - 10, y: b.y + b.h / 2 - 7, anchor: 'end' };
          }
          return (
            <g key={e.id} className={cls}>
              <path className="line" d={g.d} pathLength="1" />
              {e.cashOut && <path className="flow" d={g.d} />}
              {showLabel &&
                // An amount in two assets is set on two lines so it fits between the columns.
                (e.kind === 'flow' ? flowLines : [cut(e.label, 22)]).map((line, i, all) => (
                  <text key={i} className="edge-label" x={label.x} y={label.y - (all.length - 1 - i) * 15} textAnchor={label.anchor}>
                    {line}
                  </text>
                ))}
            </g>
          );
        })}
      </g>

      {graph.nodes.map((n) => {
        const b = boxes.get(n.id);
        if (!b) return null;
        const cls = ['node', `node-${n.type}`, selected === n.id && 'selected', graph.touched.includes(n.id) && 'touched', hover && !near.has(n.id) && 'dim'].filter(Boolean).join(' ');
        return (
          <g
            key={n.id}
            className={cls}
            transform={`translate(${b.x},${b.y})`}
            role="button"
            tabIndex={0}
            aria-label={ariaLabel(n)}
            aria-pressed={selected === n.id}
            onClick={() => onSelect(n.id)}
            onKeyDown={key(n.id)}
            onMouseEnter={() => setHover(n.id)}
            onMouseLeave={() => setHover(undefined)}
          >
            <rect className="hit" x="-4" y="-4" width={b.w + 8} height={b.h + 8} />
            <g className="mark">
              <NodeMark n={n} b={b} />
            </g>
            <rect className="ring" x="-3" y="-3" width={b.w + 6} height={b.h + 6} rx="6" />
          </g>
        );
      })}
    </svg>
  );
}

export function Legend() {
  return (
    <ul className="legend" aria-label="Legenda">
      <li className="legend-title">Wskaźnik Pewności</li>
      {(['noise', 'medium', 'probable', 'very_high'] as const).map((b, i) => (
        <li key={b}>
          <span className="swatch" style={{ background: BAND_COLOR[b] }} />
          {BAND[b]} {['1–39%', '40–59%', '60–79%', '80–100%'][i]}
        </li>
      ))}
      <li>
        <svg width="19" height="19" viewBox="-9.5 -9.5 19 19" aria-hidden="true"><Seal x={0} y={0} /></svg>
        Potwierdzone podpisem
      </li>
      <li>
        <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true"><Cross x={0} y={0} /></svg>
        Wykluczone
      </li>
      <li>
        <svg width="20" height="18" viewBox="-10 -9 20 18" aria-hidden="true"><Warn x={0} y={0} /></svg>
        Możliwe wyjście do walut tradycyjnych
      </li>
    </ul>
  );
}

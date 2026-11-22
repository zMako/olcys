import { useState } from 'react';
import type { RunParams } from '@olcys/engine';
import type { Link } from '@olcys/scoring';
import { SOURCES } from './api';
import { BAND_COLOR, GraphView, Legend } from './graph/Graph';
import { addressId } from './graph/model';
import { EVERY, STATEMENT_KIND, changeNote, second } from './Panel';
import { ACCOUNT_KIND, BAND, CHAIN, GROUP, KIND, OBFUSCATION, PLACEMENT, day, describe, minute, pln, shortAddress } from './pl';
import { RunLog } from './RunLog';
import { Card, Figures, Waiting, type StepProps } from './step-kit';

const SPEEDS = [1, 2, 4];

// ---------------------------------------------------------------------------------------------- 1. Wejście

/** The search parameters in the analyst's words: what each limit means for the result. */
const PARAMS: [keyof RunParams, string, string][] = [
  ['maxDepth', 'Głębokość poszukiwań', 'ile kroków od wprowadzonych danych: konto, dane z jego profilu, kolejne konto'],
  ['maxRounds', 'Przejścia między siecią a łańcuchem bloków', 'ile razy analiza wraca do sieci z tym, czego dowiedziała się z łańcucha bloków'],
  ['maxIdentifiers', 'Najwięcej sprawdzonych tropów', 'górna granica identyfikatorów przeszukanych w jednej analizie'],
  ['maxSimilarHandles', 'Konta o podobnym nicku', 'ile kont, których nick tylko zawiera wprowadzony, jest czytanych jako kandydaci'],
  ['maxArchivedProfiles', 'Profile sprawdzane w archiwum', 'dla ilu profili osoby pobierane są dawne wersje strony'],
  ['maxImages', 'Zdjęcia czytane w poszukiwaniu kodów', 'ile zdjęć z ogłoszeń i profili jest sprawdzanych pod kątem kodów QR z adresem'],
  ['maxChainAddresses', 'Adresy z pełną analizą łańcucha', 'dla ilu przypisanych adresów pobierana jest historia przelewów'],
  ['maxCounterparties', 'Kontrahenci sprawdzani na adres', 'ilu odbiorców i nadawców jest sprawdzanych: czy to giełda, kontrakt, usługa'],
  ['maxHops', 'Odbiorcy śledzeni o krok dalej', 'ilu nieoznaczonych odbiorców jest sprawdzanych, czy przekazali środki na giełdę'],
  ['maxWalletSearches', 'Adresy portfela szukane w sieci', 'ile adresów ustalonych z łańcucha bloków jest wyszukiwanych w otwartych źródłach'],
];

export function StepInput({ summary, caseInfo, actions, diff, status, onRules, runId, events, cursor }: StepProps) {
  if (!summary) return <Waiting status={status} events={events} cursor={cursor} phase={1} />;
  const seeds = summary.identifiers.filter((i) => i.origin === 'seed');
  const extra = summary.params as unknown as { connectors?: { id: string; name: string; hosts: string[]; synthetic: boolean }[]; allowlist?: string[] };
  return (
    <>
      <Card title="Co wprowadzono" layer="fact">
        <table className="grid kv">
          <thead>
            <tr>
              <th>Rodzaj identyfikatora</th>
              <th>Wartość</th>
            </tr>
          </thead>
          <tbody>
            {seeds.map((i) => (
              <tr key={i.kind + i.value}>
                <td>{KIND[i.kind] ?? i.kind}</td>
                <td className={i.kind === 'crypto_address' ? 'mono' : ''}>{i.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="quiet">
          Źródła: {SOURCES[caseInfo?.sources ?? ''] ?? '—'}. Od tych danych analiza doszła do {summary.identifiers.length} tropów; każdy sprawdzony trop i miejsce, z którego pochodzi, są w kroku 2.
        </p>
      </Card>

      {diff && (
        <Card title="Co się zmieniło od poprzedniej analizy" layer="computed">
          <p className={diff.changed ? 'changes' : 'quiet'}>
            {diff.summary} Porównano z analizą z {minute(diff.baseAt)} UTC.
          </p>
          <ul className="changes-list">
            {[...diff.links, ...diff.profiles, ...diff.accounts, ...diff.indicators].map((c, i) => (
              <li key={i}>{c.text}</li>
            ))}
            {diff.estimate.map((y) => (
              <li key={y.year}>
                Szacunek za {y.year}: {pln(y.before)} → {pln(y.after)}.
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Parametry wyszukiwania" layer="fact" note="Granice, w których działała ta analiza. Są zapisane razem z wynikiem, więc analizę można powtórzyć na tych samych zasadach.">
        <table className="grid params">
          <tbody>
            {PARAMS.map(([key, label, hint]) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td className="num">{String(summary.params[key])}</td>
                <td className="quiet">{hint}</td>
              </tr>
            ))}
            <tr>
              <th scope="row">Reguły punktacji</th>
              <td className="num">{summary.assessment?.ruleset.version ?? '—'}</td>
              <td className="quiet">
                {summary.assessment?.ruleset.name}.{' '}
                <button className="linklike" onClick={onRules}>
                  Pokaż reguły
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {!!extra.connectors?.length && (
        <Card title="Źródła użyte w tej analizie" layer="fact" note="Analiza łączy się wyłącznie z hostami z tej listy. Każda próba połączenia z innym jest odrzucana i zapisywana.">
          <table className="grid">
            <thead>
              <tr>
                <th>Źródło</th>
                <th>Hosty</th>
              </tr>
            </thead>
            <tbody>
              {extra.connectors.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="mono small">{c.hosts.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="quiet">
            {summary.counts.denied === 0 ? 'Żadne połączenie nie wyszło poza listę dozwolonych źródeł.' : `Zablokowano ${summary.counts.denied} połączeń spoza listy dozwolonych źródeł.`}
          </p>
        </Card>
      )}

      {caseInfo && actions && (
        <Card title="Analizy tej sprawy" layer="fact" note="Wynik każdej analizy jest zapisany. Analizę można powtarzać cyklicznie; ta, która wykryje zmiany, otworzy się sama i pokaże ich listę.">
          <div className="case-controls">
            <label>
              Powtarzaj{' '}
              <select value={caseInfo.schedule?.everySeconds ?? 0} onChange={(e) => actions.setSchedule(Number(e.target.value) || null)}>
                <option value={0}>tylko na żądanie</option>
                {EVERY.map(([seconds, label]) => (
                  <option key={seconds} value={seconds}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={actions.rerun}>Analizuj ponownie teraz</button>
            {caseInfo.schedule && <span className="quiet">Następna analiza: {second(caseInfo.schedule.nextRunAt)} UTC.</span>}
          </div>
          <table className="grid">
            <thead>
              <tr>
                <th>Kiedy (UTC)</th>
                <th>Jak uruchomiona</th>
                <th>Co wykazała względem poprzedniej</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...caseInfo.runs].reverse().slice(0, 12).map((r) => (
                <tr key={r.id} className={r.id === runId ? 'current' : ''}>
                  <td>{second(r.startedAt)}</td>
                  <td>{r.trigger === 'schedule' ? 'cyklicznie' : 'na żądanie'}</td>
                  <td className={r.changes?.changed ? 'changes' : ''}>{changeNote(r)}</td>
                  <td>{r.id === runId ? 'otwarta' : r.status === 'completed' ? <button onClick={() => actions.openRun(r.id)}>Otwórz</button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 2. Ślady w sieci

/** The search as a picture that grows with every recorded step, with the controls of its replay. */
export function Board({ graph, layout, events, cursor, selected, onSelect, playback }: StepProps) {
  const step = events.slice(0, cursor).reverse().find((e) => e.type !== 'hit');
  const { playing, setPlaying, speed, setSpeed, setCursor, atEnd } = playback;
  return (
    <section className="card board wide">
      <header className="card-head">
        <h2>Przebieg poszukiwań</h2>
        <span className="quiet">Od wprowadzonych danych, przez konta w sieci i adresy, do usług, w których środki mogły zostać zamienione na walutę tradycyjną.</span>
      </header>
      {events.length > 0 && (
          <div className="playback">
            <button
              className="play"
              onClick={() => {
                if (atEnd) setCursor(0);
                setPlaying(atEnd ? true : !playing);
              }}
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
              <p className="step-line" aria-live="off">
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
      )}
      <div className="board-scroll">
        {events.length === 0 ? <p className="quiet">Analiza się rozpoczyna…</p> : <GraphView graph={graph} layout={layout} selected={selected} onSelect={onSelect} />}
      </div>
      {events.length > 0 && <Legend />}
    </section>
  );
}

export function StepTraces(props: StepProps) {
  const { summary, graph, events, cursor, selected, onSelect, actions, llm, status } = props;
  const clusters = summary?.assessment?.clusters ?? [];
  const firm = (level: string) => level === 'entered' || level === 'publisher';
  const rows = clusters.flatMap((c) => c.accounts.map((a) => ({ c, a })));
  const published = (origin: string, handle: string) => (summary?.addresses ?? []).filter((x) => x.occurrences.some((o) => o.origin === origin && o.author_handle === handle)).length;
  const nodeOf = (origin: string, handle: string) => graph.nodes.find((n) => n.type === 'account' && n.origin === origin && n.handle?.toLowerCase() === handle.toLowerCase());

  return (
    <>
      <Board {...props} />

      {!summary ? (
        <Card title={status === 'failed' ? 'Analiza przerwana' : 'Analiza trwa: co już ustalono'}>
          <RunLog events={events} cursor={cursor} limit={12} follow={false} />
        </Card>
      ) : (
        <>
          <Card title="Konta znalezione w sieci" layer="computed" note="Które konta należą do badanej osoby, a które tylko ją przypominają. Konto niepotwierdzone jest trzymane osobno i ogranicza wynik adresów, które podaje.">
            <Figures
              items={[
                ['dokumentów pobranych z sieci', summary.counts.documents],
                ['tropów sprawdzonych', summary.identifiers.length],
                ['kont zaliczonych do osoby', rows.filter((r) => firm(r.c.level)).length],
                ['kont niepotwierdzonych', rows.filter((r) => !firm(r.c.level)).length],
                ['obcych kont z tymi samymi adresami', summary.assessment?.thirdPartyAccounts ?? 0],
              ]}
            />
            <table className="grid rows-click">
              <thead>
                <tr>
                  <th>Konto</th>
                  <th>Serwis</th>
                  <th>Czyje</th>
                  <th>Na jakiej podstawie</th>
                  <th className="num">Podane adresy</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, a }) => {
                  const node = nodeOf(a.origin, a.handle);
                  const why = firm(c.level)
                    ? c.joins.filter((j) => j.detail.includes(a.handle)).map((j) => j.detail)[0] ??
                      (node?.viaWallet ? 'podaje adres, który łańcuch bloków wiąże z adresem osoby' : c.level === 'entered' ? 'odpowiada wprowadzonemu identyfikatorowi' : 'opublikowało wprowadzony adres')
                    : c.identityNote;
                  const opinion = summary.judgements?.find((j) => j.origin === a.origin && j.handle === a.handle);
                  return (
                    <tr key={a.origin + a.handle} onClick={() => node && onSelect(node.id)} className={node && selected === node.id ? 'current' : ''}>
                      <td>
                        <button className="linklike strong" onClick={() => node && onSelect(node.id)}>
                          {a.handle}
                        </button>
                        {a.displayName && <div className="quiet">{a.displayName}</div>}
                      </td>
                      <td>{a.source}</td>
                      <td>{firm(c.level) ? 'badanej osoby' : <span className="warn">{GROUP[c.level] ?? c.level}, wynik najwyżej {c.identityCap}%</span>}</td>
                      <td className="why">
                        {why.charAt(0).toUpperCase() + why.slice(1)}
                        {opinion && (
                          <div className="quiet">
                            Opinia modelu językowego (pomocnicza): {opinion.verdict === 'same' ? 'prawdopodobnie ta sama osoba' : opinion.verdict === 'different' ? 'prawdopodobnie inna osoba' : 'nie da się rozstrzygnąć'}.
                            {opinion.reasons[0] ? ` ${opinion.reasons[0]}` : ''}
                          </div>
                        )}
                      </td>
                      <td className="num">{published(a.origin, a.handle)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {graph.histories.length > 0 && (
            <Card title="Zmiany na profilach w czasie" layer="fact">
              {graph.histories.map((h) => (
                <p key={h.origin + h.handle}>
                  {h.changes[0].detail}{' '}
                  <button className="linklike" onClick={() => onSelect(`acc:${h.origin}:${h.handle.toLowerCase()}`)}>
                    Pokaż wersje profilu {h.handle}
                  </button>
                </p>
              ))}
            </Card>
          )}

          {summary.reading && (
            <Card title="Co osoba sama napisała o swoich kryptowalutach" layer="computed" note="Wypowiedź wskazuje, gdzie szukać. Nie jest dowodem transakcji i nie zmienia Wskaźnika Pewności.">
              <p>
                Przeczytano {summary.reading.posts} wpisów i ogłoszeń osoby. {summary.reading.generated > 0 && <>{summary.reading.generated} napisały aplikacje — pominięto. </>}
                {summary.reading.statements.length ? `W ${summary.reading.statements.length} autor najpewniej mówi o własnych transakcjach lub stanie posiadania.` : 'W żadnym autor nie mówi o własnych transakcjach.'}
              </p>
              <ul className="statements">
                {summary.reading.statements.map((x) => (
                  <li key={x.documentId} className={x.detail && !x.detail.concernsAuthor ? 'dismissed' : ''}>
                    <q>
                      {x.text.replace(/\s+/g, ' ').slice(0, 260)}
                      {x.text.length > 260 ? '…' : ''}
                    </q>
                    <div className="proof">
                      {x.at ? `${day(x.at)}, ` : ''}trafność {Math.round(x.relevance * 100)}%
                      {x.url && (
                        <>
                          ,{' '}
                          <a href={x.url} target="_blank" rel="noreferrer">
                            źródło
                          </a>
                        </>
                      )}
                    </div>
                    {x.detail && (
                      <div className="note">
                        Model językowy:{' '}
                        {x.detail.concernsAuthor
                          ? `${STATEMENT_KIND[x.detail.kind] ?? x.detail.kind}${x.detail.amount ? ` ${x.detail.amount}` : ''}${x.detail.asset ? ` ${x.detail.asset}` : ''}${x.detail.when ? `, ${x.detail.when}` : ''}. `
                          : 'to nie jest wypowiedź o własnych transakcjach autora. '}
                        {x.detail.reason}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {actions && llm?.available && summary.reading.statements.some((x) => !x.detail) && (
                <div className="case-controls">
                  <button onClick={actions.readPosts} disabled={!!llm.busy}>
                    {llm.busy === 'read' ? 'Model czyta wpisy…' : 'Przeczytaj modelem językowym'}
                  </button>
                  <span className="quiet">{llm.model.split('/').pop()}, na tej maszynie</span>
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 3. Adresy i pewność

const PLACEMENT_ORDER = ['own_profile', 'sale', 'discussion', 'mass_comment', 'quoted'] as const;

/** Where the address stood, by its strongest place of publication: the category the score starts from. */
const categoryOf = (l: Link) => {
  const p = PLACEMENT_ORDER.find((x) => l.occurrences.some((o) => o.placement === x));
  if (p) return PLACEMENT[p];
  const first = l.receipt[0];
  return first?.rule === 'I1' ? 'wprowadzony przez analityka' : first?.rule === 'K3' ? 'twórca kontraktu osoby' : first?.rule === 'W2' ? 'ten sam portfel' : (first?.title.toLowerCase() ?? '—');
};

/** How the address was found in the source and what was checked about it. */
const detectionOf = (l: Link) => {
  const parts = new Set<string>();
  for (const o of l.occurrences) {
    if (o.image || o.method === 'qr') parts.add('kod QR na zdjęciu');
    else if (o.method === 'ens') parts.add('nazwa w łańcuchu bloków');
    else if (o.method === 'deployer') parts.add('twórca kontraktu');
    else if (o.obfuscation.length) parts.add(`ukryty przed automatami: ${o.obfuscation.map((x) => OBFUSCATION[x] ?? x).join(', ')}`);
    else parts.add('jawny tekst');
    if (o.archivedAt) parts.add('kopia archiwalna');
  }
  if (!l.occurrences.length) parts.add(l.receipt[0]?.rule === 'I1' ? 'podany na wejściu' : 'ustalony z łańcucha bloków');
  if (l.proven) parts.add('podpis sprawdzony');
  return [...parts].join('; ');
};

type Filter = 'all' | 'mine' | 'uncertain' | 'rejected';

export function StepAddresses({ summary, status, selected, onSelect, onRules, events, cursor }: StepProps) {
  const [filter, setFilter] = useState<Filter>('all');
  if (!summary?.assessment) return <Waiting status={status} events={events} cursor={cursor} phase={3} />;
  const a = summary.assessment;
  const firm = new Set(a.clusters.filter((c) => c.level === 'entered' || c.level === 'publisher').map((c) => c.id));
  const kind = (l: Link): Exclude<Filter, 'all'> => (l.status !== 'attributed' ? 'rejected' : firm.has(l.clusterId) ? 'mine' : 'uncertain');
  const order = { mine: 0, uncertain: 1, rejected: 2 };
  const links = [...a.links].sort((x, y) => order[kind(x)] - order[kind(y)] || y.score - x.score);
  const count = (k: Filter) => (k === 'all' ? links.length : links.filter((l) => kind(l) === k).length);
  const shown = links.filter((l) => filter === 'all' || kind(l) === filter);
  const chained = summary.chain.activity.reduce((n, w) => n + Math.max(0, w.wallet.length - 1), 0);
  const FILTERS: [Filter, string][] = [['all', 'Wszystkie'], ['mine', 'Przypisane osobie'], ['uncertain', 'Niepewna tożsamość'], ['rejected', 'Odrzucone']];

  return (
    <Card
      title="Adresy i Wskaźnik Pewności"
      layer="computed"
      wide
      note={
        <>
          Każdy wykryty adres przeszedł kontrolę formatu i sumy kontrolnej swojej sieci; ciąg, który jej nie przechodzi, nie trafia na listę. Wynik liczą wyłącznie reguły, więc te same źródła dają zawsze ten sam wynik.{' '}
          <button className="linklike" onClick={onRules}>
            Pokaż reguły
          </button>
          . Wybierz wiersz, aby zobaczyć wyliczenie i źródła.
        </>
      }
    >
      <div className="chips" role="group" aria-label="Które adresy pokazać">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)} aria-pressed={filter === k} disabled={count(k) === 0}>
            {label} <span className="chip-n">{count(k)}</span>
          </button>
        ))}
      </div>
      <table className="grid rows-click addresses">
        <thead>
          <tr>
            <th>Adres</th>
            <th>Wskaźnik Pewności</th>
            <th>Kategoria powiązania</th>
            <th>Jak wykryto</th>
            <th className="num">Źródła</th>
            <th>Rodzaj adresu</th>
            <th>Rozstrzygnięcie</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((l) => {
            const id = addressId(l.chain, l.address);
            const k = kind(l);
            const services = new Set(l.occurrences.map((o) => o.origin)).size;
            const reason = l.receipt.find((r) => r.effect === 'exclusion')?.title ?? BAND[l.band];
            return (
              <tr key={l.clusterId + id} onClick={() => onSelect(id)} className={`${selected === id ? 'current ' : ''}${k}`}>
                <td>
                  <button className="linklike mono" onClick={() => onSelect(id)} title={l.address}>
                    {shortAddress(l.address)}
                  </button>
                  <div className="quiet">{CHAIN[l.chain] ?? l.chain}</div>
                </td>
                <td className="score">
                  {k === 'rejected' ? (
                    <span className="score-n off">0%</span>
                  ) : (
                    <>
                      <span className="score-n">{l.score}%</span>
                      <span className="meter">
                        <span style={{ width: `${l.score}%`, background: BAND_COLOR[l.band] }} />
                      </span>
                      <span className="quiet">{BAND[l.band]}</span>
                    </>
                  )}
                </td>
                <td>{categoryOf(l)}</td>
                <td>{detectionOf(l)}</td>
                <td className="num">
                  {l.occurrences.length ? (
                    <>
                      {l.occurrences.length}
                      <div className="quiet">{services === 1 ? 'jeden serwis' : `serwisy: ${services}`}</div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {l.account ? ACCOUNT_KIND[l.account.kind] ?? l.account.kind : 'nie sprawdzono'}
                  {l.account?.labels[0] && <div className="quiet">„{l.account.labels[0].name}”</div>}
                </td>
                <td>
                  {k === 'mine' ? <span className="verdict yes">Przypisany osobie</span> : k === 'uncertain' ? <span className="verdict maybe">Możliwe, że inna osoba</span> : <span className="verdict no">Odrzucony: {reason.toLowerCase()}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {chained > 0 && (
        <p className="quiet">
          Łańcuch bloków wskazał jeszcze {chained} {chained === 1 ? 'adres' : 'adresów'} tych samych portfeli (wydawane w jednej transakcji albo wpłacające na ten sam adres depozytowy). Są w kroku 4.
        </p>
      )}
    </Card>
  );
}

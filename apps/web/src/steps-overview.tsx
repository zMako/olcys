import { knowsIdentity } from '@olcys/core';
import { BAND_COLOR } from './graph/Graph';
import { addressId } from './graph/model';
import { BAND, CHAIN, amounts, day, pln, shortAddress } from './pl';
import { Card, Waiting, type StepProps } from './step-kit';

const sum = (lists: { asset: string; amount: number }[][]) => {
  const m = new Map<string, number>();
  for (const list of lists) for (const x of list) m.set(x.asset, (m.get(x.asset) ?? 0) + x.amount);
  return [...m].map(([asset, amount]) => ({ asset, amount }));
};

/**
 * The case on one screen, for the analyst who has just run it: what is known, how sure it is, how much went
 * where, who can name the owner, and what is missing. Everything longer — the steps, the report — is one click away.
 */
export function StepOverview({ summary, status, events, cursor, diff, onStep, onSelect, actions, llm }: StepProps) {
  if (!summary) return <Waiting status={status} events={events} cursor={cursor} phase={2} />;
  const a = summary.assessment;
  const firm = new Set((a?.clusters ?? []).filter((c) => c.level === 'entered' || c.level === 'publisher').map((c) => c.id));
  const links = a?.links ?? [];
  const mine = links.filter((l) => l.status === 'attributed' && firm.has(l.clusterId)).sort((x, y) => y.score - x.score);
  const uncertain = links.filter((l) => l.status === 'attributed' && !firm.has(l.clusterId));
  const rejected = links.filter((l) => l.status !== 'attributed');
  const accounts = (a?.clusters ?? []).filter((c) => firm.has(c.id)).flatMap((c) => c.accounts);
  const e = summary.estimate;
  const ramps = summary.chain.activity.flatMap((w) => w.offRamps);
  const byExchange = new Map<string, typeof ramps>();
  for (const o of ramps) byExchange.set(o.exchange, [...(byExchange.get(o.exchange) ?? []), o]);
  const issuers = [...new Set((summary.attestations ?? []).filter(knowsIdentity).map((x) => x.issuer))];
  const country = summary.attestations?.find((x) => x.claim === 'verified_country')?.value;
  const knows = [...new Set([...byExchange.keys(), ...issuers])];
  const other = summary.chain.activity.flatMap((w) => w.indicators).filter((i) => i.cashOut && i.type !== 'exchange' && i.type !== 'stablecoin_swap');
  const proven = mine.filter((l) => l.proven).length;

  // An analysis that was cut short has no scores and no estimate; what it stored on the way is partial and must not read as a result.
  if (summary.status === 'failed') {
    return (
      <section className="card overview-failed" role="alert">
        <header className="card-head">
          <h2>Ta analiza nie została dokończona</h2>
        </header>
        <p>{summary.error ?? 'Analiza została przerwana.'}</p>
        <p>
          Zanim została przerwana, zapisała część danych{ramps.length ? ` (m.in. wpłaty na giełdy: ${[...byExchange.keys()].join(', ')})` : ''}, ale nie doszła do oceny adresów ani do wyliczenia kwoty. Liczb z tej analizy nie należy traktować jak wyniku.
        </p>
        {actions && (
          <div className="case-controls">
            <button onClick={actions.rerun}>Analizuj ponownie</button>
          </div>
        )}
      </section>
    );
  }

  return (
    <>
      <section className="card overview">
        <div className="overview-main">
          <p className="kicker">Wartość do wyjaśnienia</p>
          <p className="overview-sum">{e?.totalPln ? pln(e.totalPln) : 'brak'}</p>
          <p>
            {e?.totalPln
              ? 'Tyle były warte kryptowaluty, które z adresów tej osoby trafiły do giełd i innych usług, gdzie można je zamienić na walutę tradycyjną. To kwota do wyjaśnienia, nie kwota podatku.'
              : 'Nie stwierdzono przelewów z adresów tej osoby do giełd ani innych usług wyjścia do walut tradycyjnych.'}
          </p>
          {!!e?.years.length && (
            <table className="grid overview-years">
              <tbody>
                {e.years.map((y) => (
                  <tr key={y.year}>
                    <th scope="row">{y.year}</th>
                    <td className="num strong">{pln(y.totalPln)}</td>
                    <td className="quiet">
                      zbycie prawdopodobne {pln(y.probablePln)}, możliwe {pln(y.possiblePln)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!!e?.unvalued && <p className="quiet">Bez wyceny pozostało przelewów: {e.unvalued} (aktywo bez kursu albo brak kursu z danego dnia).</p>}
        </div>
        <dl className="overview-facts">
          <div>
            <dt>kont osoby w sieci</dt>
            <dd>{accounts.length}</dd>
          </div>
          <div>
            <dt>adresów przypisanych</dt>
            <dd>{mine.length}</dd>
          </div>
          <div>
            <dt>w tym potwierdzonych podpisem</dt>
            <dd>{proven}</dd>
          </div>
          <div>
            <dt>przypisań odrzuconych</dt>
            <dd>{rejected.length}</dd>
          </div>
        </dl>
      </section>

      {diff?.changed && (
        <Card title="Od poprzedniej analizy" layer="computed">
          <p className="changes">{diff.summary}</p>
          <button className="linklike" onClick={() => onStep(1)}>
            Pokaż porównanie
          </button>
        </Card>
      )}

      <div className="overview-grid">
        <Card title="Dokąd trafiły środki" layer="computed">
          {byExchange.size === 0 && other.length === 0 ? (
            <p>Nie stwierdzono wpłat na giełdy ani do innych usług wymiany.</p>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Usługa</th>
                  <th className="num">Wpłat</th>
                  <th>Kwoty</th>
                  <th>Okres</th>
                </tr>
              </thead>
              <tbody>
                {[...byExchange].map(([name, list]) => {
                  const deposits = list.flatMap((o) => o.deposits).sort((x, y) => x.at.localeCompare(y.at));
                  return (
                    <tr key={name}>
                      <td>
                        <strong>{name}</strong>
                        <div className="quiet">giełda</div>
                      </td>
                      <td className="num">{deposits.length}</td>
                      <td>{amounts(sum([deposits]).slice(0, 3))}</td>
                      <td>{day(deposits[0].at) === day(deposits[deposits.length - 1].at) ? day(deposits[0].at) : `${day(deposits[0].at)} – ${day(deposits[deposits.length - 1].at)}`}</td>
                    </tr>
                  );
                })}
                {other.map((i, k) => (
                  <tr key={k}>
                    <td>
                      <strong>{[...new Set(i.counterparties.map((c) => (c.name ?? shortAddress(c.address)).split(':')[0]))].slice(0, 2).join(', ')}</strong>
                      <div className="quiet">{i.title.toLowerCase()}</div>
                    </td>
                    <td className="num">{i.count}</td>
                    <td>{amounts(i.totals.slice(0, 3))}</td>
                    <td>{day(i.firstAt) === day(i.lastAt) ? day(i.firstAt) : `${day(i.firstAt)} – ${day(i.lastAt)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button className="linklike" onClick={() => onStep(4)}>
            Wszystkie przepływy i chronologia (krok 4)
          </button>
        </Card>

        <Card title="Kto może wskazać właściciela" layer="hypothesis">
          {knows.length ? (
            <>
              <p>
                <strong>{knows.join(', ')}</strong>
              </p>
              <ul className="plain-list">
                {byExchange.size > 0 && <li>Giełda przydziela adres depozytowy jednemu, zweryfikowanemu klientowi.</li>}
                {issuers.length > 0 && (
                  <li>
                    {issuers.join(' i ')} publicznie {issuers.length === 1 ? 'poświadcza' : 'poświadczają'}, że {issuers.length === 1 ? 'sprawdził' : 'sprawdzili'} tożsamość właściciela adresu{country ? ` (kraj weryfikacji: ${country})` : ''}.
                  </li>
                )}
              </ul>
              <button className="linklike" onClick={() => onStep(5)}>
                Projekty zapytań (krok 5)
              </button>
            </>
          ) : (
            <p>Nie ustalono podmiotu, który zna tożsamość właściciela adresów.</p>
          )}
        </Card>
      </div>

      <Card title="Najmocniejsze powiązania" layer="computed" note={accounts.length ? `Konta osoby: ${accounts.slice(0, 6).map((x) => `${x.handle} (${x.source})`).join(', ')}${accounts.length > 6 ? ` i ${accounts.length - 6} innych` : ''}.` : 'Nie znaleziono konta w sieci, które opublikowało wprowadzony adres. Ustalenia dotyczą adresu, nie osoby.'}>
        {mine.length ? (
          <table className="grid rows-click addresses">
            <tbody>
              {mine.slice(0, 4).map((l) => (
                <tr key={l.address} onClick={() => { onStep(3); onSelect(addressId(l.chain, l.address)); }}>
                  <td>
                    <span className="mono">{shortAddress(l.address)}</span>
                    <div className="quiet">{CHAIN[l.chain] ?? l.chain}</div>
                  </td>
                  <td className="score">
                    <span className="score-n">{l.score}%</span>
                    <span className="meter">
                      <span style={{ width: `${l.score}%`, background: BAND_COLOR[l.band] }} />
                    </span>
                  </td>
                  <td>
                    {BAND[l.band]}
                    {l.proven ? ', potwierdzone podpisem' : ''}
                    <div className="quiet">{l.receipt.find((r) => r.effect !== 'info')?.title}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>Żadnego adresu nie udało się przypisać osobie.</p>
        )}
        <p className="quiet">
          {mine.length > 4 ? `Jeszcze ${mine.length - 4} przypisanych. ` : ''}
          {uncertain.length ? `Adresów z kont o niepewnej tożsamości: ${uncertain.length}. ` : ''}
          {rejected.length ? `Odrzucono ${rejected.length}: adresy giełd, kontraktów i cudze, tylko zacytowane. ` : ''}
          <button className="linklike" onClick={() => onStep(3)}>
            Wszystkie adresy z wyliczeniem (krok 3)
          </button>
        </p>
      </Card>

      {!!summary.gaps?.length && (
        <Card title="Czego brakuje" layer="fact">
          <p>
            Źródeł lub zapytań bez odpowiedzi: {summary.gaps.length}. Wynik może być niepełny; powtórzenie analizy zwykle uzupełnia braki.{' '}
            <button className="linklike" onClick={() => onStep(6)}>
              Pokaż listę (krok 6)
            </button>
          </p>
        </Card>
      )}

      <Card title="Co dalej">
        <div className="case-controls">
          <a className="button" href={`/api/runs/${summary.runId}/report.pdf`} target="_blank" rel="noreferrer">
            Pobierz raport PDF
          </a>
          <a className="button" href={`/api/runs/${summary.runId}/report`} target="_blank" rel="noreferrer">
            Otwórz raport
          </a>
          <button onClick={() => onStep(5)}>Projekty zapytań</button>
          <button onClick={() => onStep(2)}>Przebieg poszukiwań</button>
          {actions && llm?.available && (
            <button
              onClick={() => {
                actions.describeCase();
                onStep(5);
              }}
              disabled={!!llm.busy}
            >
              {llm.busy === 'describe' ? 'Model opracowuje sprawę…' : 'Opracuj sprawę modelem językowym'}
            </button>
          )}
        </div>
        <p className="quiet">Raport zawiera wszystkie kroki z pełnymi źródłami. Kroki 1–6 powyżej pokazują to samo po kolei, z możliwością sprawdzenia każdego ustalenia.</p>
      </Card>
    </>
  );
}

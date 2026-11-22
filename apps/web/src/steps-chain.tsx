import { useEffect, useState } from 'react';
import { knowsIdentity, type Transfer } from '@olcys/core';
import { draftAttestationRequest, draftRequest, type Indicator } from '@olcys/scoring';
import { getJson } from './api';
import { addressId } from './graph/model';
import { AUDIT, Dossier, EstimatePanel, RhythmStrip, modelPlace, modelShort, second } from './Panel';
import { CERTAINTY, amounts, day, minute, shortAddress } from './pl';
import { RunLog } from './RunLog';
import { Card, Figures, Waiting, type StepProps } from './step-kit';

// ---------------------------------------------------------------------------------------------- 4. Łańcuch bloków

/** The brief's four kinds of blockchain activity, and which indicator belongs to which. */
const GROUP_OF: Record<string, string> = {
  exchange: 'Wyjście do walut tradycyjnych', payment_gateway: 'Wyjście do walut tradycyjnych', card: 'Wyjście do walut tradycyjnych', otc: 'Wyjście do walut tradycyjnych',
  p2p: 'Usługa wymiany P2P', stablecoin_swap: 'Wymiana między kryptowalutami', exchange_inflow: 'Wpływ z giełdy', mixer: 'Mikser',
  sanctioned: 'Kontrahent z listy', reported: 'Kontrahent z listy',
};
const sum = (lists: { asset: string; amount: number }[][]) => {
  const m = new Map<string, number>();
  for (const list of lists) for (const x of list) m.set(x.asset, (m.get(x.asset) ?? 0) + x.amount);
  return [...m].map(([asset, amount]) => ({ asset, amount }));
};

export function StepChain({ summary, status, graph, onSelect, runId, events, cursor }: StepProps) {
  const [transfers, setTransfers] = useState<(Transfer & { subject: string })[]>();
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!summary) return;
    getJson<{ transfers: (Transfer & { subject: string })[] }>(`/api/runs/${runId}/transfers`).then((r) => setTransfers(r.transfers)).catch(() => setTransfers([]));
  }, [summary, runId]);
  if (!summary) return <Waiting status={status} events={events} cursor={cursor} phase={4} />;

  const wallets = summary.chain.activity;
  if (!wallets.length) {
    return (
      <Card title="Aktywność w łańcuchu bloków" layer="computed">
        <p>Żaden adres nie został przypisany osobie z wynikiem wystarczającym do analizy łańcucha bloków, albo źródło historii przelewów nie odpowiedziało. Braki są wymienione w kroku 6.</p>
      </Card>
    );
  }
  const indicators = wallets.flatMap((w) => w.indicators.map((i) => ({ w, i })));
  const ramps = wallets.flatMap((w) => w.offRamps.map((o) => ({ w, o })));
  const first = wallets.map((w) => w.activity.firstAt).filter(Boolean).sort()[0];
  const last = wallets.map((w) => w.activity.lastAt).filter(Boolean).sort().pop();
  const serviceNode = (i: Indicator) => graph.nodes.find((n) => n.type === 'service' && i.counterparties.some((c) => (n.addresses ?? [n.address]).includes(c.address)));

  // The chronology: every transfer of the analysed wallets once, with the other side named where it is known.
  const members = new Map<string, string>();
  for (const w of wallets) for (const m of w.wallet) members.set(m.address, w.address);
  const names = new Map<string, string>();
  for (const acc of summary.chain.accounts) if (acc.labels[0]) names.set(acc.address, acc.labels[0].name);
  for (const { o } of ramps) if (!names.has(o.depositAddress)) names.set(o.depositAddress, `${o.exchange}: adres depozytowy`);
  const seen = new Set<string>();
  const rows = (transfers ?? []).filter((t) => {
    const key = `${t.txHash}|${t.from}|${t.to}|${t.asset}|${t.amount}`;
    if (seen.has(key) || !(members.has(t.from) || members.has(t.to))) return false;
    seen.add(key);
    return true;
  });
  const named = rows.filter((t) => names.has(members.has(t.from) ? t.to : t.from));
  const shown = all ? rows : named.length ? named : rows.slice(-150);

  return (
    <>
      <Card title="Aktywność w łańcuchu bloków" layer="computed" note="Cztery rzeczy, o które pyta analiza łańcucha: łączny wolumen, wymiana między kryptowalutami, wyjście do walut tradycyjnych i korzystanie z usług wymiany, w tym P2P.">
        <Figures
          items={[
            ['portfeli osoby poddanych analizie', wallets.length],
            ['adresów w tych portfelach', wallets.reduce((n, w) => n + w.wallet.length, 0)],
            ['przelewów', wallets.reduce((n, w) => n + w.activity.transfers, 0)],
            ['okres aktywności', first && last ? `${day(first)} – ${day(last)}` : '—'],
          ]}
        />
        <table className="grid volume">
          <tbody>
            <tr>
              <th scope="row">Łączny wolumen otrzymany</th>
              <td>{amounts(sum(wallets.map((w) => w.activity.received)).slice(0, 8)) || '0'}</td>
            </tr>
            <tr>
              <th scope="row">Łączny wolumen wysłany</th>
              <td>{amounts(sum(wallets.map((w) => w.activity.sent)).slice(0, 8)) || '0'}</td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Card title="Wykryte wzorce" layer="computed" note="Przelew do usługi, w której kryptowalutę można zamienić na walutę tradycyjną, towar lub usługę, jest tropem do sprawdzenia, a nie ustaleniem zbycia.">
        {indicators.length === 0 ? (
          <p>Nie wykryto przelewów do giełd, usług P2P, bramek płatniczych, kart ani kantorów, ani znaczących wymian na stablecoiny.</p>
        ) : (
          <table className="grid rows-click">
            <thead>
              <tr>
                <th>Rodzaj</th>
                <th>Wzorzec</th>
                <th>Z portfela</th>
                <th className="num">Ile razy</th>
                <th>Kwoty</th>
                <th>Okres</th>
                <th>Znaczenie</th>
              </tr>
            </thead>
            <tbody>
              {indicators.map(({ w, i }) => {
                const node = serviceNode(i);
                return (
                  <tr key={w.address + i.type} onClick={() => node && onSelect(node.id)} className={i.cashOut ? 'cash' : ''}>
                    <td>{GROUP_OF[i.type] ?? 'Inne'}</td>
                    <td>
                      {node ? (
                        <button className="linklike strong" onClick={() => onSelect(node.id)}>
                          {i.title}
                        </button>
                      ) : (
                        <strong>{i.title}</strong>
                      )}{' '}
                      <code>{i.rule}</code>
                      <div className="quiet">{[...new Set(i.counterparties.map((c) => (c.name ?? shortAddress(c.address)).split(':')[0]))].slice(0, 4).join(', ')}</div>
                    </td>
                    <td className="mono">{shortAddress(w.address)}</td>
                    <td className="num">{i.count}</td>
                    <td>{amounts(i.totals.slice(0, 4))}</td>
                    <td>{day(i.firstAt) === day(i.lastAt) ? day(i.firstAt) : `${day(i.firstAt)} – ${day(i.lastAt)}`}</td>
                    <td>{i.certainty ? CERTAINTY[i.certainty] : i.cashOut ? 'często poprzedza wypłatę' : 'nie jest wyjściem z rynku'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {ramps.length > 0 && (
        <Card title="Giełdy, na które trafiły środki" layer="computed" note="Adres giełdy nie jest przypisywany osobie; odnotowany jest sam fakt wpłaty. Giełda przydziela adres depozytowy jednemu, zweryfikowanemu klientowi i to ona wie, kto nim jest.">
          <table className="grid">
            <thead>
              <tr>
                <th>Giełda</th>
                <th>Adres depozytowy</th>
                <th>Sieć</th>
                <th className="num">Wpłat</th>
                <th>Kwoty</th>
                <th>Po czym rozpoznano</th>
              </tr>
            </thead>
            <tbody>
              {ramps.map(({ w, o }) => (
                <tr key={w.address + o.depositAddress}>
                  <td>
                    <strong>{o.exchange}</strong>
                    {o.registered && (
                      <div className="quiet">
                        w polskim rejestrze walut wirtualnych: {o.registered.name}, {o.registered.number}
                      </div>
                    )}
                  </td>
                  <td className="mono">{shortAddress(o.depositAddress)}</td>
                  <td>{o.network ?? 'główna'}</td>
                  <td className="num">{o.deposits.length}</td>
                  <td>{amounts(sum([o.deposits]).slice(0, 4))}</td>
                  <td className="why">{o.rule === 'L1' ? 'publiczna etykieta adresu (L1)' : 'adres przekazał wpłaty dalej na portfel giełdy (D1)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {!!summary.attestations?.length && (
        <Card title="Co o adresach poświadczają instytucje" layer="fact" note="Poświadczenie nie wskazuje osoby. Giełda lub usługa, która sprawdziła dokumenty właściciela, może go wskazać na wniosek organu; pozostałe poświadczenia są okolicznościami.">
          <table className="grid rows-click">
            <thead>
              <tr>
                <th>Kto poświadcza</th>
                <th>Adres</th>
                <th>Co poświadcza</th>
                <th>Kiedy</th>
                <th>Gdzie sprawdzić</th>
              </tr>
            </thead>
            <tbody>
              {summary.attestations.map((x) => (
                <tr key={x.uid} onClick={() => onSelect(addressId(x.chain, x.address))}>
                  <td>
                    <strong>{x.issuer}</strong>
                    {knowsIdentity(x) && <div className="quiet">zna tożsamość właściciela</div>}
                  </td>
                  <td className="mono">{shortAddress(x.address)}</td>
                  <td className="why">{x.note ?? `${x.claim}${x.value ? `: ${x.value}` : ''}`}</td>
                  <td>{day(x.at)}</td>
                  <td>
                    {x.sourceUrl && (
                      <a href={x.sourceUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        poświadczenie
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card
        title="Chronologia przepływu środków"
        layer="fact"
        wide
        note={
          transfers === undefined
            ? 'Wczytuję przelewy…'
            : `Przelewy analizowanych portfeli w kolejności czasowej (czas UTC). ${all ? `Pokazano wszystkie: ${rows.length}.` : named.length ? `Pokazano ${named.length} przelewów z oznaczonymi podmiotami z ${rows.length} wszystkich.` : `Pokazano ostatnie ${shown.length} z ${rows.length}.`}`
        }
      >
        {rows.length > shown.length || all ? (
          <div className="case-controls">
            <button onClick={() => setAll(!all)}>{all ? 'Pokaż tylko przelewy z oznaczonymi podmiotami' : `Pokaż wszystkie przelewy (${rows.length})`}</button>
          </div>
        ) : null}
        {shown.length > 0 && (
          <table className="grid ledger">
            <thead>
              <tr>
                <th>Data</th>
                <th>Portfel</th>
                <th>Zdarzenie</th>
                <th className="num">Kwota</th>
                <th>Transakcja</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 600).map((t, k) => {
                const [mine, theirs] = [members.has(t.from), members.has(t.to)];
                const other = mine ? t.to : t.from;
                return (
                  <tr key={k}>
                    <td>{minute(t.at)}</td>
                    <td className="mono">{shortAddress(members.get(mine ? t.from : t.to) ?? '')}</td>
                    <td>{mine && theirs ? 'przeniesienie między własnymi adresami' : `${mine ? 'wypłata do' : 'wpływ od'}: ${names.get(other) ?? shortAddress(other)}`}</td>
                    <td className="num">
                      {mine && !theirs ? '−' : theirs && !mine ? '+' : ''}
                      {amounts([{ asset: t.asset, amount: t.amount }])}
                    </td>
                    <td className="mono small">
                      {t.txHash.slice(0, 12)}…{t.network ? <span className="quiet"> sieć {t.network}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {wallets.some((w) => w.wallet.length > 1) && (
        <Card title="Adresy tego samego portfela" layer="computed" note="Te adresy łączy łańcuch bloków: środki z nich wydano w jednej transakcji albo wpłacono z nich na ten sam, osobisty adres depozytowy giełdy.">
          <table className="grid">
            <thead>
              <tr>
                <th>Adres</th>
                <th>Portfel adresu</th>
                <th>Skąd wiadomo</th>
              </tr>
            </thead>
            <tbody>
              {wallets.flatMap((w) =>
                w.wallet.filter((m) => m.via).map((m) => (
                  <tr key={w.address + m.address}>
                    <td className="mono">{shortAddress(m.address)}</td>
                    <td className="mono">{shortAddress(w.address)}</td>
                    <td>{m.rule === 'D2' ? `wpłacał na ten sam adres depozytowy giełdy (${shortAddress(m.via!.with)})` : `wydany razem z ${shortAddress(m.via!.with)}, transakcja ${m.via!.txHash.slice(0, 10)}…`}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </Card>
      )}

      {(() => {
        const rhythm = summary.assessment?.clusters.find((c) => c.rhythm && (c.level === 'entered' || c.level === 'publisher'))?.rhythm;
        return rhythm && (rhythm.quiet || rhythm.webCount >= 5) ? (
          <Card title="Rytm doby" layer="computed">
            <RhythmStrip rhythm={rhythm} />
            <p>{rhythm.note}</p>
            {rhythm.conflicting.map((c) => (
              <p key={c.address} className="quiet">
                Adres <span className="mono">{shortAddress(c.address)}</span>: {c.inQuiet} z {c.transfers} przelewów w godzinach, w których osoba nie jest aktywna. Wynik tego adresu obniżono.{' '}
                <button className="linklike" onClick={() => onSelect(addressId(c.chain, c.address))}>
                  Pokaż adres
                </button>
              </p>
            ))}
          </Card>
        ) : null;
      })()}

      {graph.matches.length > 0 && (
        <Card title="Kwoty podane publicznie, zgodne z przelewami" layer="computed">
          <ul className="indicators">
            {graph.matches.map((m, i) => (
              <li key={i}>{m.detail}</li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 5. Wniosek

function RequestDraft({ title, basis, text }: { title: string; basis: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <div className="request">
      <div className="request-head">
        <div>
          <strong>{title}</strong>
          <div className="quiet">{basis}</div>
        </div>
        <button onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Zwiń projekt' : 'Pokaż projekt'}
        </button>
        <button onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>{copied ? 'Skopiowano' : 'Kopiuj'}</button>
      </div>
      {open && <pre className="draft">{text}</pre>}
    </div>
  );
}

export function StepConclusion({ summary, status, actions, llm, events, cursor }: StepProps) {
  if (!summary) return <Waiting status={status} events={events} cursor={cursor} phase={5} />;
  const ramps = summary.chain.activity.flatMap((a) => a.offRamps);
  const attested = (summary.attestations ?? []).filter(knowsIdentity).filter((x, i, all) => all.findIndex((y) => y.issuer === x.issuer && y.address === x.address) === i);
  const reasoning = (key: string) => {
    const note = summary.requestNotes?.find((r) => r.key === key);
    return note?.sentences.length ? `\n\nUzasadnienie (projekt napisany przez model językowy; w nawiasach ustalenia, na których opiera się zdanie):\n${note.sentences.map((x) => `${x.text} [${x.cites.join(', ')}]`).join(' ')}` : '';
  };
  const context = { caseTitle: summary.identifiers.filter((i) => i.origin === 'seed').map((i) => i.value).join(', '), runId: summary.runId, generatedAt: new Date().toISOString() };

  return (
    <>
      <section className="card">
        <EstimatePanel summary={summary} />
        {summary.estimate && summary.estimate.unvalued > 0 && (
          <p className="quiet">
            {summary.estimate.unvalued} {summary.estimate.unvalued === 1 ? 'przelew nie ma' : 'przelewów nie ma'} wyceny (aktywo bez kursu albo brak kursu z danego dnia) i nie wchodzi do kwoty.
          </p>
        )}
      </section>

      {(ramps.length > 0 || attested.length > 0) && (
        <Card title="Kto może wskazać właściciela" layer="hypothesis" note="Narzędzie nie ustala tożsamości. Wskazuje podmioty, które ją znają, i przygotowuje projekty zapytań z dokładnym wykazem tego, co zaobserwowano.">
          {ramps.map((o) => (
            <RequestDraft key={o.depositAddress} title={`Zapytanie do giełdy ${o.exchange}`} basis={o.detail} text={draftRequest(o, context) + reasoning(`deposit:${o.depositAddress}`)} />
          ))}
          {attested.map((a) => (
            <RequestDraft
              key={a.issuer + a.address}
              title={`Zapytanie do ${a.issuer}`}
              basis={`${a.issuer} publicznie poświadcza, że sprawdził tożsamość właściciela adresu ${shortAddress(a.address)}.`}
              text={draftAttestationRequest({ ...a, ...summary.attestations!.find((y) => y.issuer === a.issuer && y.address === a.address && y.value) }) + reasoning(`attestation:${a.issuer}:${a.address}`)}
            />
          ))}
        </Card>
      )}

      {(summary.dossier || llm?.available) && (
        <section className="card assistant">
          <header className="card-head">
            <h2>Opracowanie przez model językowy</h2>
            <span className="layer layer-hypothesis">pomocnicze, do weryfikacji</span>
          </header>
          <p className="card-note">
            Model działa {modelPlace(summary.dossier?.model ?? llm?.model ?? '')} i dostaje wyłącznie ponumerowane ustalenia tej analizy. Nie ma wpływu na Wskaźnik Pewności ani na kwotę. Każde jego zdanie jest sprawdzane: musi wskazać ustalenia, a liczby i adresy muszą z nich pochodzić.
          </p>
          {summary.dossier ? (
            <>
              <h3>Opis sprawy</h3>
              <Dossier dossier={summary.dossier} />
            </>
          ) : (
            <p>Model może opisać sprawę, uporządkować dalsze czynności, porównać niepotwierdzone konta i uzasadnić projekty zapytań.</p>
          )}
          {!!summary.triage?.leads.length && (
            <>
              <h3>Dalsze czynności</h3>
              <ol className="leads">
                {summary.triage.leads.map((l) => (
                  <li key={l.id}>
                    {l.text}
                    {l.reason && <span className="quiet"> {l.reason}</span>}
                  </li>
                ))}
              </ol>
              <p className="quiet">Lista wynika z ustaleń według stałych reguł. {summary.triage.byModel ? 'Kolejność i uzasadnienia zaproponował model; nie może dodać czynności spoza listy.' : 'Kolejność wynika z reguł.'}</p>
            </>
          )}
          {!!summary.judgements?.length && (
            <>
              <h3>Porównanie kont</h3>
              {summary.judgements.map((j) => (
                <div key={`${j.origin}|${j.handle}`}>
                  <p>
                    Konto <strong>{j.handle}</strong>
                    {j.source ? ` (${j.source})` : ''}
                    {j.scope === 'same_nick' ? ', połączone z osobą wyłącznie takim samym nickiem' : ', niepotwierdzone'}: {j.verdict === 'same' ? 'prawdopodobnie ta sama osoba' : j.verdict === 'different' ? 'prawdopodobnie inna osoba' : 'nie da się rozstrzygnąć'}.
                  </p>
                  {!!j.reasons.length && (
                    <ul className="changes-list">
                      {j.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {j.rejected > 0 && <p className="quiet">Odrzucono dowodów modelu: {j.rejected} (cytatu nie ma w treści kont albo cytaty nie mają nic wspólnego).</p>}
                </div>
              ))}
              <p className="quiet">Opinia nie łączy ani nie rozdziela kont i nie zmienia żadnego wyniku. Jest wskazówką dla analityka.</p>
            </>
          )}
          {actions && llm?.available && (
            <div className="case-controls">
              <button onClick={actions.describeCase} disabled={!!llm.busy}>
                {llm.busy === 'describe' ? 'Model opracowuje sprawę…' : summary.dossier ? 'Opracuj ponownie' : 'Opracuj sprawę'}
              </button>
              <span className="quiet">{modelShort(llm.model)}, {modelPlace(llm.model)}</span>
            </div>
          )}
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- 6. Źródła i raport

interface Snapshot {
  id: string;
  seq: number;
  connector_id: string;
  url: string;
  http_status: number;
  sha256: string;
  fetched_at: string;
}

export function StepEvidence({ summary, status, vault, caseInfo, runId, events, cursor }: StepProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>();
  const [find, setFind] = useState('');
  const [report, setReport] = useState(() => new URLSearchParams(window.location.search).get('report') === '1');
  useEffect(() => {
    if (!summary) return;
    getJson<{ snapshots: Snapshot[] }>(`/api/runs/${runId}/evidence`).then((r) => setSnapshots(r.snapshots)).catch(() => setSnapshots([]));
  }, [summary, runId]);
  if (!summary) return <Waiting status={status} events={events} cursor={cursor} phase={6} />;
  const needle = find.trim().toLowerCase();
  const matching = (snapshots ?? []).filter((s) => !needle || s.url.toLowerCase().includes(needle) || s.connector_id.toLowerCase().includes(needle));

  return (
    <>
      <Card title="Raport" layer="fact" note="Raport zawiera wszystko z kroków 1–6 w tej samej kolejności, z rozdzieleniem faktów źródłowych, wyników obliczeń i wniosków do weryfikacji.">
        <div className="case-controls">
          <button onClick={() => setReport(!report)} aria-expanded={report}>
            {report ? 'Zwiń raport' : 'Pokaż raport'}
          </button>
          <a className="button" href={`/api/runs/${summary.runId}/report.pdf`} target="_blank" rel="noreferrer">
            Pobierz PDF
          </a>
          <a className="button" href={`/api/runs/${summary.runId}/report`} target="_blank" rel="noreferrer">
            Otwórz w nowej karcie
          </a>
        </div>
        {report && <iframe className="report-frame" title="Raport z analizy" src={`/api/runs/${summary.runId}/report`} />}
      </Card>

      <Card title="Magazyn dowodów" layer="fact" note="Każda pobrana strona i każda odpowiedź źródła jest zapisana z adresem, czasem pobrania i skrótem treści. Zapisy łączy łańcuch skrótów: zmiana dowolnego z nich jest wykrywalna.">
        {vault && (
          <p className={vault.ok ? 'vault ok' : 'vault broken'}>
            {vault.ok ? `Magazyn dowodów nienaruszony: zgadza się ${vault.checked} z ${vault.checked} zapisów i cały łańcuch skrótów.` : `Magazyn dowodów naruszony: zapis nr ${vault.broken.join(', ')} nie zgadza się z tym, co pobrano.`}
          </p>
        )}
        <div className="case-controls">
          <label>
            Szukaj w źródłach{' '}
            <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="fragment adresu strony lub nazwy źródła" />
          </label>
          <span className="quiet">{snapshots === undefined ? 'Wczytuję…' : `${matching.length} z ${snapshots.length} zapisów`}</span>
        </div>
        {matching.length > 0 && (
          <table className="grid ledger">
            <thead>
              <tr>
                <th className="num">Nr</th>
                <th>Pobrano (UTC)</th>
                <th>Źródło</th>
                <th>Adres zasobu</th>
                <th className="num">Odpowiedź</th>
                <th>Skrót treści (SHA-256)</th>
              </tr>
            </thead>
            <tbody>
              {matching.slice(0, 250).map((s) => (
                <tr key={s.id}>
                  <td className="num">{s.seq}</td>
                  <td>{second(s.fetched_at)}</td>
                  <td>{s.connector_id}</td>
                  <td className="url">
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.url.length > 90 ? `${s.url.slice(0, 90)}…` : s.url}
                    </a>
                  </td>
                  <td className="num">{s.http_status}</td>
                  <td className="mono small" title={s.sha256}>
                    {s.sha256.slice(0, 16)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {matching.length > 250 && <p className="quiet">Pokazano pierwsze 250. Zawęź wyszukiwanie albo otwórz raport, który wymienia wszystkie.</p>}
      </Card>

      <Card title="Czego nie udało się odczytać" layer="fact">
        {summary.gaps?.length ? (
          <>
            <p>
              {summary.gaps.length === 1 ? 'Jedno źródło nie odpowiedziało' : `Źródeł lub zapytań bez odpowiedzi: ${summary.gaps.length}`}. Wynik może być niepełny; powtórzenie analizy zwykle uzupełnia braki.
            </p>
            <table className="grid">
              <thead>
                <tr>
                  <th>Źródło</th>
                  <th>Co się stało</th>
                  <th className="num">Ile razy</th>
                </tr>
              </thead>
              <tbody>
                {summary.gaps.map((g, i) => (
                  <tr key={i}>
                    <td>{g.source}</td>
                    <td className="why">{g.message.length > 220 ? `${g.message.slice(0, 220)}…` : g.message}</td>
                    <td className="num">{g.times}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p>Wszystkie źródła odpowiedziały. W tej analizie nie ma znanych braków.</p>
        )}
      </Card>

      <Card title="Przebieg analizy krok po kroku" layer="fact" note="Każda linia to zdarzenie zapisane przez silnik w chwili, gdy nastąpiło (czas UTC), z numerem kroku scenariusza. Z tych samych zdarzeń odtwarzany jest graf w kroku 2.">
        <div className="runlog-box">
          <RunLog events={events} cursor={cursor} follow={false} />
        </div>
      </Card>

      {!!caseInfo?.audit?.length && (
        <Card title="Dziennik czynności w sprawie" layer="fact" note="Kto, kiedy i co zrobił. Wpisy łączy łańcuch skrótów; pełny dziennik jest też w raporcie.">
          <table className="grid">
            <thead>
              <tr>
                <th>Kiedy (UTC)</th>
                <th>Kto</th>
                <th>Czynność</th>
              </tr>
            </thead>
            <tbody>
              {caseInfo.audit.map((e) => (
                <tr key={e.id}>
                  <td>{second(e.at)}</td>
                  <td>{e.actor}</td>
                  <td>{AUDIT[e.action] ?? e.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

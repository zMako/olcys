import { useState, type ReactNode } from 'react';
import type { AddressActivity, RunSummary, StoredRunEvent } from '@olcys/engine';
import { draftRequest, type Link, type OffRamp, type ProfileHistory } from '@olcys/scoring';
import { BAND_COLOR } from './graph/Graph';
import { addressId, type GNode, type Graph } from './graph/model';
import { ACCOUNT_KIND, BAND, CATEGORY, CERTAINTY, CHAIN, KIND, LEVEL, OBFUSCATION, PLACEMENT, amounts, day, describe, minute, moreAddresses, pln, shortAddress } from './pl';
import { Receipt } from './Receipt';

export interface Vault {
  ok: boolean;
  checked: number;
  broken: number[];
}

type LayerKind = 'fact' | 'computed' | 'hypothesis';

/** The report must keep three kinds of statement apart; every block of the panel says which one it is. */
function Layer({ kind }: { kind: LayerKind }) {
  const text = { fact: 'fakt źródłowy', computed: 'wynik obliczeń', hypothesis: 'wniosek do weryfikacji' }[kind];
  return <span className={`layer layer-${kind}`}>{text}</span>;
}

function Section({ title, layer, children }: { title: string; layer?: LayerKind; children: ReactNode }) {
  return (
    <section className="block">
      <h3>
        {title}
        {layer && <Layer kind={layer} />}
      </h3>
      {children}
    </section>
  );
}

/** Text around an address with the address itself marked, as it stood in the source. */
function Context({ text, raw }: { text: string; raw: string }) {
  const i = text.indexOf(raw);
  if (i < 0) return <q>{text}</q>;
  return (
    <q>
      {text.slice(0, i)}
      <mark>{raw}</mark>
      {text.slice(i + raw.length)}
    </q>
  );
}

/** How a profile's published addresses changed over time; the slider steps through the stored versions. */
function History({ h }: { h: ProfileHistory }) {
  const [i, setI] = useState(h.versions.length - 1);
  const v = h.versions[i];
  const prev = i > 0 ? h.versions[i - 1] : undefined;
  const isNew = (a: string) => !!prev && !prev.addresses.some((x) => x.address === a);
  const gone = prev ? prev.addresses.filter((x) => !v.addresses.some((y) => y.address === x.address)) : [];
  return (
    <div className="history">
      <input type="range" min={0} max={h.versions.length - 1} value={i} onChange={(e) => setI(Number(e.target.value))} aria-label="Wersja profilu w czasie" />
      <div className="history-ticks">
        {h.versions.map((x, k) => (
          <button key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)}>
            {x.source === 'live' ? 'dziś' : x.at.slice(0, 7)}
          </button>
        ))}
      </div>
      <p className="history-when">
        {v.source === 'live' ? `Profil dzisiaj (pobrany ${day(v.at)})` : `Profil w dniu ${day(v.at)} — kopia z archiwum`}.{' '}
        <a href={v.url} target="_blank" rel="noreferrer">
          Otwórz tę wersję
        </a>
      </p>
      <ul className="history-addresses">
        {v.addresses.map((a) => (
          <li key={a.address} className={isNew(a.address) ? 'new' : ''}>
            <span className="mono">{a.address}</span>
            {isNew(a.address) && <span className="quiet"> nowy w tej wersji</span>}
          </li>
        ))}
        {gone.map((a) => (
          <li key={a.address} className="gone">
            <span className="mono">{a.address}</span>
            <span className="quiet"> usunięty</span>
          </li>
        ))}
        {v.addresses.length === 0 && gone.length === 0 && <li className="quiet">Brak adresów na profilu.</li>}
      </ul>
      {h.changes.map((c, k) => (
        <p key={k} className="history-change">
          {c.detail}
        </p>
      ))}
    </div>
  );
}

/** Draft request to the exchange that holds the customer's identity. */
function Draft({ off, summary }: { off: OffRamp; summary: RunSummary }) {
  const [copied, setCopied] = useState(false);
  const text = draftRequest(off, { caseTitle: summary.identifiers.filter((i) => i.origin === 'seed').map((i) => i.value).join(', '), runId: summary.runId, generatedAt: new Date().toISOString() });
  return (
    <>
      <p>{off.detail}</p>
      <pre className="draft">{text}</pre>
      <button
        className="copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? 'Skopiowano' : 'Kopiuj projekt zapytania'}
      </button>
    </>
  );
}

const walletOf = (summary: RunSummary | undefined, address?: string): AddressActivity | undefined =>
  summary?.chain.activity.find((a) => a.address === address || a.wallet.some((m) => m.address === address));

const WEIGHT: Record<string, string> = { duże: 'poważne', średnie: 'istotne', małe: 'drobne' };

function AddressPanel({ node, summary }: { node: GNode; summary?: RunSummary }) {
  const link: Link | undefined =
    node.link && summary?.assessment?.links.find((l) => l.address === node.address && l.clusterId === node.link!.clusterId);
  const activity = walletOf(summary, node.address);
  if (!link || !summary?.assessment) {
    return (
      <>
        <h2 className="mono">{node.address}</h2>
        <p className="quiet">
          {CHAIN[node.chain ?? '']}. {node.link ? 'Wczytuję uzasadnienie…' : 'Adres został znaleziony, ale jeszcze nie oceniony. Wynik pojawi się po sprawdzeniu w eksploratorze.'}
        </p>
      </>
    );
  }
  return (
    <>
      <Receipt key={`${link.clusterId}:${link.address}`} link={link} ruleset={summary.assessment.ruleset} />

      {link.occurrences
        .filter((o) => o.image)
        .slice(0, 1)
        .map((o) => (
          <Section key={o.image!.snapshotId} title="Adres odczytany ze zdjęcia" layer="fact">
            <figure className="evidence-image">
              <img src={`/api/runs/${summary.runId}/snapshots/${o.image!.snapshotId}/image`} alt="Zdjęcie z ogłoszenia, na którym jest kod QR z adresem" />
              <figcaption>Adresu nie ma w treści ogłoszenia. Odczytano go z kodu QR na tym zdjęciu; zdjęcie jest zapisane w magazynie dowodów.</figcaption>
            </figure>
          </Section>
        ))}

      {link.challenges.length > 0 && (
        <Section title="Co może podważyć ten wynik" layer="hypothesis">
          <ul className="challenges">
            {link.challenges.map((c, i) => (
              <li key={i} className={`w-${c.weight === 'duże' ? 'high' : c.weight === 'średnie' ? 'mid' : 'low'}`}>
                <span className="weight">{WEIGHT[c.weight]}</span>
                {c.text}
              </li>
            ))}
          </ul>
          <p className="quiet">Co rozstrzygnęłoby wątpliwości: {link.wouldConfirm.join(' ')}</p>
        </Section>
      )}

      <Section title={`Gdzie znaleziono adres (${link.occurrences.length})`} layer="fact">
        <ul className="sources">
          {link.occurrences.map((o, i) => (
            <li key={i}>
              <div>
                <a href={o.url} target="_blank" rel="noreferrer">
                  {PLACEMENT[o.placement]}, {o.source}
                </a>
                {o.authorHandle && <> — autor {o.authorHandle}</>}
                {o.quotedAuthor && <>, cytuje {o.quotedAuthor}</>}
              </div>
              {o.archivedAt && <div className="note">Wersja archiwalna profilu z dnia {day(o.archivedAt)}.</div>}
              {o.image ? (
                <div className="note">
                  Kod QR na zdjęciu ogłoszenia: <q style={{ display: 'inline', border: 0, padding: 0 }}>{o.raw}</q>
                </div>
              ) : (
                <>
                  {o.method !== 'plain' && <div className="note">Adres był {o.obfuscation.map((x) => OBFUSCATION[x] ?? x).join(', ')}.</div>}
                  <Context text={o.context} raw={o.raw} />
                </>
              )}
              <div className="proof">
                pobrano {minute(o.fetchedAt)} UTC, skrót treści <code title={o.snapshotSha256}>{o.snapshotSha256.slice(0, 16)}…</code>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {link.account && (
        <Section title="Co to za adres" layer="fact">
          <p>
            {ACCOUNT_KIND[link.account.kind]}
            {link.account.labels[0] ? `, oznaczony jako „${link.account.labels[0].name}” (${link.account.labels[0].source})` : ', bez etykiety w eksploratorze'}.
            {link.account.txCount > 0 && ` Przelewów: ${link.account.txCount}, pierwszy ${day(link.account.firstSeenAt)}, ostatni ${day(link.account.lastSeenAt)}.`}
            {link.account.balances.length > 0 && ` Saldo: ${amounts(link.account.balances)}.`}
          </p>
          {summary.names
            .filter((n) => n.address === link.address)
            .map((n) => (
              <p key={n.name}>
                Nazwa w łańcuchu bloków: <strong>{n.name}</strong>
                {n.verified ? ' (zgłoszona przez sam adres)' : ''}.
                {Object.keys(n.records).length > 0 && ` Rekordy ustawione przez właściciela: ${Object.entries(n.records).map(([k, v]) => `${k}: ${v}`).join('; ')}.`}
              </p>
            ))}
        </Section>
      )}

      {activity && activity.wallet.length > 1 && (
        <Section title={`Adresy tej samej osoby: ${activity.wallet.length}`} layer="computed">
          <p>Te adresy łączy łańcuch bloków: środki z nich wydano w jednej transakcji albo wpłacono z nich na ten sam, osobisty adres depozytowy giełdy.</p>
          <ul className="members">
            {activity.wallet.map((m) => (
              <li key={m.address}>
                <span className="mono">{shortAddress(m.address)}</span>{' '}
                <span className="quiet">
                  {!m.via
                    ? 'znaleziony w otwartych źródłach'
                    : m.rule === 'D2'
                      ? `wpłacał na ten sam adres depozytowy giełdy (${shortAddress(m.via.with)})`
                      : `wydany razem z ${shortAddress(m.via.with)}, transakcja ${m.via.txHash.slice(0, 10)}…`}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {activity && (
        <Section title="Ślady wyjścia do walut tradycyjnych" layer="hypothesis">
          <p className="quiet">
            Otrzymano {amounts(activity.activity.received) || '0'}, wysłano {amounts(activity.activity.sent) || '0'} w okresie {day(activity.activity.firstAt)} – {day(activity.activity.lastAt)}.
          </p>
          {activity.indicators.length === 0 && <p>Nie wykryto przelewów do giełd, usług P2P, bramek płatniczych, kart ani kantorów.</p>}
          <ul className="indicators">
            {activity.indicators.map((ind) => (
              <li key={ind.type} className={ind.cashOut ? 'cash' : ''}>
                <strong>{ind.title}</strong> <code>{ind.rule}</code>
                <div>{ind.summary}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {link.otherPublishers.length > 0 && (
        <Section title="Kto jeszcze podał ten adres" layer="fact">
          <p>{link.otherPublishers.map((p) => `${p.handle} (${p.source})`).join(', ')}</p>
        </Section>
      )}
    </>
  );
}

function AccountPanel({ node, summary }: { node: GNode; summary?: RunSummary }) {
  const cluster = summary?.assessment?.clusters.find((c) => c.accounts.some((a) => a.origin === node.origin && a.handle === node.handle));
  const published = summary?.addresses.filter((a) => a.occurrences.some((o) => o.origin === node.origin && o.author_handle === node.handle)) ?? [];
  const history = summary?.assessment?.histories.find((h) => h.origin === node.origin && h.handle === node.handle);
  return (
    <>
      <h2>{node.title}</h2>
      <p className="quiet">
        Konto w serwisie {node.sub}.{' '}
        {node.profileUrl && (
          <a href={node.profileUrl} target="_blank" rel="noreferrer">
            Otwórz profil
          </a>
        )}
      </p>
      {history && history.changes.length > 0 && (
        <Section title="Profil w czasie" layer="fact">
          <History h={history} />
        </Section>
      )}
      {cluster ? (
        <Section title={LEVEL[cluster.level]} layer="computed">
          <p>{cluster.identityNote}</p>
          {cluster.accounts.length > 1 && (
            <>
              <p>Uznane za jedną osobę razem z: {cluster.accounts.filter((a) => a.handle !== node.handle || a.origin !== node.origin).map((a) => `${a.handle} (${a.source})`).join(', ')}.</p>
              <ul className="reasons">
                {/* reasons that involve this account come first */}
                {[...cluster.joins]
                  .sort((a, b) => Number(b.detail.includes(node.title)) - Number(a.detail.includes(node.title)))
                  .map((j, i) => (
                    <li key={i}>
                      <code>{j.rule}</code> {j.detail}
                    </li>
                  ))}
              </ul>
            </>
          )}
          {cluster.identifiers.length > 0 && <p className="quiet">Dane podane na profilach: {cluster.identifiers.map((i) => `${KIND[i.kind] ?? i.kind} ${i.value}`).join(', ')}.</p>}
        </Section>
      ) : (
        <Section title="Obce konto" layer="fact">
          <p>To konto nie jest powiązane z badaną osobą. Pojawia się, ponieważ podało adres, który podała też ona.</p>
        </Section>
      )}
      {published.length > 0 && (
        <Section title="Adresy podane przez to konto" layer="fact">
          <ul className="plain">
            {published.map((a) => (
              <li key={a.address} className="mono">
                {shortAddress(a.address)} <span className="quiet">{CHAIN[a.chain]}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function ServicePanel({ node, summary }: { node: GNode; summary?: RunSummary }) {
  const mine = new Set(node.addresses ?? [node.address ?? '']);
  const hits = (summary?.chain.activity ?? []).flatMap((a) =>
    a.indicators.filter((i) => i.counterparties.some((c) => mine.has(c.address))).map((i) => ({ from: a.address, indicator: i })),
  );
  const offRamps = (summary?.chain.activity ?? []).flatMap((a) => a.offRamps.filter((o) => mine.has(o.depositAddress)));
  return (
    <>
      <h2>{node.title}</h2>
      <p className="quiet">
        {CATEGORY[node.category ?? 'other']}. {mine.size === 1 ? 'Adres usługi' : 'Adresy usługi'}: {[...mine].map((a) => shortAddress(a)).join(', ')}
      </p>
      {hits.map(({ from, indicator }) => (
        <Section key={from + indicator.type} title={indicator.title} layer="hypothesis">
          <p>{indicator.summary}</p>
          <table className="transfers">
            <thead>
              <tr>
                <th>Data</th>
                <th>Z adresu</th>
                <th className="num">Kwota</th>
              </tr>
            </thead>
            <tbody>
              {indicator.transfers
                .filter((t) => mine.has(t.to) || mine.has(t.from))
                .map((t, i) => (
                  <tr key={i}>
                    <td>{day(t.at)}</td>
                    <td className="mono">{shortAddress(mine.has(t.to) ? t.from : t.to)}</td>
                    <td className="num">{amounts([{ asset: t.asset, amount: t.amount }])}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Section>
      ))}
      {summary && offRamps.length > 0 && (
        <Section title="Kto zna tożsamość klienta" layer="hypothesis">
          <p>Giełda przydziela adres depozytowy jednemu, zweryfikowanemu klientowi. To ona może potwierdzić, kto stoi za wpłatami.</p>
          {offRamps.map((o) => (
            <Draft key={o.depositAddress} off={o} summary={summary} />
          ))}
        </Section>
      )}
      {node.cashOut && <p className="quiet">Przelew do takiej usługi może oznaczać zamianę kryptowalut na walutę tradycyjną. To trop do sprawdzenia, nie ustalenie.</p>}
    </>
  );
}

function EstimatePanel({ summary }: { summary?: RunSummary }) {
  const e = summary?.estimate;
  if (!e) return <p className="quiet">Wczytuję szacunek…</p>;
  return (
    <>
      <h2>Do wyjaśnienia</h2>
      <p>
        Wartość kryptowalut skierowanych do usług, w których mogły zostać zamienione na walutę tradycyjną, towar lub usługę. <Layer kind="hypothesis" />
      </p>
      <div className="years">
        {e.years.map((y) => (
          <div key={y.year} style={{ display: 'contents' }}>
            <span className="y">{y.year}</span>
            <span className="v">{pln(y.totalPln)}</span>
            <span className="split">
              zbycie prawdopodobne {pln(y.probablePln)}, możliwe {pln(y.possiblePln)}
            </span>
          </div>
        ))}
      </div>
      <p className="quiet">To potencjalny przychód, nie dochód: nie uwzględnia kosztów nabycia i wymaga potwierdzenia u wskazanych podmiotów.</p>

      <Section title="Z czego wynika kwota" layer="computed">
        <table className="transfers valued">
          <thead>
            <tr>
              <th>Data</th>
              <th>Usługa</th>
              <th className="num">Ilość i kurs NBP</th>
              <th className="num">Wartość</th>
            </tr>
          </thead>
          <tbody>
            {e.transfers.map((t, i) => (
              <tr key={i} title={t.rate ? `kurs rynkowy ${t.priceUsd} USD; tabela ${t.rate.table} z ${t.rate.effectiveDate}` : t.note}>
                <td>{t.day}</td>
                <td>
                  {(t.counterparty ?? shortAddress(t.to)).split(':')[0]}
                  <div className="quiet">{CERTAINTY[t.certainty]}</div>
                </td>
                <td className="num">
                  {amounts([{ asset: t.asset, amount: t.amount }])}
                  {t.rate && (
                    <div className="quiet">
                      {t.rate.mid.toLocaleString('pl-PL', { minimumFractionDigits: 4 })}, tab. {t.rate.table.split('/')[0]}
                    </div>
                  )}
                </td>
                <td className="num">{t.valuePln !== undefined ? pln(t.valuePln) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Metoda" layer="computed">
        <ul className="method">
          {e.method.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
        {e.leftOut.length > 0 && (
          <p className="quiet">
            Pominięto: {e.leftOut.map((x) => `${shortAddress(x.address)} (${x.score}%, ${x.reason})`).join('; ')}.
          </p>
        )}
      </Section>
    </>
  );
}

function Overview({ graph, summary, events, cursor, vault, onSelect }: { graph: Graph; summary?: RunSummary; events: StoredRunEvent[]; cursor: number; vault?: Vault; onSelect(id: string): void }) {
  if (!events.length) {
    return (
      <>
        <h2>Jak to działa</h2>
        <p>Wpisz jeden identyfikator osoby: nick, imię i nazwisko, e-mail, telefon, adres profilu albo adres kryptowalutowy.</p>
        <p>Narzędzie przeszuka publiczne źródła, znajdzie powiązane adresy, oceni pewność każdego powiązania i sprawdzi, dokąd trafiły środki.</p>
        <p className="quiet">Każdy wynik ma źródło, datę pobrania i skrót treści, więc analizę można odtworzyć.</p>
      </>
    );
  }
  const addresses = graph.nodes.filter((n) => n.type === 'address' && n.link);
  // Accounts matched by name only may be another person; their addresses are listed apart.
  const firm = new Set(graph.clusters.filter((c) => c.level === 'entered' || c.level === 'publisher').map((c) => c.id));
  const scored = addresses.filter((n) => n.link!.status === 'attributed').sort((a, b) => b.link!.score - a.link!.score);
  const attributed = scored.filter((n) => firm.has(n.link!.clusterId));
  const uncertain = scored.filter((n) => !firm.has(n.link!.clusterId));
  const rejected = addresses.filter((n) => n.link!.status !== 'attributed');
  const estimate = graph.nodes.find((n) => n.type === 'estimate');
  const exchanges = graph.finished ? [...new Set((summary?.chain.activity ?? []).flatMap((a) => a.offRamps.map((o) => o.exchange)))] : [];

  return (
    <>
      <h2>{graph.finished ? 'Wynik analizy' : 'Analiza trwa'}</h2>
      {!graph.finished && (
        <ol className="log" aria-live="polite">
          {events.slice(0, cursor).filter((e) => e.type !== 'hit').slice(-9).map((e) => (
            <li key={e.seq}>{describe(e)}</li>
          ))}
        </ol>
      )}

      {estimate && (
        <Section title="Do wyjaśnienia" layer="hypothesis">
          <button className="estimate-row" onClick={() => onSelect('estimate')}>
            <div className="years">
              {estimate.years!.map((y) => (
                <div key={y.year} style={{ display: 'contents' }}>
                  <span className="y">{y.year}</span>
                  <span className="v">{pln(y.totalPln)}</span>
                </div>
              ))}
            </div>
            <span className="quiet">Wartość skierowana do usług wyjścia do walut tradycyjnych. Pokaż wyliczenie.</span>
          </button>
          {exchanges.length > 0 && (
            <p style={{ marginTop: 10 }}>
              Tożsamość klienta zna giełda: <strong>{exchanges.join(', ')}</strong>. Projekt zapytania jest w szczegółach giełdy i w raporcie.
            </p>
          )}
        </Section>
      )}

      {graph.nodes.some((n) => n.viaWallet) && (
        <Section title="Znalezione przez łańcuch bloków" layer="computed">
          {graph.nodes.filter((n) => n.viaWallet).map((n) => (
            <p key={n.id}>
              Konto <strong>{n.title}</strong> ({n.sub}) nie jest w sieci z niczym powiązane. Znaleziono je, ponieważ podaje adres, który łańcuch bloków wiąże z adresem osoby.{' '}
              <button className="linklike" onClick={() => onSelect(n.id)}>
                Pokaż konto
              </button>
            </p>
          ))}
        </Section>
      )}

      {graph.matches.length > 0 && (
        <Section title="Kwoty zgodne z przelewami" layer="computed">
          <ul className="indicators">
            {graph.matches.map((m, i) => (
              <li key={i}>{m.detail}</li>
            ))}
          </ul>
        </Section>
      )}

      {graph.histories.length > 0 && (
        <Section title="Zmiany w czasie" layer="fact">
          {graph.histories.map((h) => (
            <p key={h.origin + h.handle}>
              {h.changes[0].detail}{' '}
              <button className="linklike" onClick={() => onSelect(`acc:${h.origin}:${h.handle.toLowerCase()}`)}>
                Pokaż wersje profilu {h.handle}
              </button>
            </p>
          ))}
        </Section>
      )}

      {attributed.length > 0 && (
        <Section title={`Adresy powiązane z osobą (${attributed.length})`} layer="computed">
          <ul className="rows">
            {attributed.map((n) => (
              <li key={n.id}>
                <button onClick={() => onSelect(n.id)}>
                  <span className="row-score">{n.link!.score}%</span>
                  <span className="row-main">
                    <span className="mono">{n.title}</span>
                    <span className="row-meter">
                      <span style={{ width: `${n.link!.score}%`, background: BAND_COLOR[n.link!.band] }} />
                    </span>
                    <span className="quiet">
                      {CHAIN[n.chain ?? '']}, {n.proven ? 'potwierdzone podpisem' : BAND[n.link!.band].toLowerCase()}
                      {n.walletSize ? `, ${moreAddresses(n.walletSize)}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {uncertain.length > 0 && (
        <Section title={`Możliwe, że inna osoba (${uncertain.length})`} layer="computed">
          <p className="quiet">Konto dopasowane tylko po imieniu i nazwisku. Adres nie wchodzi do szacunku.</p>
          <ul className="rows">
            {uncertain.map((n) => (
              <li key={n.id}>
                <button onClick={() => onSelect(n.id)}>
                  <span className="row-score">{n.link!.score}%</span>
                  <span className="row-main">
                    <span className="mono">{n.title}</span>
                    <span className="row-meter">
                      <span style={{ width: `${n.link!.score}%`, background: BAND_COLOR[n.link!.band] }} />
                    </span>
                    <span className="quiet">
                      {CHAIN[n.chain ?? '']}, {BAND[n.link!.band].toLowerCase()}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {rejected.length > 0 && (
        <Section title={`Odrzucone przypisania (${rejected.length})`} layer="computed">
          <ul className="rows rejected">
            {rejected.map((n) => (
              <li key={n.id}>
                <button onClick={() => onSelect(n.id)}>
                  <span className="row-score">✕</span>
                  <span className="row-main">
                    <span className="mono">{n.title}</span>
                    <span className="quiet">{n.link!.status === 'excluded' ? n.label ?? n.link!.reason : 'cudzy adres, tylko zacytowany'}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {graph.finished && summary && (
        <Section title="Przebieg i dowody" layer="fact">
          <p>
            Pobrano {summary.counts.snapshots} stron i odpowiedzi źródeł, przeanalizowano {summary.counts.documents} dokumentów, sprawdzono {summary.identifiers.length} tropów.{' '}
            {summary.counts.denied === 0 ? 'Żadne połączenie nie wyszło poza listę dozwolonych źródeł.' : `Zablokowano ${summary.counts.denied} połączeń spoza listy dozwolonych źródeł.`}
          </p>
          {vault && (
            <p className={vault.ok ? 'vault ok' : 'vault broken'}>
              {vault.ok
                ? `Magazyn dowodów nienaruszony: zgadza się ${vault.checked} z ${vault.checked} zapisów i cały łańcuch skrótów.`
                : `Magazyn dowodów naruszony: zapis nr ${vault.broken.join(', ')} nie zgadza się z tym, co pobrano.`}
            </p>
          )}
        </Section>
      )}
    </>
  );
}

export function Panel(props: { node?: GNode; graph: Graph; summary?: RunSummary; events: StoredRunEvent[]; cursor: number; vault?: Vault; onSelect(id?: string): void }) {
  const { node } = props;
  return (
    <aside className="side" aria-label="Szczegóły">
      {node && node.type !== 'seed' && (
        <button className="back" onClick={() => props.onSelect(undefined)}>
          Wróć do wyniku analizy
        </button>
      )}
      {!node || node.type === 'seed' ? (
        <Overview {...props} onSelect={props.onSelect} />
      ) : node.type === 'address' ? (
        <AddressPanel node={node} summary={props.summary} />
      ) : node.type === 'account' ? (
        <AccountPanel node={node} summary={props.summary} />
      ) : node.type === 'estimate' ? (
        <EstimatePanel summary={props.summary} />
      ) : (
        <ServicePanel node={node} summary={props.summary} />
      )}
    </aside>
  );
}

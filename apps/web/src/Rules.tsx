import { useEffect, useRef, useState } from 'react';
import type { Ruleset } from '@olcys/scoring';
import { getJson, sendJson } from './api';
import { CATEGORY, GROUP } from './pl';

const BAND_PL: Record<string, string> = { very_high: 'Bardzo wysokie', probable: 'Prawdopodobne', medium: 'Średnie', noise: 'Niskie, szum' };

/**
 * The whole algorithm behind the Confidence Score, on one page. Every number here comes from the ruleset the
 * engine actually uses, so what the analyst reads is what was computed.
 */
const at = (root: unknown, path: string): number => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], root) as number;

interface RulesState {
  ruleset: Ruleset;
  defaults: Ruleset;
  changes: { path: string; from: number; to: number }[];
}

export function Rules() {
  const [state, setState] = useState<RulesState>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const fields = useRef(new Map<string, number>()); // every editable number on the page, with the factor it is shown in
  useEffect(() => {
    getJson<RulesState>('/api/rules').then(setState).catch(() => setState(undefined));
  }, []);
  if (!state) return <main className="page"><p className="quiet">Wczytywanie reguł…</p></main>;
  const { ruleset: r, defaults } = state;
  const bands = [...r.bands].sort((a, b) => b.min - a.min);
  const upper = (i: number) => (i === 0 ? 100 : bands[i - 1].min - 1);

  /** One number of the rules as a field. `scale` shows a share as a percentage. */
  const N = (path: string, scale = 1) => {
    fields.current.set(path, scale);
    const shown = draft[path] ?? String(Math.round(at(r, path) * scale * 1000) / 1000);
    const differs = Math.abs(Number(shown.replace(',', '.')) / scale - at(defaults, path)) > 1e-9;
    return (
      <input
        className={differs ? 'rule-n changed' : 'rule-n'} value={shown} inputMode="decimal" aria-label={`Wartość reguły ${path}`}
        title={differs ? `Wartość domyślna: ${Math.round(at(defaults, path) * scale * 1000) / 1000}` : 'Wartość domyślna'}
        onChange={(e) => setDraft({ ...draft, [path]: e.target.value })}
      />
    );
  };
  const pending = Object.keys(draft).length > 0;
  const send = (values: Record<string, number>, done: string) => {
    setBusy(true);
    sendJson<RulesState>('/api/rules', { values }, 'PUT')
      .then((next) => {
        setState(next);
        setDraft({});
        setNote(done);
      })
      .catch(() => setNote('Nie udało się zapisać reguł. Sprawdź, czy wartości są liczbami nie mniejszymi od zera.'))
      .finally(() => setBusy(false));
  };
  const save = () => {
    const values: Record<string, number> = {};
    for (const [path, scale] of fields.current) {
      const value = Number((draft[path] ?? String(at(r, path) * scale)).replace(',', '.')) / scale;
      if (Number.isFinite(value) && value >= 0 && Math.abs(value - at(defaults, path)) > 1e-9) values[path] = Math.round(value * 1e6) / 1e6;
    }
    send(values, 'Reguły zapisane. Obowiązują dla każdej analizy uruchomionej od teraz; wcześniejsze analizy zachowują wynik i wersję reguł, według której były liczone.');
  };

  return (
    <main className="page rules">
      <h1>Reguły Wskaźnika Pewności</h1>
      <p className="lede">
        Wskaźnik Pewności mówi, na ile prawdopodobne jest, że adres kryptowalutowy należy do badanej osoby. Liczą go wyłącznie reguły z tej strony: te same źródła dają zawsze ten sam wynik, a każdy wynik da się odtworzyć krok po kroku z
        wyliczenia przy adresie. Model językowy nie ma na niego wpływu.
      </p>
      <div className="rules-bar">
        <span>
          Zestaw reguł: <strong>{r.name}</strong>, wersja <code>{r.version}</code>.{' '}
          {state.changes.length ? `Zmienionych wartości: ${state.changes.length}.` : 'Wartości domyślne.'}
        </span>
        <button className="primary" onClick={save} disabled={!pending || busy}>
          Zapisz zmiany
        </button>
        <button onClick={() => setDraft({})} disabled={!pending || busy}>
          Cofnij niezapisane
        </button>
        <button onClick={() => send({}, 'Przywrócono domyślne reguły.')} disabled={(!state.changes.length && !pending) || busy}>
          Przywróć domyślne
        </button>
      </div>
      <p className="quiet" role="status">
        {note ?? 'Liczby w polach można zmienić. Zapisana zmiana dostaje własny numer wersji, trafia do dziennika czynności i obowiązuje dla analiz uruchomionych po niej. Wersja reguł jest zapisywana przy każdej analizie.'}
      </p>

      <section className="card">
        <header className="card-head"><h2>Pasma wyniku</h2></header>
        <table className="grid">
          <thead><tr><th>Wynik</th><th>Pasmo</th></tr></thead>
          <tbody>
            {bands.map((b, i) => (
              <tr key={b.id}><td className="num">{b.min}–{upper(i)}%</td><td>{BAND_PL[b.id] ?? b.label}</td></tr>
            ))}
            <tr><td className="num">0%</td><td>Wykluczone: adres nie może należeć do osoby (reguły X) albo nie da się go jej przypisać (reguła Q1)</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <header className="card-head"><h2>1. Wartość wyjściowa: gdzie adres został opublikowany</h2></header>
        <p className="card-note">Liczy się najsilniejsze miejsce publikacji. Od niego zaczyna się wyliczenie.</p>
        <table className="grid">
          <thead><tr><th>Reguła</th><th>Miejsce publikacji</th><th className="num">Wartość</th></tr></thead>
          <tbody>
            {Object.entries(r.placements).map(([key, p]) => (
              <tr key={p.rule}><td><code>{p.rule}</code></td><td>{p.title}</td><td className="num">{N(`placements.${key}.base`)}%</td></tr>
            ))}
            <tr><td><code>I1</code></td><td>Adres wprowadzony przez analityka, którego nie opublikowało żadne konto: punkt wyjścia sprawy, bez wskazania osoby</td><td className="num">100%</td></tr>
            <tr><td><code>K3</code></td><td>Adres nie został podany, ale utworzył kontrakt, który osoba podaje jako własny</td><td className="num">najwyżej {N('deployer.max')}%</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <header className="card-head"><h2>2. Co podnosi wynik</h2></header>
        <table className="grid">
          <thead><tr><th>Reguła</th><th>Przesłanka</th><th className="num">Skutek</th></tr></thead>
          <tbody>
            <tr><td><code>{r.synergy.rule}</code></td><td>Ten sam adres w co najmniej {r.synergy.minOrigins} niezależnych serwisach, na kontach tej samej osoby. Powtórzenia w jednym serwisie się nie liczą.</td><td className="num">+{N('synergy.points')} pkt proc.</td></tr>
            <tr><td><code>{r.obfuscation.rule}</code></td><td>Adres celowo ukryty przed automatami (pocięty, zapisany nietypowymi znakami)</td><td className="num">+{N('obfuscation.points')} pkt proc.</td></tr>
            <tr><td><code>A1</code></td><td>Wpłata na adres zgodna z kwotą, którą osoba podała publicznie (z dokładnością do {Math.round(r.amountMatch.tolerancePln * 100)}% w złotych)</td><td className="num">+{N('amountMatch.points')} za każdą, najwyżej +{N('amountMatch.maxPoints')}</td></tr>
            <tr><td><code>C2</code></td><td>Wiadomość podpisana kluczem adresu, bez wskazania konta</td><td className="num">+{N('proof.unboundPoints')}, najwyżej {N('proof.unboundMax')}%</td></tr>
            <tr><td><code>K3</code></td><td>Adres twórcy kontraktu jest też podany wprost</td><td className="num">+{N('deployer.bonus')} pkt proc.</td></tr>
            <tr><td><code>W2</code></td><td>Adres z tego samego portfela co adres o wyższym wyniku</td><td className="num">wynik tamtego, najwyżej {N('wallet.sharedMax')}%</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <header className="card-head"><h2>3. Dowody, które same wystarczają</h2></header>
        <table className="grid">
          <thead><tr><th>Reguła</th><th>Przesłanka</th><th className="num">Wynik</th></tr></thead>
          <tbody>
            <tr><td><code>C1</code></td><td>Wiadomość podpisana kluczem adresu i wymieniająca konto; podpis sprawdzany jest matematycznie przez to narzędzie</td><td className="num">100%</td></tr>
            <tr><td><code>C3</code></td><td>Oświadczenie podpisane, którego podpis sprawdził serwis, a nie to narzędzie</td><td className="num">co najmniej {N('proof.attestedMin')}%</td></tr>
            <tr><td><code>N1</code></td><td>Nazwa adresu w łańcuchu bloków wskazuje konto, a konto podaje ten adres</td><td className="num">co najmniej {N('names.mutualMin')}%</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <header className="card-head"><h2>4. Limit tożsamości</h2></header>
        <p className="card-note">Wynik adresu nie może być wyższy niż pewność, że konto, które go podało, należy do badanej osoby (reguła T1).</p>
        <table className="grid">
          <thead><tr><th>Jak konto powiązano z osobą</th><th className="num">Najwyższy możliwy wynik</th></tr></thead>
          <tbody>
            {Object.entries(r.identityCaps).map(([level, cap]) => (
              <tr key={level}><td>{GROUP[level] ?? level}</td><td className="num">{level === 'entered' || level === 'publisher' ? cap : N(`identityCaps.${level}`)}%</td></tr>
            ))}
          </tbody>
        </table>
        <p>
          Dopasowanie wyłącznie po imieniu i nazwisku zależy od tego, ile osób w Polsce je nosi (statystyki rejestru PESEL): od {N('nameFrequency.veryCommonFrom')} osób limit spada do {N('nameFrequency.veryCommonCap')}%, od {N('nameFrequency.commonFrom')} osób do {N('nameFrequency.commonCap')}%; nazwisko, które według szacunku nosi mniej niż jedna osoba, podnosi limit do{' '}
          {N('nameFrequency.rareCap')}%.
        </p>
      </section>

      <section className="card">
        <header className="card-head"><h2>5. Co obniża wynik</h2></header>
        <table className="grid">
          <thead><tr><th>Reguła</th><th>Przesłanka</th><th className="num">Skutek</th></tr></thead>
          <tbody>
            <tr><td><code>R2</code></td><td>Co najmniej {N('rhythm.conflictShare', 100)}% przelewów z adresu wychodzi w godzinach, w których osoba nigdy nie publikuje w sieci</td><td className="num">−{N('rhythm.conflictPenalty')} pkt proc.</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <header className="card-head"><h2>6. Odrzucanie błędnych przypisań</h2></header>
        <p className="card-note">Adres odrzucony zostaje w wynikach, przekreślony i z powodem, a sam fakt przelewu do niego jest odnotowany.</p>
        <table className="grid">
          <thead><tr><th>Reguła</th><th>Kiedy</th><th className="num">Wynik</th></tr></thead>
          <tbody>
            <tr><td><code>X1</code></td><td>Adres ma publiczną etykietę podmiotu: {r.exclusions.labelCategories.map((c) => CATEGORY[c] ?? c).filter((x, i, all) => all.indexOf(x) === i).join(', ')}</td><td className="num">0%</td></tr>
            <tr><td><code>X2</code></td><td>Pod adresem jest kod wykonywalny (smart kontrakt). Konto prywatne z delegacją i portfel kontraktowy nie są wykluczane.</td><td className="num">0%</td></tr>
            <tr><td><code>X3</code></td><td>Adres publikuje {N('exclusions.unrelatedPublishers')} lub więcej niepowiązanych ze sobą kont</td><td className="num">0%</td></tr>
            <tr><td><code>Q1</code></td><td>Adres występuje wyłącznie w cytacie cudzej wypowiedzi</td><td className="num">nie do przypisania</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <header className="card-head"><h2>7. Wzorce w łańcuchu bloków</h2></header>
        <table className="grid">
          <thead><tr><th>Reguła</th><th>Wzorzec</th></tr></thead>
          <tbody>
            <tr><td><code>L1</code></td><td>Przelew na adres z publiczną etykietą giełdy</td></tr>
            <tr><td><code>D1</code></td><td>Przelew na nieoznaczony adres, który co najmniej {N('offRamp.minForwardShare', 100)}% otrzymanych środków danego aktywa przekazał na portfel giełdy: adres depozytowy jednego klienta</td></tr>
            <tr><td><code>D2</code></td><td>Inny adres wpłacający na ten sam adres depozytowy należy do tego samego klienta (jeśli wpłacających jest najwyżej {N('depositReuse.maxOtherSenders')})</td></tr>
            <tr><td><code>W1–W5</code></td><td>Przelewy do giełd, usług P2P, bramek płatniczych, kart i kantorów</td></tr>
            <tr><td><code>W6</code></td><td>Wymiana na stablecoiny ({r.indicators.stablecoins.join(', ')}) o wartości co najmniej {N('indicators.significantStablecoinSwap')}</td></tr>
            <tr><td><code>Z1, Z2</code></td><td>Kontrahent na liście sankcyjnej albo publicznie zgłoszony jako oszustwo</td></tr>
          </tbody>
        </table>
        <p>Do kwoty „do wyjaśnienia” wchodzą tylko adresy z wynikiem co najmniej {N('estimate.minScore')}%, należące do kont pewnie powiązanych z osobą.</p>
      </section>

      <section className="card">
        <header className="card-head"><h2>Co nie wpływa na wynik</h2></header>
        <ul className="plain-list">
          <li><code>V1</code> Publiczne poświadczenie giełdy lub innej instytucji o adresie: mówi, kto zna właściciela, a nie czy adres należy do badanej osoby.</li>
          <li><code>M1</code> Opinia modelu językowego o tym, czy niepotwierdzone konto należy do osoby: wskazówka dla analityka, bez punktów.</li>
          <li>Wypowiedzi osoby o własnych kryptowalutach i opis sprawy pisany przez model: pomagają czytać sprawę, nie zmieniają wyliczenia.</li>
        </ul>
      </section>
    </main>
  );
}

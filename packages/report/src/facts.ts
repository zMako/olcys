import type { RunSummary } from '@olcys/engine';

const short = (a: string) => (a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);
const pln = (n: number) => `${Math.round(n).toLocaleString('pl-PL')} zł`;
const BAND: Record<string, string> = { very_high: 'bardzo wysokie', probable: 'prawdopodobne', medium: 'średnie', noise: 'niskie' };
const CHAIN: Record<string, string> = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', tron: 'Tron' };

/**
 * The findings of a run as plain sentences — the only thing the language model is given when it is asked to
 * describe the case. Whatever is not listed here, the model has no way to know.
 */
export function caseFacts(s: RunSummary): string {
  const lines: string[] = [];
  const seeds = s.identifiers.filter((i) => i.origin === 'seed');
  lines.push(`Wprowadzono: ${seeds.map((i) => `${i.kind === 'username' ? 'nick' : i.kind === 'crypto_address' ? 'adres' : i.kind} „${i.value}”`).join(', ')}.`);
  const a = s.assessment;
  const subject = a?.clusters.find((c) => c.level === 'entered' || c.level === 'publisher');
  if (subject) {
    lines.push(`Konta uznane za konta badanej osoby (${subject.accounts.length}): ${subject.accounts.map((x) => `${x.handle} w serwisie ${x.source}`).join(', ')}.`);
    if (subject.joins.length) lines.push(`Podstawy połączenia kont: ${[...new Set(subject.joins.map((j) => j.detail))].slice(0, 6).join('; ')}.`);
    if (subject.rhythm?.quiet) lines.push(`Rytm doby (kontrola pomocnicza, przytoczyć dosłownie): ${subject.rhythm.note}`);
  } else lines.push('Nie znaleziono konta, które można pewnie powiązać z wprowadzonymi danymi.');
  for (const c of a?.clusters.filter((x) => x !== subject) ?? []) {
    lines.push(`Konta niepotwierdzone, trzymane osobno (wynik ograniczony do ${c.identityCap}%): ${c.accounts.map((x) => `${x.handle} w serwisie ${x.source}`).join(', ')}.`);
  }
  const mine = (a?.links ?? []).filter((l) => l.clusterId === subject?.id);
  const attributed = mine.filter((l) => l.status === 'attributed');
  for (const l of attributed.slice(0, 12)) {
    const last = l.receipt[l.receipt.length - 1];
    lines.push(`Adres ${short(l.address)} (${CHAIN[l.chain] ?? l.chain}): Wskaźnik Pewności ${l.score}%, ${BAND[l.band] ?? l.band}${l.proven ? ', potwierdzony podpisem sprawdzonym matematycznie' : ''}. Podstawa: ${l.receipt[0]?.title ?? ''}${last && last !== l.receipt[0] ? `; ${last.title}` : ''}.`);
  }
  const rejected = mine.filter((l) => l.status !== 'attributed');
  if (rejected.length) lines.push(`Odrzucono ${rejected.length} adresów, m.in.: ${rejected.slice(0, 4).map((l) => `${short(l.address)} (${l.receipt[0]?.title ?? ''})`).join(', ')}.`);
  for (const w of s.chain.activity) {
    for (const i of w.indicators.filter((x) => x.cashOut)) lines.push(`Przepływy z adresu ${short(w.address)}: ${i.title} — ${i.summary}`);
  }
  if (s.estimate?.years.length) {
    lines.push(`Wartość do wyjaśnienia (kryptowaluty skierowane do usług wyjścia do walut tradycyjnych; narzędzie nie ustala, czy i jaki podatek jest należny): ${s.estimate.years.map((y) => `${y.year}: ${pln(y.totalPln)}`).join('; ')}; razem ${pln(s.estimate.totalPln)}.`);
  } else lines.push('Nie ustalono przepływów do usług wyjścia do walut tradycyjnych, więc nie ma szacunku kwot.');
  if (s.reading) {
    lines.push(`Wpisy osoby: przeczytano ${s.reading.posts}, z czego ${s.reading.generated} napisały aplikacje; wypowiedzi o własnych kryptowalutach: ${s.reading.statements.length}.`);
    for (const x of s.reading.statements.filter((y) => !y.detail || y.detail.concernsAuthor).slice(0, 5)) {
      lines.push(`Wypowiedź${x.at ? ` z ${x.at.slice(0, 10)}` : ''}: „${x.text.replace(/\s+/g, ' ').slice(0, 220)}”${x.detail ? ` (odczytano: ${x.detail.kind}${x.detail.amount ? ` ${x.detail.amount}` : ''}${x.detail.asset ? ` ${x.detail.asset}` : ''})` : ''}.`);
    }
  }
  return lines.join('\n');
}

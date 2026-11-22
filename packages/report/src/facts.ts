import { knowsIdentity, type Finding, type Lead } from '@olcys/core';
import type { RunSummary } from '@olcys/engine';

const short = (a: string) => (a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a);
const pln = (n: number) => `${Math.round(n).toLocaleString('pl-PL')} zł`;
const num = (n: number) => n.toLocaleString('pl-PL', { maximumFractionDigits: 6 });
const BAND: Record<string, string> = { very_high: 'bardzo wysokie', probable: 'prawdopodobne', medium: 'średnie', noise: 'niskie' };
const CHAIN: Record<string, string> = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', tron: 'Tron' };
const CLAIM: Record<string, string> = { verified_account: 'należy do jej zweryfikowanego klienta', verified_country: 'należy do klienta zweryfikowanego w kraju' };
const RECORD: Record<string, string> = { 'com.twitter': 'X (Twitter)', 'com.github': 'GitHub', 'org.telegram': 'Telegram', 'xyz.farcaster': 'Farcaster', 'com.discord': 'Discord', url: 'strona' };

/**
 * The findings of a run as numbered sentences, each marked with its layer (source fact, computed result,
 * conclusion to verify) and, where there is one, the place it can be checked. This list is the only thing the
 * language model is given: whatever is not here, the model has no way to know, and whatever it writes must
 * point back at entries of this list.
 */
export function caseFindings(s: RunSummary): Finding[] {
  const out: Finding[] = [];
  const add = (layer: Finding['layer'], text: string, source?: string) => out.push({ id: `U${out.length + 1}`, layer, text, ...(source ? { source } : {}) });

  const seeds = s.identifiers.filter((i) => i.origin === 'seed');
  add('fact', `Wprowadzono: ${seeds.map((i) => `${i.kind === 'username' ? 'nick' : i.kind === 'crypto_address' ? 'adres' : i.kind} „${i.value}”`).join(', ')}.`);

  const a = s.assessment;
  const subject = a?.clusters.find((c) => c.level === 'entered' || c.level === 'publisher');
  if (subject) {
    for (const x of subject.accounts.slice(0, 8)) add('fact', `Konto ${x.handle} w serwisie ${x.source}${x.displayName ? ` (nazwa wyświetlana: ${x.displayName})` : ''} zaliczono do kont badanej osoby.`, x.profileUrl);
    if (subject.accounts.length > 8) add('fact', `Za konta badanej osoby uznano jeszcze ${subject.accounts.length - 8} innych kont.`);
    for (const detail of [...new Set(subject.joins.map((j) => j.detail))].slice(0, 6)) add('computed', `Podstawa połączenia kont: ${detail}`);
    if (subject.rhythm?.quiet) add('computed', `Rytm doby (kontrola pomocnicza, przytoczyć dosłownie): ${subject.rhythm.note}`);
    if (!subject.accounts.length) add('computed', 'Nie znaleziono konta w sieci, które opublikowało wprowadzony adres. Ustalenia dotyczą adresu, nie osoby.');
  } else add('computed', 'Nie znaleziono konta, które można pewnie powiązać z wprowadzonymi danymi.');
  for (const c of a?.clusters.filter((x) => x !== subject) ?? []) {
    add('computed', `Konta niepotwierdzone, trzymane osobno (wynik ograniczony do ${c.identityCap}%): ${c.accounts.map((x) => `${x.handle} w serwisie ${x.source}`).join(', ')}.`);
  }

  const mine = (a?.links ?? []).filter((l) => l.clusterId === subject?.id);
  for (const l of mine.filter((x) => x.status === 'attributed').slice(0, 12)) {
    // The basis of a score is what scored; lines that only inform (an attestation, the kind of account) are separate findings.
    const scored = l.receipt.filter((x) => x.effect !== 'info');
    const last = scored[scored.length - 1];
    const entered = scored[0]?.rule === 'I1';
    add('computed', entered
      ? `Adres ${short(l.address)} (${CHAIN[l.chain] ?? l.chain}) wprowadził analityk jako punkt wyjścia sprawy. Żadne znalezione konto go nie opublikowało, więc analiza nie wskazuje osoby, do której należy.`
      : `Adres ${short(l.address)} (${CHAIN[l.chain] ?? l.chain}): Wskaźnik Pewności ${l.score}%, ${BAND[l.band] ?? l.band}${l.proven ? ', potwierdzony podpisem sprawdzonym matematycznie' : ''}. Podstawa: ${scored[0]?.title ?? ''}${last && last !== scored[0] ? `; ${last.title}` : ''}.`, l.occurrences[0]?.url);
  }
  const rejected = mine.filter((l) => l.status !== 'attributed');
  if (rejected.length) add('computed', `Odrzucono ${rejected.length} adresów, m.in.: ${rejected.slice(0, 4).map((l) => `${short(l.address)} (${l.receipt[0]?.title ?? ''})`).join(', ')}.`);

  for (const n of s.names.filter((x) => x.verified).slice(0, 6)) {
    const records = Object.entries(n.records).filter(([k]) => RECORD[k]).map(([k, v]) => `${RECORD[k]}: ${v}`);
    add('fact', `Adres ${short(n.address)} ma w łańcuchu bloków nazwę ${n.name}, ustawioną przez sam adres${records.length ? `. Rekordy nazwy wskazują: ${records.join(', ')}` : ''}.`, n.sourceUrl);
  }
  for (const att of s.attestations ?? []) {
    const said = att.note ?? `${att.issuer} poświadcza, że adres ${CLAIM[att.claim] ?? att.claim}${att.value ? ` ${att.value}` : ''}`;
    add('fact', `Publiczne poświadczenie dotyczące adresu ${short(att.address)} (${att.issuer}${att.at ? `, ${att.at.slice(0, 10)}` : ''}): ${said}. ${knowsIdentity(att) ? 'Poświadczenie nie podaje, kim jest właściciel; podaje, kto to wie.' : 'Poświadczenie nie wskazuje osoby.'}`, att.sourceUrl);
  }

  for (const w of s.chain.activity) {
    for (const o of w.offRamps) {
      const assets = new Map<string, number>();
      for (const d of o.deposits) assets.set(d.asset, (assets.get(d.asset) ?? 0) + d.amount);
      const span = [...o.deposits].sort((x, y) => x.at.localeCompare(y.at));
      add('computed', `Z adresu ${short(w.address)} wpłacono na giełdę ${o.exchange} przez adres ${short(o.depositAddress)}${o.network ? ` w sieci ${o.network}` : ''}: wpłat ${o.deposits.length}, razem ${[...assets].map(([asset, amount]) => `${num(amount)} ${asset}`).join(' + ')}, w okresie ${span[0].at.slice(0, 10)} – ${span[span.length - 1].at.slice(0, 10)}. ${o.detail}${o.registered ? ` Podmiot o nazwie ${o.registered.name} figurował w polskim rejestrze działalności w zakresie walut wirtualnych pod numerem ${o.registered.number} (NIP ${o.registered.nip}); zgodność dotyczy samej nazwy.` : ''}`);
    }
    for (const i of w.indicators.filter((x) => x.cashOut && x.rule !== 'W1')) add('computed', `Przepływy z adresu ${short(w.address)}: ${i.title} — ${i.summary}`);
  }
  if (s.estimate?.years.length) {
    add('conclusion', `Wartość do wyjaśnienia (kryptowaluty skierowane do usług wyjścia do walut tradycyjnych; narzędzie nie ustala, czy i jaki podatek jest należny): ${s.estimate.years.map((y) => `${y.year}: ${pln(y.totalPln)}`).join('; ')}; razem ${pln(s.estimate.totalPln)}.`);
  } else add('computed', 'Nie ustalono przepływów do usług wyjścia do walut tradycyjnych, więc nie ma szacunku kwot.');

  if (s.gaps?.length) {
    add('fact', `Analiza jest niepełna: ${s.gaps.length === 1 ? 'jedno źródło nie odpowiedziało' : `${s.gaps.length} źródeł lub zapytań nie dało odpowiedzi`} (${[...new Set(s.gaps.map((g) => g.source))].slice(0, 5).join(', ')}). Wynik może nie zawierać tego, co by pokazały.`);
  }
  if (s.reading) {
    add('computed', `Wpisy osoby: przeczytano ${s.reading.posts}, z czego ${s.reading.generated} napisały aplikacje; wypowiedzi o własnych kryptowalutach: ${s.reading.statements.length}.`);
    for (const x of s.reading.statements.filter((y) => !y.detail || y.detail.concernsAuthor).slice(0, 5)) {
      add('fact', `Wypowiedź osoby${x.at ? ` z ${x.at.slice(0, 10)}` : ''}: „${x.text.replace(/\s+/g, ' ').slice(0, 220)}”${x.detail ? ` (odczytano: ${x.detail.kind}${x.detail.amount ? ` ${x.detail.amount}` : ''}${x.detail.asset ? ` ${x.detail.asset}` : ''})` : ''}.`, x.url);
    }
  }
  return out;
}

/** The findings as plain lines, for a model asked to write free text. */
export const caseFacts = (s: RunSummary): string => caseFindings(s).map((f) => f.text).join('\n');

/**
 * What could still be done in the case, derived from the findings by fixed rules. The language model may put
 * these in order and say why; it cannot add a lead of its own.
 */
export function openLeads(s: RunSummary, findings: Finding[] = caseFindings(s)): Lead[] {
  const out: Lead[] = [];
  const basis = (needle: string) => findings.filter((f) => f.text.includes(needle)).map((f) => f.id);
  const add = (kind: Lead['kind'], text: string, from: string[]) => out.push({ id: `T${out.length + 1}`, kind, text, basis: from });

  for (const w of s.chain.activity) {
    for (const o of w.offRamps) {
      add('exchange_request', `Wystąpić do giełdy ${o.exchange} o dane klienta, któremu przypisano adres depozytowy ${short(o.depositAddress)}${o.network ? ` (sieć ${o.network})` : ''}: giełda zna tożsamość wpłacającego i dalszy los środków.`, basis(short(o.depositAddress)));
    }
  }
  const issuers = new Map<string, string>();
  for (const att of (s.attestations ?? []).filter(knowsIdentity)) if (!issuers.has(`${att.issuer}|${att.address}`)) issuers.set(`${att.issuer}|${att.address}`, att.issuer);
  for (const [key, issuer] of issuers) {
    const address = key.split('|')[1];
    add('attestation_request', `Wystąpić do ${issuer} o dane klienta: ${issuer} publicznie poświadcza, że sprawdził tożsamość właściciela adresu ${short(address)}.`, basis(`Publiczne poświadczenie dotyczące adresu ${short(address)} (${issuer}`));
  }
  const subject = s.assessment?.clusters.find((c) => c.level === 'entered' || c.level === 'publisher');
  const have = new Set((subject?.accounts ?? []).map((x) => x.handle.toLowerCase()));
  for (const n of s.names.filter((x) => x.verified)) {
    for (const [k, v] of Object.entries(n.records)) {
      const handle = v.replace(/^@/, '').replace(/^https?:\/\/[^/]+\//, '').trim();
      if (!RECORD[k] || k === 'url' || !handle || have.has(handle.toLowerCase())) continue;
      add('account', `Sprawdzić konto ${handle} w serwisie ${RECORD[k]}: wskazuje je rekord nazwy ${n.name}, ustawiony przez adres osoby, a konta tego nie ma wśród przeszukanych.`, basis(n.name));
    }
  }
  for (const c of s.assessment?.clusters.filter((x) => x !== subject) ?? []) {
    const names = c.accounts.map((x) => `${x.handle} w serwisie ${x.source}`).join(', ');
    add('unconfirmed', `Potwierdzić lub wykluczyć, że do osoby należy: ${names}. Dziś wynik adresów z tych kont jest ograniczony do ${c.identityCap}%.`, basis(c.accounts[0]?.handle ?? ''));
  }
  const mine = (s.assessment?.links ?? []).filter((l) => l.clusterId === subject?.id && l.status === 'attributed' && !l.proven && l.score < 80);
  for (const l of mine.slice(0, 4)) {
    add('address', `Wzmocnić powiązanie adresu ${short(l.address)} (dziś ${l.score}%). Rozstrzygnęłoby je: ${l.wouldConfirm[0] ?? 'niezależne potwierdzenie z innego serwisu.'}`, basis(short(l.address)));
  }
  return out;
}

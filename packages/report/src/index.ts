import type { Transfer } from '@olcys/core';
import type { RunSummary } from '@olcys/engine';
import { draftRequest, formatAmount, formatPln, type Link } from '@olcys/scoring';
import { embeddedFonts } from './fonts';

export interface ReportInput {
  summary: RunSummary;
  caseTitle: string;
  seeds: { kind: string; value: string }[];
  startedAt: string;
  generatedAt: string;
  /** Every stored page and explorer answer of the run, in the order it was fetched. */
  snapshots: { seq: number; url: string; fetched_at: string; sha256: string; connector_id: string }[];
  verification: { ok: boolean; checked: number; broken: number[] };
  /** All value movements of the analysed wallets. */
  transfers: (Transfer & { subject: string })[];
  /** Sources used, as recorded with the run. */
  sources: { id: string; name: string; hosts: string[]; synthetic?: boolean }[];
}

const KIND: Record<string, string> = {
  username: 'nick', full_name: 'imię i nazwisko', email: 'adres e-mail', phone: 'telefon', messenger_id: 'identyfikator komunikatora',
  profile_url: 'adres profilu', crypto_address: 'adres kryptowalutowy',
};
const CHAIN: Record<string, string> = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', tron: 'Tron' };
const BAND: Record<string, string> = {
  very_high: 'bardzo wysokie', probable: 'prawdopodobne', medium: 'średnie', noise: 'niskie, szum', excluded: 'wykluczone', not_attributable: 'nie do przypisania',
};
const LEVEL: Record<string, string> = {
  entered: 'Osoba, o którą pytano', publisher: 'Konto, które podało wprowadzony adres',
  name_unique: 'Możliwe, że ta sama osoba (zgodne tylko imię i nazwisko)', name_ambiguous: 'Inna osoba o tym samym imieniu i nazwisku?',
};
const PLACEMENT: Record<string, string> = {
  own_profile: 'własny profil', sale: 'ogłoszenie', discussion: 'dyskusja na forum', mass_comment: 'masowe komentarze', quoted: 'cytat cudzej wypowiedzi',
};
const ACCOUNT_KIND: Record<string, string> = {
  eoa: 'zwykły adres', delegated_eoa: 'adres prywatny z delegacją (EIP-7702)', smart_wallet: 'portfel kontraktowy', contract: 'smart kontrakt',
};
const CERTAINTY: Record<string, string> = { probable: 'zbycie prawdopodobne', possible: 'zbycie możliwe' };

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const short = (a: string) => (a.length > 22 ? `${a.slice(0, 10)}…${a.slice(-8)}` : a);
const minute = (iso?: string) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : '—');
const amounts = (list: { asset: string; amount: number }[]) => list.map((x) => `${formatAmount(x.amount)} ${x.asset}`).join(' + ') || '0';
const num = (n: number, digits = 2) => n.toLocaleString('pl-PL', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** The three kinds of statement the report keeps apart. */
type Kind = 'F' | 'O' | 'W';
const KIND_NAME: Record<Kind, string> = { F: 'fakt źródłowy', O: 'wynik obliczeń', W: 'wniosek do weryfikacji' };
const tag = (k: Kind) => `<span class="tag tag-${k}">${KIND_NAME[k]}</span>`;
const h2 = (n: number, title: string, k?: Kind) => `<h2><span class="n">${n}.</span> ${esc(title)} ${k ? tag(k) : ''}</h2>`;
const table = (head: string[], rows: string[][], cls = '') =>
  `<table class="${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

const CSS = `
@page { size: A4; margin: 16mm 15mm 18mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font: 10.5pt/1.45 'Brygada 1918', Georgia, 'Times New Roman', serif; color: #14213a; background: #fff; }
main { max-width: 180mm; margin: 0 auto; padding: 10mm 0 14mm; }
@media print { main { padding: 0; } }
h1 { margin: 0 0 2mm; font-size: 22pt; line-height: 1.15; }
.lead { margin: 0 0 6mm; font-size: 12pt; color: #44506a; }
h2 { margin: 9mm 0 3mm; padding-bottom: 1.2mm; border-bottom: 1.2pt solid #14213a; font-size: 14pt; break-after: avoid; }
h2 .n { display: inline-block; min-width: 7mm; }
h3 { margin: 6mm 0 2mm; font-size: 11.5pt; break-after: avoid; }
p { margin: 0 0 2.5mm; }
ul, ol { margin: 0 0 3mm; padding-left: 5.5mm; }
li { margin-bottom: 1mm; }
code, .mono { font-family: 'IBM Plex Mono', ui-monospace, Menlo, monospace; font-size: 0.85em; word-break: break-all; }
a { color: #24467e; word-break: break-all; }
table { width: 100%; margin: 2mm 0 4mm; border-collapse: collapse; font-size: 9pt; }
th, td { padding: 1.4mm 2mm 1.4mm 0; text-align: left; vertical-align: top; border-bottom: 0.4pt solid #cdd5d4; }
th { font-weight: 600; border-bottom: 0.8pt solid #44506a; }
tr { break-inside: avoid; }
td.r, th.r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.tag { display: inline-block; padding: 0 2mm; border: 0.6pt solid; border-radius: 1mm; font-size: 8.5pt; font-weight: 400; font-style: italic; white-space: nowrap; vertical-align: middle; }
.tag-F { color: #2c5a44; } .tag-O { color: #24467e; } .tag-W { color: #7a4f00; }
.meta td:first-child { width: 48mm; color: #44506a; }
.notice { margin: 4mm 0; padding: 2.5mm 4mm; border-left: 2pt solid #b98300; background: #fdf6e3; }
.legend { margin: 4mm 0; padding: 3mm 4mm; border: 0.6pt solid #a9b4b6; }
.legend p { margin: 0 0 1.5mm; } .legend p:last-child { margin: 0; }
.figures { display: flex; gap: 5mm; margin: 3mm 0 4mm; }
.figure { flex: 1; padding: 3mm 4mm; border: 0.6pt solid #a9b4b6; }
.figure b { display: block; font-size: 17pt; line-height: 1.2; }
.figure span { font-size: 9pt; color: #44506a; }
.addr { margin: 5mm 0 2mm; padding: 2.5mm 4mm; border-left: 3pt solid #104281; background: #f3f6f9; break-inside: avoid; }
.addr.rej { border-left-color: #d03b3b; }
.addr .score { float: right; font-size: 18pt; font-weight: 700; line-height: 1; }
.addr .mono { font-size: 9.5pt; font-weight: 500; }
.small { font-size: 9pt; color: #44506a; }
pre { margin: 2mm 0 4mm; padding: 3mm 4mm; border: 0.6pt solid #a9b4b6; font: 8.5pt/1.45 'IBM Plex Mono', ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; }
.hash { font-size: 6.8pt; }
dl { margin: 0; } dt { font-weight: 600; margin-top: 2mm; } dd { margin: 0 0 1mm; }
section { break-inside: auto; }
`;

function receipt(l: Link): string {
  return table(
    ['Reguła', 'Przesłanka', '<span class="r">Punkty</span>', '<span class="r">Wynik</span>'],
    l.receipt.map((r) => [
      `<code>${esc(r.rule)}</code>`,
      `<b>${esc(r.title)}.</b> ${esc(r.detail)}`,
      r.points === null ? '—' : r.effect === 'bonus' ? `+${r.points}` : r.effect === 'cap' ? `do ${r.points}` : String(r.points),
      `${r.total}%`,
    ]),
  );
}

/**
 * The OSINT report as one self-contained HTML document: readable on screen, printable, and the source of the PDF.
 * Written for a reader without technical background; every statement is marked as a source fact,
 * a computed result, or a conclusion that needs verification.
 */
export function renderReport(input: ReportInput): string {
  const { summary: s } = input;
  const a = s.assessment;
  const links = a?.links ?? [];
  // Accounts matched by name only may belong to someone else; their addresses are reported apart.
  const firmClusters = new Set((a?.clusters ?? []).filter((c) => c.level === 'entered' || c.level === 'publisher').map((c) => c.id));
  const attributed = links.filter((l) => l.status === 'attributed' && firmClusters.has(l.clusterId));
  const uncertain = links.filter((l) => l.status === 'attributed' && !firmClusters.has(l.clusterId));
  const rejected = links.filter((l) => l.status !== 'attributed');
  const synthetic = input.sources.some((x) => x.synthetic);
  const exchanges = [...new Set(s.chain.activity.flatMap((x) => x.offRamps.map((o) => o.exchange)))];
  const e = s.estimate;
  const out: string[] = [];
  let n = 0;

  out.push(`<h1>Raport z analizy otwartych źródeł</h1>
<p class="lead">Powiązania osoby z adresami kryptowalut i ślady wyjścia do walut tradycyjnych</p>`);
  out.push(table(['', ''], [
    ['Sprawa', esc(input.caseTitle)],
    ['Wprowadzone dane', input.seeds.map((x) => `${KIND[x.kind] ?? x.kind}: <b>${esc(x.value)}</b>`).join('; ')],
    ['Analizę wykonano', `${minute(input.startedAt)} UTC`],
    ['Numer analizy', `<code>${esc(s.runId)}</code>`],
    ['Reguły punktacji', a ? `${esc(a.ruleset.name)}, wersja ${esc(a.ruleset.version)}` : '—'],
    ['Raport wygenerowano', `${minute(input.generatedAt)} UTC`],
  ], 'meta'));
  if (synthetic) out.push('<p class="notice">Analizę wykonano w środowisku testowym na danych syntetycznych. Osoby, konta i transakcje są fikcyjne. Kursy NBP i kursy rynkowe są rzeczywiste.</p>');

  out.push(`<div class="legend">
<p><b>Jak czytać ten raport.</b> Każda część jest oznaczona jednym z trzech rodzajów stwierdzeń:</p>
<p>${tag('F')} — coś, co zostało znalezione i zapisane dokładnie tak, jak było w źródle: treść strony, adres, transakcja.</p>
<p>${tag('O')} — coś, co program wyliczył z faktów według jawnych reguł; każdy wynik można przeliczyć ponownie.</p>
<p>${tag('W')} — przypuszczenie, które wskazuje, co warto sprawdzić. Nie jest ustaleniem.</p>
</div>`);

  // ---- 1. summary
  out.push(h2(++n, 'Podsumowanie'));
  out.push(`<div class="figures">
<div class="figure"><b>${attributed.length}</b><span>${attributed.length === 1 ? 'adres powiązany' : 'adresy powiązane'} z osobą</span></div>
<div class="figure"><b>${rejected.length}</b><span>odrzucone przypisania</span></div>
<div class="figure"><b>${e ? esc(formatPln(e.totalPln)) : '—'}</b><span>szacunkowa wartość środków skierowanych do usług wyjścia</span></div>
</div>`);
  const strongest = attributed.slice(0, 4).map((l) => `<span class="mono">${esc(short(l.address))}</span> (${CHAIN[l.chain] ?? l.chain}, ${l.score}%)`);
  out.push(`<p>${tag('O')} ${attributed.length ? `Z osobą powiązano ${attributed.length} ${attributed.length === 1 ? 'adres kryptowalutowy' : 'adresy kryptowalutowe'}. Najsilniejsze powiązania: ${strongest.join(', ')}.` : 'Nie znaleziono adresów, które można powiązać z osobą.'}</p>`);
  if (rejected.length) out.push(`<p>${tag('O')} Odrzucono ${rejected.length} przypisań: adresy giełd, kontraktów i innych podmiotów oraz adresy cudze, które osoba jedynie zacytowała.</p>`);
  if (exchanges.length) out.push(`<p>${tag('W')} Środki trafiały na giełdę: <b>${exchanges.map(esc).join(', ')}</b>. Giełda zna tożsamość klienta, do którego należy adres depozytowy — projekt zapytania znajduje się w części „Projekt zapytania do giełdy”.</p>`);
  if (e?.years.length) {
    out.push(`<p>${tag('W')} Szacunkowa wartość środków skierowanych do usług, w których kryptowaluta może zostać zamieniona na walutę tradycyjną:</p>`);
    out.push(table(['Rok', '<span class="r">Zbycie prawdopodobne</span>', '<span class="r">Zbycie możliwe</span>', '<span class="r">Razem</span>'],
      e.years.map((y) => [`<b>${y.year}</b>`, esc(formatPln(y.probablePln)), esc(formatPln(y.possiblePln)), `<b>${esc(formatPln(y.totalPln))}</b>`])));
    out.push('<p class="small">To potencjalny przychód do wyjaśnienia, a nie dochód: nie uwzględnia kosztów nabycia i wymaga potwierdzenia u wskazanych podmiotów.</p>');
  }
  out.push(`<p>${tag('F')} Ustalenia opierają się na ${s.counts.snapshots} zapisanych stronach i odpowiedziach eksploratora łańcucha bloków. ${input.verification.ok ? 'Magazyn dowodów jest nienaruszony: zgadzają się wszystkie skróty treści i cały łańcuch skrótów.' : `Uwaga: magazyn dowodów jest naruszony w zapisach nr ${input.verification.broken.join(', ')}.`}</p>`);

  // ---- 2. identities
  out.push(h2(++n, 'Osoba i jej konta w sieci', 'O'));
  if (!a?.clusters.length) out.push('<p>Nie znaleziono żadnego konta odpowiadającego wprowadzonym danym.</p>');
  for (const c of a?.clusters ?? []) {
    out.push(`<h3>${esc(LEVEL[c.level] ?? c.level)}${c.identityCap < 100 ? ` — wynik ograniczony do ${c.identityCap}%` : ''}</h3><p>${esc(c.identityNote)}</p>`);
    out.push(table(['Serwis', 'Nazwa konta', 'Adres profilu'], c.accounts.map((x) => [esc(x.source), `<b>${esc(x.handle)}</b>${x.displayName ? `, podpisane: ${esc(x.displayName)}` : ''}`, x.profileUrl ? `<a href="${esc(x.profileUrl)}">${esc(x.profileUrl)}</a>` : '—'])));
    if (c.joins.length) out.push(`<p>Dlaczego te konta uznano za jedną osobę:</p><ul>${c.joins.map((j) => `<li><code>${esc(j.rule)}</code> ${esc(j.detail)}</li>`).join('')}</ul>`);
    if (c.identifiers.length) out.push(`<p class="small">Dane podane przez osobę na profilach: ${c.identifiers.map((i) => `${KIND[i.kind] ?? i.kind} ${esc(i.value)}`).join('; ')}.</p>`);
  }

  // ---- profiles over time
  const histories = (a?.histories ?? []).filter((h) => h.changes.length);
  if (histories.length) {
    out.push(h2(++n, 'Zmiany na profilach w czasie', 'F'));
    out.push('<p>Porównano obecny profil z jego wersjami zapisanymi w archiwum stron.</p>');
    for (const h of histories) {
      out.push(`<h3>${esc(h.handle)}, ${esc(h.source)}</h3>`);
      out.push(table(['Data wersji', 'Skąd', 'Adresy na profilu'], h.versions.map((v) => [
        v.at.slice(0, 10), v.source === 'live' ? 'profil pobrany podczas analizy' : `<a href="${esc(v.url)}">kopia w archiwum</a>`,
        v.addresses.map((x) => `<span class="mono">${esc(x.address)}</span>`).join('<br>') || '—',
      ])));
      out.push(`<ul>${h.changes.map((c) => `<li>${esc(c.detail)}</li>`).join('')}</ul>`);
    }
  }

  // ---- 3. attributed addresses
  out.push(h2(++n, 'Adresy powiązane z osobą'));
  if (!attributed.length) out.push('<p>Brak.</p>');
  const addressBlock = (l: Link) => {
    out.push(`<div class="addr"><span class="score">${l.score}%</span><span class="mono">${esc(l.address)}</span><br><span class="small">${CHAIN[l.chain] ?? l.chain} · pewność: ${BAND[l.band]}${l.account ? ` · ${ACCOUNT_KIND[l.account.kind]}` : ''}</span></div>`);
    out.push(`<p>${tag('O')} Uzasadnienie wyniku:</p>${receipt(l)}`);
    if (l.challenges.length) {
      out.push(`<p>${tag('W')} Co może podważyć ten wynik:</p><ul>${l.challenges.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul>`);
    }
    out.push(`<p>${tag('F')} Gdzie znaleziono adres:</p>`);
    out.push(table(['Miejsce', 'Autor', 'Fragment treści', 'Pobrano (UTC)'], l.occurrences.map((o) => [
      `${esc(PLACEMENT[o.placement])}, ${esc(o.source)}${o.archivedAt ? `<br><i>wersja archiwalna z ${o.archivedAt.slice(0, 10)}</i>` : ''}${o.image ? '<br><i>kod QR na zdjęciu</i>' : ''}<br><a href="${esc(o.image?.url ?? o.url)}">${esc(o.image?.url ?? o.url)}</a>`,
      `${esc(o.authorHandle ?? '—')}${o.quotedAuthor ? `<br>cytuje: ${esc(o.quotedAuthor)}` : ''}`,
      `${esc(o.context)}${o.method !== 'plain' ? '<br><i>adres był ukryty przed automatami</i>' : ''}`,
      `${minute(o.fetchedAt)}<br><span class="mono hash">${esc(o.snapshotSha256.slice(0, 20))}…</span>`,
    ])));
  };
  attributed.forEach(addressBlock);
  if (uncertain.length) {
    out.push('<h3>Adresy kont, które mogą należeć do innej osoby</h3><p>Konta dopasowano wyłącznie po imieniu i nazwisku. Dopóki nie potwierdzi tego drugi ślad, tych adresów nie należy łączyć z osobą; nie wchodzą też do szacunku.</p>');
    uncertain.forEach(addressBlock);
  }

  // ---- 4. rejected
  out.push(h2(++n, 'Odrzucone przypisania', 'O'));
  out.push(rejected.length
    ? `<p>Adresy znalezione w treściach osoby, których nie wolno jej przypisać.</p>${table(['Adres', 'Sieć', 'Powód odrzucenia'], rejected.map((l) => [
        `<span class="mono">${esc(l.address)}</span>`, CHAIN[l.chain] ?? l.chain, `<b>${esc(l.receipt[0]?.title ?? '')}.</b> ${esc(l.receipt[0]?.detail ?? '')}`,
      ]))}`
    : '<p>Brak.</p>');

  // ---- 5. on-chain activity
  out.push(h2(++n, 'Aktywność w łańcuchu bloków'));
  if (!s.chain.activity.length) out.push('<p>Brak danych z eksploratora.</p>');
  for (const w of s.chain.activity) {
    out.push(`<h3>Portfel adresu <span class="mono">${esc(short(w.address))}</span> (${CHAIN[w.chain] ?? w.chain})</h3>`);
    const left = e?.leftOut.find((x) => x.address === w.address);
    if (left) out.push(`<p class="small">Poza szacunkiem: ${esc(left.reason)} (wynik ${left.score}%).</p>`);
    if (w.wallet.length > 1) {
      out.push(`<p>${tag('O')} Do tej samej osoby należy ${w.wallet.length} adresów. Łączy je łańcuch bloków: środki z nich wydano w jednej transakcji albo wpłacono z nich na ten sam, osobisty adres depozytowy giełdy.</p>`);
      out.push(table(['Adres', 'Jak ustalono'], w.wallet.map((m) => [
        `<span class="mono">${esc(m.address)}</span>`,
        !m.via ? 'znaleziony w otwartych źródłach'
          : m.rule === 'D2' ? `wpłacał na ten sam adres depozytowy giełdy co inny adres tej osoby (<span class="mono">${esc(short(m.via.with))}</span>, transakcja <span class="mono">${esc(short(m.via.txHash))}</span>)`
          : `wydany w jednej transakcji z adresem ${esc(short(m.via.with))} (transakcja <span class="mono">${esc(short(m.via.txHash))}</span>)`,
      ])));
    }
    out.push(`<p>${tag('F')} Przelewów: ${w.activity.transfers}${w.activity.internal ? `, w tym ${w.activity.internal} między własnymi adresami` : ''}. Okres: ${minute(w.activity.firstAt)} – ${minute(w.activity.lastAt)}. Otrzymano: ${esc(amounts(w.activity.received))}. Wysłano: ${esc(amounts(w.activity.sent))}.</p>`);
    out.push(w.indicators.length
      ? `<p>${tag('W')} Wzorce, które mogą świadczyć o wyjściu do walut tradycyjnych:</p><ul>${w.indicators.map((i) => `<li><code>${esc(i.rule)}</code> <b>${esc(i.title)}.</b> ${esc(i.summary)}</li>`).join('')}</ul>`
      : `<p>${tag('W')} Nie wykryto przelewów do giełd, usług P2P, bramek płatniczych, kart ani kantorów.</p>`);
  }

  // ---- 6. estimate
  if (e) {
    out.push(h2(++n, 'Szacunek wartości w złotych', 'W'));
    for (const y of e.years) {
      out.push(`<h3>Rok ${y.year}: ${esc(formatPln(y.totalPln))}</h3>`);
      out.push(table(['Rodzaj usługi', 'Ocena', '<span class="r">Przelewów</span>', '<span class="r">Wartość</span>'], y.channels.map((c) => [esc(c.title), CERTAINTY[c.certainty], String(c.count), esc(formatPln(c.pln))])));
    }
    out.push(`<p><b>Metoda.</b></p><ul>${e.method.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`);
    if (e.leftOut.length) out.push(`<p>Adresy pominięte w szacunku: ${e.leftOut.map((x) => `<span class="mono">${esc(short(x.address))}</span> (${x.score}%, ${esc(x.reason)})`).join('; ')}.</p>`);
    out.push('<p>Przelewy objęte szacunkiem:</p>');
    out.push(table(['Data', 'Usługa', 'Ilość', '<span class="r">Kurs USD</span>', 'Kurs NBP', '<span class="r">Wartość</span>'], e.transfers.map((t) => [
      t.day,
      `${esc(t.counterparty ?? short(t.to))}<br><span class="small">${CERTAINTY[t.certainty]}</span>`,
      `${esc(formatAmount(t.amount))} ${esc(t.asset)}`,
      t.priceUsd !== undefined ? num(t.priceUsd) : '—',
      t.rate ? `${num(t.rate.mid, 4)}<br><span class="small">tab. ${esc(t.rate.table)} z ${t.rate.effectiveDate}</span>` : '—',
      t.valuePln !== undefined ? `<b>${esc(formatPln(t.valuePln))}</b>` : esc(t.note ?? '—'),
    ])));
  }

  // ---- 7. chronology
  out.push(h2(++n, 'Chronologiczny przebieg przepływu środków', 'F'));
  const wallets = s.chain.activity.map((w) => ({ root: w.address, members: new Set(w.wallet.map((m) => m.address)) }));
  const names = new Map<string, string>();
  for (const acc of s.chain.accounts) if (acc.labels[0]) names.set(acc.address, acc.labels[0].name);
  for (const w of s.chain.activity) for (const i of w.indicators) for (const c of i.counterparties) if (c.name) names.set(c.address, c.name);
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const t of [...input.transfers].sort((x, y) => x.at.localeCompare(y.at))) {
    const w = wallets.find((x) => x.members.has(t.from) || x.members.has(t.to));
    const key = `${t.txHash}|${t.from}|${t.to}|${t.asset}|${t.amount}`;
    if (!w || seen.has(key)) continue;
    seen.add(key);
    const [mine, theirs] = [w.members.has(t.from), w.members.has(t.to)];
    const other = mine ? t.to : t.from;
    const what = mine && theirs ? 'przeniesienie między własnymi adresami' : mine ? `wypłata do: ${esc(names.get(other) ?? short(other))}` : `wpływ od: ${esc(names.get(other) ?? short(other))}`;
    rows.push([minute(t.at), `<span class="mono">${esc(short(w.root))}</span>`, what, `${mine && !theirs ? '−' : theirs && !mine ? '+' : ''}${esc(formatAmount(t.amount))} ${esc(t.asset)}`, `<span class="mono hash">${esc(short(t.txHash))}</span>`]);
  }
  out.push(rows.length
    ? `<p>Wszystkie przelewy analizowanych portfeli w kolejności czasowej (czas UTC).</p>${table(['Data', 'Portfel', 'Zdarzenie', '<span class="r">Kwota</span>', 'Transakcja'], rows.slice(0, 400))}${rows.length > 400 ? `<p class="small">Pokazano pierwsze 400 z ${rows.length} przelewów.</p>` : ''}`
    : '<p>Brak przelewów.</p>');

  // ---- 8. request drafts
  const offRamps = s.chain.activity.flatMap((w) => w.offRamps);
  if (offRamps.length) {
    out.push(h2(++n, 'Projekt zapytania do giełdy', 'W'));
    out.push('<p>Giełda przypisuje adres depozytowy jednemu, zweryfikowanemu klientowi. Poniższe projekty zawierają dokładny wykaz zaobserwowanych wpłat.</p>');
    for (const o of offRamps) out.push(`<pre>${esc(draftRequest(o, { caseTitle: input.caseTitle, runId: s.runId, generatedAt: input.generatedAt }))}</pre>`);
  }

  // ---- 9. sources and reproducibility
  out.push(h2(++n, 'Źródła i odtwarzalność', 'F'));
  const p = s.params;
  out.push(`<p><b>Parametry wyszukiwania.</b> Głębokość podążania za tropami: ${p.maxDepth}. Sprawdzanie, kto jeszcze podał znalezione adresy: ${p.pivotOnAddresses ? 'tak' : 'nie'}. Najwyżej ${p.maxIdentifiers} tropów, ${p.maxChainAddresses} adresów analizowanych w łańcuchu bloków. Sprawdzono ${s.identifiers.length} tropów:</p>`);
  out.push(`<ul>${s.identifiers.filter((i) => i.kind !== 'crypto_address').map((i) => `<li>${KIND[i.kind] ?? i.kind}: ${esc(i.value)}${i.origin === 'seed' ? ' (wprowadzony)' : ''}</li>`).join('')}</ul>`);
  out.push(`<p><b>Wykorzystane źródła.</b></p>${table(['Źródło', 'Adres'], input.sources.map((x) => [esc(x.name), x.hosts.map(esc).join(', ')]))}`);
  out.push(`<p>Połączenia z adresami spoza listy dozwolonych źródeł: ${s.counts.denied === 0 ? 'żadnego' : `${s.counts.denied} zablokowanych`}.</p>`);
  out.push(`<p><b>Zapisane dowody.</b> Każda pobrana strona jest zapisana w niezmienionej postaci razem z czasem pobrania i skrótem SHA-256 jej treści. Skróty są połączone w łańcuch: zmiana dowolnego zapisu zmienia wszystkie następne. ${input.verification.ok ? `Sprawdzono ${input.verification.checked} zapisów — wszystkie zgodne.` : `Niezgodne zapisy: ${input.verification.broken.join(', ')}.`}</p>`);
  out.push(table(['Nr', 'Adres źródła', 'Pobrano (UTC)', 'Skrót SHA-256 treści'], input.snapshots.map((x) => [
    String(x.seq), `<a href="${esc(x.url)}">${esc(x.url)}</a>`, minute(x.fetched_at), `<span class="mono hash">${esc(x.sha256)}</span>`,
  ])));

  // ---- 10. glossary
  out.push(h2(++n, 'Słowniczek'));
  out.push(`<dl>
<dt>Adres kryptowalutowy</dt><dd>Publiczny numer, na który można wysłać kryptowalutę; odpowiednik numeru rachunku. Sam adres nie mówi, do kogo należy.</dd>
<dt>Łańcuch bloków, eksplorator</dt><dd>Publiczny rejestr wszystkich transakcji danej kryptowaluty i strona, na której można go przeglądać.</dd>
<dt>Portfel</dt><dd>Zbiór adresów, którymi zarządza jedna osoba. Portfel zwykle używa wielu adresów.</dd>
<dt>Giełda, adres depozytowy</dt><dd>Giełda to firma, w której można kupić lub sprzedać kryptowalutę. Każdemu klientowi przydziela własny adres do wpłat — adres depozytowy.</dd>
<dt>Smart kontrakt</dt><dd>Program działający w łańcuchu bloków, na przykład token albo automatyczna giełda. Jego adres nie jest portfelem osoby.</dd>
<dt>Stablecoin</dt><dd>Kryptowaluta, której kurs ma odpowiadać walucie tradycyjnej, zwykle dolarowi (USDT, USDC).</dd>
<dt>P2P, kantor, bramka płatnicza, karta</dt><dd>Usługi, przez które kryptowalutę zamienia się na pieniądze, towary lub usługi.</dd>
<dt>Skrót SHA-256</dt><dd>Krótki „odcisk palca” treści. Jeśli treść zmieni się choćby o jeden znak, skrót będzie inny — dzięki temu widać, że zapis nie został zmieniony.</dd>
<dt>Wskaźnik Pewności</dt><dd>Liczba od 0 do 100% opisująca, jak mocne są przesłanki, że adres należy do osoby. Wynika z jawnych reguł opisanych przy każdym adresie.</dd>
</dl>`);

  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raport OSINT — ${esc(input.caseTitle)}</title>
<style>${embeddedFonts()}${CSS}</style></head>
<body><main>${out.join('\n')}</main></body></html>`;
}

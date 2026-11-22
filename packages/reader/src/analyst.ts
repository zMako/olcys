import type { Finding, Lead, ProfileCard } from '@olcys/core';
import { allJson, firstJson, type LlmClient } from './llm';

/**
 * The language model as an analyst's assistant. It gets more to do than reading posts — describing the case,
 * reasoning a request, ordering open leads, comparing two accounts — but nothing it writes is taken on trust:
 *  - it is given numbered findings and must name, for every sentence, the findings the sentence rests on;
 *  - code then checks each sentence: the findings must exist, every number and address in the sentence must
 *    occur in the findings it names, and it must not make legal assessments or accusations;
 *  - a sentence that fails is dropped and kept, with the reason, next to the text that passed.
 * The model never decides what is searched and never joins accounts.
 */

export interface GroundedSentence {
  text: string;
  /** Findings the sentence rests on, e.g. ["U3", "U7"]. */
  cites: string[];
}

export interface Grounded {
  sentences: GroundedSentence[];
  /** What the model wrote and the checks did not accept. */
  rejected: { text: string; reason: string }[];
}

const ADDRESS = /0x[0-9a-fA-F]{4,}(?:…[0-9a-fA-F]{2,})?|\b(?:bc1|[13])[a-km-zA-HJ-NP-Z0-9]{9,}(?:…[a-zA-Z0-9]{2,})?|\bT[1-9A-HJ-NP-Za-km-z]{9,}(?:…[a-zA-Z0-9]{2,})?/g;
const LEGAL = /podlega\w* opodatkowani|opodatkowan|podatek (należny|wynosi|do zapłaty)|zobowiązani\w* podatkow|przestępstw|wykroczeni|\bwinn[yaie]\b|oszust|uchyla\w* się|unika\w* (podatk|opodatkowani)|zatai[łl]|ukrywa\w* doch/i;

const GUARDED: [string, string][] = [['poświadcz', 'poświadczeniu'], ['podpis', 'podpisie'], ['sankc', 'sankcjach'], ['oszust', 'oszustwie'], ['instytucj', 'instytucjach']];
const squash = (s: string) => s.toLowerCase().replace(/[  \s]+/g, ' ');
/** Numbers as written, reduced to a comparable form: "11 072" → "11072", "0,19" → "0.19". */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(ADDRESS, ' ').matchAll(/\d+(?:[   ]\d{3})*(?:[.,]\d+)?/g)) {
    out.push(m[0].replace(/[   ]/g, '').replace(',', '.').replace(/^0+(?=\d)/, ''));
  }
  return out;
}

/** Why a sentence cannot stand on the findings it names; undefined when it can. */
export function checkSentence(sentence: GroundedSentence, findings: Finding[], context = ''): string | undefined {
  const byId = new Map(findings.map((f) => [f.id, f]));
  if (!sentence.text.trim()) return 'puste zdanie';
  if (!sentence.cites.length) return 'nie wskazuje żadnego ustalenia';
  const missing = sentence.cites.filter((c) => !byId.has(c));
  if (missing.length) return `wskazuje ustalenie, którego nie ma: ${missing.join(', ')}`;
  if (LEGAL.test(sentence.text)) return 'zawiera ocenę prawną lub zarzut';
  // What the sentence may draw on: the findings it names, and whatever the task itself stated (e.g. whom a request is to).
  const cited = `${sentence.cites.map((c) => byId.get(c)!.text).join('\n')}\n${context}`;
  // An address may be written in full or shortened ("0x60EDB7Cf…CECFEC"); the two are the same address when head and tail agree.
  const sameAddress = (a: string) => `${a.slice(0, 8).toLowerCase()}|${a.slice(-4).toLowerCase()}`;
  const addresses = new Set((cited.match(ADDRESS) ?? []).map(sameAddress));
  for (const a of sentence.text.match(ADDRESS) ?? []) if (!addresses.has(sameAddress(a))) return `zawiera adres, którego nie ma we wskazanych ustaleniach: ${a}`;
  // Words that carry weight in a case may be used only where a named finding uses them: a score computed by the
  // tool is not an institution's attestation, and a link is not "proven by signature" unless a finding says so.
  for (const [stem, what] of GUARDED) if (squash(sentence.text).includes(stem) && !squash(cited).includes(stem)) return `mówi o ${what}, o którym wskazane ustalenia nie mówią`;
  const known = new Set(numbersIn(cited));
  for (const n of numbersIn(sentence.text)) {
    if (known.has(n)) continue;
    // the model may count what it cites ("trzy adresy" written as "3 adresy")
    if (/^\d+$/.test(n) && Number(n) <= Math.min(sentence.cites.length, 12)) continue;
    return `zawiera liczbę, której nie ma we wskazanych ustaleniach: ${n}`;
  }
  return undefined;
}

const cleanCites = (raw: unknown): string[] => [...new Set((Array.isArray(raw) ? raw : [raw]).flatMap((x) => String(x ?? '').toUpperCase().match(/[UT]\d+/g) ?? []))];
const stripMarks = (text: string) => text.replace(/\s*[\[(](?:U\d+(?:\s*,\s*)?)+[\])]/g, '').replace(/\s+([.,;])/g, '$1').trim();

/** Sentences out of a model's answer: the JSON it was asked for, or — failing that — lines with [U…] marks. */
export function parseSentences(answer: string): GroundedSentence[] {
  type Raw = { tekst?: unknown; ustalenia?: unknown; zdania?: Raw[] };
  // The object asked for, or a bare list of sentence objects: models send either.
  const raw = (allJson(answer) as Raw[]).flatMap((o) => (Array.isArray(o?.zdania) ? o.zdania : [o])).filter((z) => typeof z?.tekst === 'string');
  if (raw.length) {
    return raw.map((z) => ({ text: stripMarks(String(z.tekst)), cites: [...new Set([...cleanCites(z.ustalenia), ...cleanCites(String(z.tekst).match(/U\d+/g) ?? [])])] }));
  }
  if (/"tekst"\s*:/.test(answer)) return []; // JSON was attempted and is broken: better nothing than fragments of it
  return answer.split(/\n+|(?<=[.!?])\s+(?=[A-ZŻŹĆĄŚĘŁÓŃ])/).map((line) => line.trim()).filter((line) => /[a-ząćęłńóśźż]{3}/i.test(line))
    .map((line) => ({ text: stripMarks(line.replace(/^[-•\d.)\s]+/, '')), cites: cleanCites(line.match(/U\d+/g) ?? []) }));
}

const RULES = [
  'Zasady, których nie wolno złamać:',
  '1. Korzystasz WYŁĄCZNIE z ponumerowanych ustaleń podanych niżej. Niczego nie dodajesz i nie zgadujesz.',
  '2. Każde zdanie wskazuje numery ustaleń, na których się opiera. Zdanie bez wskazania zostanie odrzucone.',
  '3. Liczby, procenty, kwoty, daty, adresy i nazwy przepisujesz dosłownie z ustaleń, które wskazujesz.',
  '4. Nie wypowiadasz się o prawie ani o podatku i nie formułujesz zarzutów. O kwotach piszesz wyłącznie, że są „wartością do wyjaśnienia”.',
  '5. Odróżniasz to, co wynika ze źródeł, od tego, co jest wnioskiem do weryfikacji.',
  'Odpowiadasz WYŁĄCZNIE obiektem JSON w postaci: {"zdania":[{"tekst":"Pierwsze zdanie.","ustalenia":["U1","U3"]},{"tekst":"Drugie zdanie.","ustalenia":["U2"]}]}',
].join('\n');

const listed = (findings: Finding[]) => findings.map((f) => `[${f.id}] ${f.text}`).join('\n');

/**
 * Asks the model for text on a task and keeps only the sentences that stand on the findings.
 * Rejected sentences are sent back once with the reasons; what fails again stays rejected.
 */
export async function writeGrounded(llm: LlmClient, findings: Finding[], task: string, opts: { context?: string; retry?: boolean; maxSentences?: number } = {}): Promise<Grounded> {
  const system = `Jesteś asystentem analityka Krajowej Administracji Skarbowej. ${task}\n${RULES}`;
  const sentences: GroundedSentence[] = [];
  let rejected: Grounded['rejected'] = [];
  const take = (answer: string, onlyNew = false) => {
    const failed: Grounded['rejected'] = [];
    const covered = new Set(sentences.flatMap((x) => x.cites));
    for (const s of parseSentences(answer)) {
      const reason = checkSentence(s, findings, opts.context);
      if (reason) failed.push({ text: s.text, reason });
      // On the second attempt the model tends to repeat what already passed; only a sentence resting on a finding
      // not used yet adds anything.
      else if (onlyNew && s.cites.every((c) => covered.has(c))) continue;
      else if (!sentences.some((x) => squash(x.text) === squash(s.text))) sentences.push(s);
    }
    return failed;
  };
  rejected = take(await llm.complete(system, `Ustalenia:\n${listed(findings)}`));
  if (rejected.length && opts.retry !== false) {
    const again = take(await llm.complete(system, `Ustalenia:\n${listed(findings)}\n\nTe zdania zostały odrzucone. Napisz je ponownie zgodnie z zasadami albo pomiń:\n${rejected.map((r) => `- „${r.text}” — ${r.reason}`).join('\n')}`), true);
    rejected = [...rejected.filter((r) => !sentences.some((s) => squash(s.text) === squash(r.text))), ...again];
  }
  // A description is short and in the model's own words: a sentence that merely repeats one finding is dropped,
  // and so is everything past the length asked for (a model that runs on starts copying the list).
  const copies = sentences.filter((x) => findings.some((f) => squash(f.text).startsWith(squash(x.text).replace(/\.$/, '')) || squash(x.text).startsWith(squash(f.text).replace(/\.$/, ''))));
  const kept = sentences.filter((x) => !copies.includes(x)).slice(0, opts.maxSentences ?? 10);
  return { sentences: kept.length >= 2 ? kept : sentences.slice(0, opts.maxSentences ?? 10), rejected };
}

/** A description of the case: what was entered, what was found, how sure it is, where the money went. */
export const writeDossier = (llm: LlmClient, findings: Finding[]): Promise<Grounded> =>
  writeGrounded(llm, findings, 'Piszesz opis sprawy: 5–8 zdań po polsku, własnymi słowami — nie przepisuj listy ustaleń i nie pisz więcej niż 8 zdań. Kolejno: co wprowadzono i jakie konta znaleziono; które adresy powiązano i z jaką pewnością (Wskaźnik Pewności oblicza narzędzie — to nie jest poświadczenie żadnej instytucji); jeśli ustalenia mówią o publicznych poświadczeniach, co one stwierdzają; dokąd trafiły środki; jaka jest wartość do wyjaśnienia.');

/** The reasoning of a request to the party that holds the customer's identity. */
export const justifyRequest = (llm: LlmClient, findings: Finding[], addressee: string, subject: string): Promise<Grounded> =>
  writeGrounded(llm, findings, `Piszesz uzasadnienie wniosku do: ${addressee}. Wniosek dotyczy: ${subject}. Napisz 2–4 zdania po polsku: z jakich ustaleń wynika, że adresat ma dane właściciela adresu. Jeśli ustalenia wskazują konto osoby, które opublikowało ten adres, powołaj się na nie; jeśli ustalenia mówią, że adres wprowadził analityk i nie wskazują osoby, nie pisz, że adres powiązano z osobą. Pomiń ustalenia, które nie dotyczą tego wniosku.`, { context: `${addressee} ${subject}`, retry: false });

export interface RankedLead extends Lead {
  /** The model's reason for the position; empty when the model gave none that passed the checks. */
  reason: string;
}

/**
 * Puts the open leads in the order worth following. The leads themselves come from fixed rules; the model orders
 * them and says why. Unknown or repeated lead numbers are ignored; leads the model left out keep their place at the end.
 */
export async function rankLeads(llm: LlmClient, leads: Lead[], findings: Finding[]): Promise<{ leads: RankedLead[]; byModel: boolean }> {
  if (leads.length < 2) return { leads: leads.map((l) => ({ ...l, reason: '' })), byModel: false };
  const answer = await llm.complete(
    [
      'Jesteś asystentem analityka Krajowej Administracji Skarbowej. Dostajesz ustalenia sprawy i listę możliwych dalszych czynności (tropów).',
      'Ułóż tropy od najbardziej do najmniej wartego podjęcia. Najwyżej stawiasz czynności, które mogą ustalić tożsamość właściciela adresu lub potwierdzić przepływ środków, i które opierają się na najpewniejszych ustaleniach.',
      'Dla każdego tropu podaj jedno krótkie zdanie uzasadnienia, oparte wyłącznie na ustaleniach. Nie dodawaj własnych tropów. Nie wypowiadaj się o prawie ani o podatku.',
      'Odpowiadasz WYŁĄCZNIE obiektem JSON: {"kolejnosc":[{"trop":"T2","powod":"Krótkie uzasadnienie."},{"trop":"T1","powod":"…"}]}',
    ].join('\n'),
    `Ustalenia:\n${listed(findings)}\n\nTropy:\n${leads.map((l) => `[${l.id}] ${l.text}`).join('\n')}`,
  );
  type Item = { trop?: unknown; powod?: unknown; kolejnosc?: Item[] };
  // the object asked for, or a bare list of its items
  const parsed = { kolejnosc: (allJson(answer) as Item[]).flatMap((o) => (Array.isArray(o?.kolejnosc) ? o.kolejnosc : [o])).filter((o) => o?.trop !== undefined) };
  const byId = new Map(leads.map((l) => [l.id, l]));
  const out: RankedLead[] = [];
  for (const item of Array.isArray(parsed?.kolejnosc) ? parsed.kolejnosc : []) {
    const id = String(item?.trop ?? '').toUpperCase().match(/T\d+/)?.[0];
    const lead = id ? byId.get(id) : undefined;
    if (!lead || out.some((x) => x.id === lead.id)) continue;
    const reason = typeof item.powod === 'string' ? item.powod.trim() : '';
    // the reason may use what the lead itself and any finding say; anything else is dropped
    const pool: Finding[] = [...findings, { id: 'T', layer: 'computed', text: lead.text }];
    const ok = reason && !checkSentence({ text: reason, cites: pool.map((f) => f.id) }, pool);
    out.push({ ...lead, reason: ok ? reason : '' });
  }
  const byModel = out.length >= 2;
  for (const l of leads) if (!out.some((x) => x.id === l.id)) out.push({ ...l, reason: '' });
  return { leads: byModel ? out : leads.map((l) => ({ ...l, reason: '' })), byModel };
}

/**
 * Whether two quotes share a distinctive word: the same word of five letters or more, exactly. Words that merely
 * resemble each other ("rozliczenia" and "rozliczam") are not accepted; that is a similarity of topic, not a detail in common.
 * Nicks and display names do not count — a similar nick or name is why the account is a candidate in the first
 * place — and neither do crypto addresses, which are either identical (a rule already joins on that) or unrelated.
 */
function shares(a: string, b: string, cards: ProfileCard[]): boolean {
  const words = (t: string) => squash(t).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5 && w.length <= 25);
  const names = new Set(cards.flatMap((c) => words(`${c.handle} ${c.displayName ?? ''} ${c.handle.replace(/[^\p{L}\p{N}]/gu, '')}`)));
  const [x, y] = [words(a).filter((w) => !names.has(w)), words(b).filter((w) => !names.has(w))];
  return x.some((w) => y.includes(w));
}

export interface Judgement {
  verdict: 'same' | 'different' | 'unclear';
  /** Evidence that passed the check: each quotes both accounts. */
  reasons: string[];
  /** Pieces of evidence the model gave that quoted something neither account says. */
  rejected: number;
}

const cardText = (c: ProfileCard) => [`Serwis: ${c.service}`, `Nick: ${c.handle}`, c.displayName ? `Nazwa: ${c.displayName}` : '', c.profile ? `Opis profilu: ${c.profile}` : '', ...c.posts.map((p, i) => `Wpis ${i + 1}: ${p}`)].filter(Boolean).join('\n');

/**
 * Compares an unconfirmed account with the person's confirmed accounts. The model must quote both sides for every
 * piece of evidence; quotes that are not in the accounts' own text are thrown out, and a verdict left without
 * evidence becomes "unclear". The verdict never joins accounts — it only nudges a score under its limit.
 */
export async function judgeSamePerson(llm: LlmClient, known: ProfileCard[], candidate: ProfileCard): Promise<Judgement> {
  const answer = await llm.complete(
    [
      'Jesteś asystentem analityka. Porównujesz konto-kandydata z kontami, o których wiadomo, że należą do badanej osoby, i oceniasz, czy kandydat to ta sama osoba.',
      'Sam podobny nick NIE jest dowodem. Dowodem są zgodne lub sprzeczne szczegóły: miejscowość, zawód, zainteresowania, język, styl, wspomniane projekty, linki, nazwy.',
      'Każdy dowód musi zawierać dosłowny cytat z kont osoby i dosłowny cytat z konta kandydata. Cytaty przepisz znak w znak. Jeśli nie ma takich cytatów, werdykt to "nie_wiadomo".',
      'Odpowiadasz WYŁĄCZNIE obiektem JSON: {"werdykt":"ta_sama"|"inna"|"nie_wiadomo","dowody":[{"co":"czego dotyczy dowód","cytat_osoba":"…","cytat_kandydat":"…"}]}',
    ].join('\n'),
    `KONTA OSOBY:\n${known.map(cardText).join('\n---\n')}\n\nKONTO KANDYDATA:\n${cardText(candidate)}`,
  );
  const parsed = firstJson<{ werdykt?: unknown; dowody?: { co?: unknown; cytat_osoba?: unknown; cytat_kandydat?: unknown }[] }>(answer);
  const said = String(parsed?.werdykt ?? '').toLowerCase();
  let verdict: Judgement['verdict'] = said.includes('ta_sama') || said === 'ta sama' ? 'same' : said.includes('inna') ? 'different' : 'unclear';
  const [mine, theirs] = [squash(known.map(cardText).join('\n')), squash(cardText(candidate))];
  const reasons: string[] = [];
  let rejected = 0;
  for (const e of Array.isArray(parsed?.dowody) ? parsed.dowody : []) {
    const [a, b] = [String(e?.cytat_osoba ?? '').trim(), String(e?.cytat_kandydat ?? '').trim()];
    // A quote has to be real text of the account, and more than the nick itself.
    const real = (q: string, text: string, handle: string) => q.length >= 3 && text.includes(squash(q)) && squash(q) !== handle.toLowerCase();
    // "The same person" needs something the two quotes actually share; two different addresses or two unrelated sentences are not it.
    const holds = verdict !== 'same' || shares(a, b, [...known, candidate]);
    if (holds && real(a, mine, known[0]?.handle ?? '') && real(b, theirs, candidate.handle)) reasons.push(`${String(e.co ?? 'zgodność').trim().slice(0, 80)}: „${a.slice(0, 120)}” ↔ „${b.slice(0, 120)}”.`);
    else rejected++;
  }
  if (verdict !== 'unclear' && !reasons.length) verdict = 'unclear';
  return { verdict, reasons: reasons.slice(0, 4), rejected };
}

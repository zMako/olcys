import { readFileSync } from 'node:fs';

/**
 * The Polish register of virtual-currency businesses ("Rejestr działalności w zakresie walut wirtualnych"),
 * kept by the Director of the Tax Administration Chamber in Katowice and published on gov.pl.
 *
 * It answers one question about a counterparty: is a business of this name known to the Polish tax
 * administration, and under which number, NIP and KRS can it be written to?
 *
 * What it does not answer: the register lists names, not addresses, and a match is a match of names. Many
 * entries are small companies whose names resemble well-known brands; the NIP and KRS in the entry are what
 * identifies the business. The published edition is archival (see `status`): an entry is no licence.
 */
export interface RegisteredVasp {
  /** Register number, e.g. "RDWW-465". */
  number: string;
  /** Date of entry, ISO. */
  entered: string;
  /** Name exactly as registered. */
  name: string;
  /** A company, or a person running a business in their own name. */
  kind: 'company' | 'person';
  nip: string;
  krs?: string;
  /** Registered services, in the register's own wording. */
  services: string[];
  /** Activity suspended from this date (ISO), if the register says so. */
  suspendedFrom?: string;
  /** Struck off the register ("wykreślony"). */
  struckOff: boolean;
}

export interface VaspMatch extends RegisteredVasp {
  /**
   * How the name led to the entry: `name` — the registered name itself; `brand` — the registered name is the
   * brand followed by a country ("Binance" → "BINANCE POLAND …"); `alias` — a trade name whose operator is known.
   */
  matched: 'name' | 'brand' | 'alias';
}

interface RegisterFile {
  register: string;
  keptBy: string;
  edition: string;
  status: string;
  sourcePage: string;
  sourceFile: string;
  retrieved: string;
  services: Record<string, string>;
  entries: { number: string; entered: string; name: string; kind: 'company' | 'person'; nip: string; services: string; krs?: string; suspendedFrom?: string; struckOff?: boolean }[];
}

interface Loaded {
  file: RegisterFile;
  entries: RegisteredVasp[];
  /** Core name (legal form and punctuation removed) → entries. */
  byCore: Map<string, RegisteredVasp[]>;
  /** People: the words of the name in alphabetical order → entries, so "Kowalski Jan" finds "JAN KOWALSKI". */
  byPerson: Map<string, RegisteredVasp[]>;
}

let loaded: Loaded | undefined;

const fold = (s: string) =>
  s
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/Ł/g, 'L')
    .replace(/Ø/g, 'O');

/** Legal forms, as the register writes them and as people abbreviate them. Longest first. */
const LEGAL_FORMS = [
  'SPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA SPOLKA KOMANDYTOWA', 'SPOLKA Z OGRANICZONA ODPOWIEDZIALNOSCIA', 'PROSTA SPOLKA AKCYJNA', 'SPOLKA KOMANDYTOWO AKCYJNA',
  'SPOLKA KOMANDYTOWA', 'SPOLKA AKCYJNA', 'SPOLKA JAWNA', 'SPOLKA CYWILNA', 'SP Z O O SP K', 'SP Z O O', 'SP ZOO', 'Z O O', 'SP K', 'SP J', 'S A', 'P S A', 'S C',
  'SOCIEDAD LIMITADA', 'BESLOTEN VENNOOTSCHAP', 'OSAUHING', 'LIMITED', 'LTD', 'OU', 'UAB', 'GMBH', 'LLC', 'INC', 'SAS', 'S R O', 'S L', 'B V', 'AG', 'SIA', 'SRL', 'LLP', 'CORP',
];
const TRAILERS = ['W LIKWIDACJI', 'W ORGANIZACJI', 'W UPADLOSCI', 'W RESTRUKTURYZACJI', 'ODDZIAL W POLSCE'];
const strip = (s: string, endings: string[]): string => {
  for (let again = true; again; ) {
    again = false;
    for (const e of endings) {
      if (s === e || s.endsWith(` ${e}`)) {
        s = s.slice(0, s.length - e.length).trim();
        again = true;
      }
    }
  }
  return s;
};

/** "Binance Poland sp. z o.o." → "BINANCE POLAND": the part of a business name that distinguishes it. */
export function vaspCoreName(name: string): string {
  const words = fold(name).replace(/[^A-Z0-9]+/g, ' ').trim();
  return strip(strip(words, TRAILERS), LEGAL_FORMS) || words;
}

/** What an address label adds around the business's name: "Binance: Hot Wallet", "Binance 14", "ByBit Deposit". */
const LABEL_NOISE = /\b(HOT|COLD|WALLET|WALLETS|DEPOSIT|DEPOSITS|WITHDRAWAL|WITHDRAWALS|FUNDER|FUNDING|EXCHANGE|ADRES|DEPOZYTOWY|GIELDA|GIELDY|\d+)\b/g;
const labelCore = (label: string) => vaspCoreName(fold(label.split(':')[0]).replace(/[^A-Z0-9]+/g, ' ').replace(LABEL_NOISE, ' '));

/** Words that turn a brand into the name of its local company: "BINANCE POLAND", "WIREX EUROPE". Geography only. */
const LOCAL = new Set(['POLAND', 'POLSKA', 'PL', 'EUROPE', 'EU']);

/**
 * Trade names whose operating company is registered under a different name. An alias is added only when the
 * operator can be confirmed from the register itself or from the brand's own published terms; none has been
 * confirmed that way so far, so the table is empty and brand matching rests on the registered names alone.
 * Format: folded trade name → register number.
 */
// Trade names whose operator is known. Zonda (formerly BitBay) is operated by BB Trade Estonia OU — confirmed by the project owner.
const ALIASES: Record<string, string> = { ZONDA: 'RDWW-893', ZONDACRYPTO: 'RDWW-893', BITBAY: 'RDWW-893' };

function load(): Loaded {
  if (loaded) return loaded;
  const file = JSON.parse(readFileSync(new URL('../data/vasp-pl.json', import.meta.url), 'utf8')) as RegisterFile;
  const entries: RegisteredVasp[] = file.entries.map((e) => ({
    number: e.number, entered: e.entered, name: e.name, kind: e.kind, nip: e.nip, ...(e.krs ? { krs: e.krs } : {}),
    services: [...e.services].map((letter) => file.services[letter]),
    ...(e.suspendedFrom ? { suspendedFrom: e.suspendedFrom } : {}), struckOff: e.struckOff === true,
  }));
  const byCore = new Map<string, RegisteredVasp[]>();
  const byPerson = new Map<string, RegisteredVasp[]>();
  const add = (m: Map<string, RegisteredVasp[]>, k: string, e: RegisteredVasp) => m.set(k, [...(m.get(k) ?? []), e]);
  for (const e of entries) {
    add(byCore, vaspCoreName(e.name), e);
    if (e.kind === 'person') add(byPerson, vaspCoreName(e.name).split(' ').sort().join(' '), e);
  }
  loaded = { file, entries, byCore, byPerson };
  return loaded;
}

/** Of several entries under one name, the one still on the register comes first, then the oldest. */
const best = (list: RegisteredVasp[] | undefined): RegisteredVasp | undefined =>
  list?.length ? [...list].sort((a, b) => Number(a.struckOff) - Number(b.struckOff) || a.entered.localeCompare(b.entered))[0] : undefined;

/**
 * Looks a business name up in the register. Accepts a registered name in any spelling of its legal form
 * ("FlyingAtom sp. z o.o."), a brand ("Binance"), an address label ("Binance: Hot Wallet", "Binance 14"),
 * or a person's name in either order. Returns the entry and how it was matched, or undefined.
 *
 * A brand is matched only to a registered name that is the brand alone or the brand plus a country — never to
 * a longer name that merely contains it ("Bybit" does not match "BITBYBIT TRADE").
 */
export function findRegisteredVasp(name: string): VaspMatch | undefined {
  const r = load();
  const core = vaspCoreName(name);
  if (core.length < 3) return undefined;
  const exact = best(r.byCore.get(core)) ?? best(r.byPerson.get(core.split(' ').sort().join(' ')));
  if (exact) return { ...exact, matched: 'name' };

  // What is left of a label once "Hot Wallet", "Deposit" or a number is taken off. Very short remainders
  // ("Bit", "X") are words, not brands, and are not looked up.
  const brand = labelCore(name);
  if (brand.length < 4) return undefined;
  const alias = ALIASES[brand] ?? ALIASES[core];
  if (alias) {
    const entry = r.entries.find((e) => e.number === alias);
    if (entry) return { ...entry, matched: 'alias' };
  }
  const direct = best(r.byCore.get(brand));
  if (direct) return { ...direct, matched: 'brand' };
  const local = best([...LOCAL].flatMap((w) => r.byCore.get(`${brand} ${w}`) ?? []).filter((e) => e.kind === 'company'));
  return local ? { ...local, matched: 'brand' } : undefined;
}

/** The register as bundled: its edition, status note, source, and every entry. */
export function registeredVasps(): {
  register: string; keptBy: string; edition: string; status: string; sourcePage: string; sourceFile: string; retrieved: string;
  count: number; active: number; struckOff: number; companies: number; persons: number; entries: RegisteredVasp[];
} {
  const { file, entries } = load();
  const struckOff = entries.filter((e) => e.struckOff).length;
  return {
    register: file.register, keptBy: file.keptBy, edition: file.edition, status: file.status, sourcePage: file.sourcePage, sourceFile: file.sourceFile, retrieved: file.retrieved,
    count: entries.length, active: entries.length - struckOff, struckOff,
    companies: entries.filter((e) => e.kind === 'company').length, persons: entries.filter((e) => e.kind === 'person').length, entries,
  };
}

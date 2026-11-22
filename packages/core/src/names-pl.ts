import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * How common a first name + surname is in Poland, from the statistics of the PESEL register published
 * on dane.gov.pl (living persons; datasets "Lista imion występujących w rejestrze PESEL" and
 * "Nazwiska występujące w rejestrze PESEL", licence CC0 1.0).
 *
 * The register publishes first names and surnames as two separate lists, never as pairs. The number of
 * people bearing a given pair is therefore an estimate:
 *
 *     expected = bearers of the first name × bearers of the surname ÷ people of that gender in the register
 *
 * which assumes that first names and surnames are chosen independently of each other. That is close enough
 * to tell "thousands of people" from "a handful" from "probably one", and that is all it is used for.
 *
 * Limits of the source: names that occur once are left out of both lists, and so is everybody who has
 * no PESEL number. A surname that is not listed is NOT treated as rare — an invented name is not listed
 * either — so nothing is returned for it.
 */
export interface NameFrequency {
  /** The first name and surname as they were read from the text ("Sławomir", "Mentzen"). */
  first: string;
  last: string;
  /** Living people in the register with this first name (as a first given name), of the gender the name points to. */
  firstCount: number;
  /** Living people in the register with this surname, in the form used by that gender. */
  lastCount: number;
  /** Estimated number of people in Poland bearing both. Below 1 means: probably nobody else. */
  expected: number;
  /** Date of the register's statistics, e.g. "2026-01-20". */
  edition: string;
}

/** A first name must have at least this many bearers to be read as a first name (keeps out stray words and one-off foreign names). */
const MIN_FIRST = 50;
/** A display name longer than this many words is a sentence, not a name. */
const MAX_WORDS = 5;

interface Table {
  buf: Buffer;
  /** Byte offset of every line of the section. */
  starts: Uint32Array;
}

interface Data {
  edition: string;
  men: number;
  women: number;
  tables: Record<'F' | 'L' | 'f' | 'l', Table>;
}

let data: Data | undefined;

function load(): Data {
  if (data) return data;
  const buf = gunzipSync(readFileSync(new URL('../data/names-pl.txt.gz', import.meta.url)));
  const meta: Record<string, string> = {};
  const tables = {} as Data['tables'];
  let at = 0;
  while (at < buf.length) {
    const end = buf.indexOf(10, at);
    const line = buf.subarray(at, end).toString('utf8').split('\t');
    at = end + 1;
    if (line[0] !== '#section') {
      meta[line[0].slice(1)] = line[1];
      continue;
    }
    const starts = new Uint32Array(Number(line[2]));
    for (let i = 0; i < starts.length; i++) {
      starts[i] = at;
      at = buf.indexOf(10, at) + 1;
    }
    tables[line[1] as keyof Data['tables']] = { buf, starts };
  }
  data = { edition: meta.edition, men: Number(meta.men), women: Number(meta.women), tables };
  return data;
}

/** [men, women] for a key of one table, by binary search over the sorted lines. */
function counts(table: Table, key: string): [number, number] {
  const k = Buffer.from(key, 'utf8');
  let lo = 0;
  let hi = table.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = table.starts[mid];
    const tab = table.buf.indexOf(9, start);
    const c = k.compare(table.buf, start, tab);
    if (c === 0) {
      const [m, f] = table.buf.subarray(tab + 1, table.buf.indexOf(10, tab)).toString('latin1').split('\t');
      return [Number(m || 0), Number(f || 0)];
    }
    if (c < 0) hi = mid - 1;
    else lo = mid + 1;
  }
  return [0, 0];
}

const UNDECOMPOSED: Record<string, string> = { Ł: 'L', Ø: 'O', Đ: 'D', Ð: 'D', Þ: 'TH', Æ: 'AE', ẞ: 'SS', Ɖ: 'D', Ƚ: 'L', Ɠ: 'G', Œ: 'OE' };
/** "WIŚNIEWSKI" → "WISNIEWSKI": the form a name takes when typed without Polish (or other) diacritics. */
export const foldDiacritics = (upper: string): string =>
  upper.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ŁØĐÐÞÆẞƉȽƓŒ]/g, (c) => UNDECOMPOSED[c]);

/**
 * Bearers of a name. A name typed with diacritics is looked up as it stands. A name typed without any may be
 * the plain spelling of one that has them ("Wisniewski"), so every listed name that reads the same without
 * diacritics is counted in — the cautious reading, because it can only make the name look more common.
 */
function bearers(kind: 'F' | 'L', upper: string): [number, number] {
  const d = load();
  const exact = counts(d.tables[kind], upper);
  const folded = foldDiacritics(upper);
  if (folded !== upper) {
    if (exact[0] + exact[1] > 0) return exact;
    // Diacritics the register does not use for this name (e.g. "Kowalskí"): fall back to the plain spelling.
    const plain = counts(d.tables[kind], folded);
    const more = counts(d.tables[kind === 'F' ? 'f' : 'l'], folded);
    return [plain[0] + more[0], plain[1] + more[1]];
  }
  const more = counts(d.tables[kind === 'F' ? 'f' : 'l'], upper);
  return [exact[0] + more[0], exact[1] + more[1]];
}

/** Bearers of a surname as the register lists it; a double-barrelled one is tried with a hyphen and with a space, since the register has both spellings. */
function listedSurname(upper: string): [number, number] {
  const direct = bearers('L', upper);
  if (direct[0] + direct[1] > 0 || !/[- ]/.test(upper)) return direct;
  return bearers('L', upper.includes('-') ? upper.replace(/-/g, ' ') : upper.replace(/ /g, '-'));
}

/** Bearers of a surname, including a hyphenated one the register does not list as a whole. */
function surnameBearers(upper: string): [number, number] {
  const listed = listedSurname(upper);
  if (listed[0] + listed[1] > 0 || !upper.includes('-')) return listed;
  // Both halves are listed surnames but the combination is not: the register leaves out names borne by
  // one person only, so the combination has at most one bearer.
  const parts = upper.split('-').filter(Boolean);
  const known = parts.length === 2 && parts.every((p) => bearers('L', p).some((n) => n > 0));
  return known ? [1, 1] : [0, 0];
}

const titleCase = (word: string) => word.toLowerCase().replace(/(^|[- '])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());

/** Words of a display name: letters only, emoji and decoration dropped, "JanKowalski" split in two. */
function words(text: string): string[] {
  return text
    .normalize('NFC')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/[^\p{L}\p{M}'’-]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['’-]+|['’-]+$/g, ''))
    .filter((w) => w.length >= 2);
}

/**
 * Reads a first name and a surname out of a display name and estimates how many people in Poland bear both.
 * Handles either order ("Kowalski Jan"), second names, double-barrelled surnames, missing diacritics, and
 * decoration around the name. When a text can be read in more than one way, the reading with the most
 * bearers wins: it is the likeliest one, and it never overstates how rare the name is.
 *
 * Returns undefined when the text does not hold a Polish first name together with a surname the register lists.
 */
export function polishNameFrequency(fullName: string): NameFrequency | undefined {
  const tokens = words(fullName);
  if (tokens.length < 2 || tokens.length > MAX_WORDS) return undefined;
  const d = load();
  const upper = tokens.map((t) => t.toUpperCase());
  const asFirst = upper.map((u) => bearers('F', u));

  let best: NameFrequency | undefined;
  const consider = (firstAt: number, lastText: string, [lm, lf]: [number, number]) => {
    const [m, f] = asFirst[firstAt];
    const woman = f > m;
    const firstCount = woman ? f : m;
    if (firstCount < MIN_FIRST) return;
    // The form used by the other gender ("Anna Kowalski") is counted as that form is listed.
    const lastCount = (woman ? lf : lm) || (woman ? lm : lf);
    if (!lastCount) return;
    const expected = (firstCount * lastCount) / (woman ? d.women : d.men);
    if (!best || expected > best.expected) {
      best = { first: titleCase(tokens[firstAt]), last: titleCase(lastText), firstCount, lastCount, expected: Number(expected.toPrecision(3)), edition: d.edition };
    }
  };

  // A surname written as two words and listed as such ("Żmuda Trzebiatowski", "Nowak Kowalska") is read whole:
  // its halves are surnames too, but they are other people's.
  for (let j = 0; j + 1 < tokens.length; j++) {
    const listed = listedSurname(`${upper[j]} ${upper[j + 1]}`);
    if (listed[0] + listed[1] === 0) continue;
    for (let i = 0; i < tokens.length; i++) if (i !== j && i !== j + 1) consider(i, `${tokens[j]} ${tokens[j + 1]}`, listed);
  }
  if (best) return best;

  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) if (i !== j) consider(i, tokens[j], surnameBearers(upper[j]));
  }
  return best;
}

/** Edition and size of the bundled statistics, for the list of sources. */
export function polishNameStatistics(): { edition: string; firstNames: number; surnames: number; men: number; women: number } {
  const d = load();
  return { edition: d.edition, firstNames: d.tables.F.starts.length, surnames: d.tables.L.starts.length, men: d.men, women: d.women };
}

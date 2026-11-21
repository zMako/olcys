import type { Ruleset } from './ruleset';

const HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hourCycle: 'h23' });
/** Hour of the day in Poland for a UTC timestamp. */
export const warsawHour = (iso: string): number => Number(HOUR.format(new Date(iso))) % 24;

/** Events per hour of the day, Polish time. */
export const hourHistogram = (times: string[]): number[] => {
  const h = Array<number>(24).fill(0);
  for (const t of times) h[warsawHour(t)]++;
  return h;
};

export interface QuietWindow {
  /** First quiet hour and the hour activity resumes, 0–23 (the window may wrap past midnight). */
  from: number;
  to: number;
  hours: number;
  /** How many of the person's own web events fall inside it. */
  webInside: number;
}

/**
 * The daily rhythm of a person: when they publish on the web, and when transfers leave their addresses.
 * People keep regular hours; the part of the day when someone is never active is the most stable trait of all.
 * Transfers sent in those hours point at someone else holding the keys (or at automation) — a check against
 * attributing an address the person merely mentioned.
 */
export interface Rhythm {
  /** Dated posts, ads and repository updates per hour of the day (Polish time). */
  web: number[];
  /** Outgoing transfers from the person's addresses per hour of the day. */
  chain: number[];
  webCount: number;
  chainCount: number;
  quiet?: QuietWindow;
  chainInQuiet: number;
  /** Probability that someone with an unrelated rhythm would send this few transfers in the person's quiet hours. */
  chance?: number;
  verdict: 'consistent' | 'conflict' | 'unclear' | 'insufficient';
  note: string;
  /** Addresses whose own rhythm contradicts the person's; they are scored down and left out of the comparison. */
  conflicting: { chain: string; address: string; transfers: number; inQuiet: number; hours?: number[] }[];
}

/** The stretch of consecutive hours with the least activity; among equally quiet stretches, the middle one. */
export function quietWindow(hist: number[], hours: number): QuietWindow {
  const inside = (from: number) => {
    let n = 0;
    for (let i = 0; i < hours; i++) n += hist[(from + i) % 24];
    return n;
  };
  const counts = Array.from({ length: 24 }, (_, from) => inside(from));
  const min = Math.min(...counts);
  let best = { start: 0, length: 0 };
  if (counts.every((c) => c === min)) best = { start: 0, length: 1 };
  else {
    for (let s = 0; s < 24; s++) {
      if (counts[s] !== min || counts[(s + 23) % 24] === min) continue; // not the first start of a run
      let length = 1;
      while (counts[(s + length) % 24] === min) length++;
      if (length > best.length) best = { start: s, length };
    }
  }
  const from = (best.start + Math.floor((best.length - 1) / 2)) % 24;
  return { from, to: (from + hours) % 24, hours, webInside: min };
}

export const inWindow = (iso: string, q: QuietWindow): boolean => (warsawHour(iso) - q.from + 24) % 24 < q.hours;

/** P(X ≤ k) for X ~ Binomial(n, p). */
export function binomialAtMost(n: number, k: number, p: number): number {
  let term = Math.pow(1 - p, n); // i = 0
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    sum += term;
  }
  return Math.min(1, sum);
}

/** The person's quiet hours, if their dated web activity is plentiful and regular enough to tell. */
export function quietHoursOf(webTimes: string[], ruleset: Ruleset): { web: number[]; quiet?: QuietWindow; why?: string } {
  const web = hourHistogram(webTimes);
  if (webTimes.length < ruleset.rhythm.minWebEvents) return { web, why: `Za mało datowanych wpisów (${webTimes.length}), żeby ustalić rytm doby osoby.` };
  const quiet = quietWindow(web, ruleset.rhythm.quietHours);
  if (quiet.webInside / webTimes.length > ruleset.rhythm.maxWebInQuiet) return { web, why: 'Osoba publikuje o różnych porach doby; nie da się wskazać godzin, w których jest nieaktywna.' };
  return { web, quiet };
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
export const windowText = (q: QuietWindow) => `między ${hh(q.from)} a ${hh(q.to)} czasu polskiego`;
const percent = (p: number) => (p < 0.001 ? 'poniżej 0,1%' : `${(p * 100).toLocaleString('pl-PL', { maximumFractionDigits: 1 })}%`);

/** Compares when the person publishes with when transfers leave their addresses. */
export function compareRhythm(
  webTimes: string[],
  transferTimes: string[],
  conflicting: Rhythm['conflicting'],
  ruleset: Ruleset,
): Rhythm {
  const { web, quiet, why } = quietHoursOf(webTimes, ruleset);
  const base = { web, chain: hourHistogram(transferTimes), webCount: webTimes.length, chainCount: transferTimes.length, conflicting };
  if (!quiet) return { ...base, chainInQuiet: 0, verdict: 'insufficient', note: why! };
  const k = transferTimes.filter((t) => inWindow(t, quiet)).length;
  const n = transferTimes.length;
  const head = `Osoba nie publikuje w sieci ${windowText(quiet)}.`;
  const tail = conflicting.length ? ` Pominięto ${conflicting.length === 1 ? 'jeden adres' : `${conflicting.length} adresy`} o własnym, niezgodnym rytmie.` : '';
  if (n < ruleset.rhythm.minTransfers) {
    return { ...base, quiet, chainInQuiet: k, verdict: 'insufficient', note: `${head} Przelewów wychodzących jest za mało (${n}), żeby porównać rytm.${tail}` };
  }
  const chance = binomialAtMost(n, k, quiet.hours / 24);
  const count = k === 0 ? `żaden z ${n} przelewów wychodzących z jej adresów nie przypada` : `${k} z ${n} przelewów wychodzących z jej adresów przypada`;
  if (chance <= ruleset.rhythm.significance) {
    return {
      ...base, quiet, chainInQuiet: k, chance, verdict: 'consistent',
      note: `${head} Na te godziny ${count}. Gdyby adresami dysponował ktoś o innym rytmie doby, taki układ zdarzyłby się z prawdopodobieństwem ${percent(chance)}.${tail}`,
    };
  }
  if (k / n >= ruleset.rhythm.conflictShare) {
    return {
      ...base, quiet, chainInQuiet: k, chance, verdict: 'conflict',
      note: `${head} Na te godziny ${count}. Adresami może dysponować ktoś inny albo przelewy są zlecane automatycznie.${tail}`,
    };
  }
  return { ...base, quiet, chainInQuiet: k, chance, verdict: 'unclear', note: `${head} Na te godziny ${count}. To za mało, żeby uznać rytm za zgodny albo niezgodny.${tail}` };
}

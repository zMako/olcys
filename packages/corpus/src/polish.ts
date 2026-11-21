/**
 * Is this account Polish? Decided from what the account itself shows: its stated location, the language of its
 * description and posts, a flag, a .pl website. Each sign adds weight; the reasons are kept, so the decision can be read.
 */
export interface PolishSignals {
  /** 0–1. From 0.5 the account is treated as Polish. */
  score: number;
  reasons: string[];
}

const PLACE = /\b(pol(and|ska|sce|en|ogne|onia)|polsk\w*|warsaw|warszaw\w*|krak[oó]w\w*|cracow|wroc[lł]aw\w*|gda[nń]sk\w*|gdynia|pozna[nń]\w*|[lł][oó]d[zź]|katowic\w*|lublin\w*|szczecin\w*|bydgoszcz\w*|bia[lł]ystok\w*|rzesz[oó]w\w*|toru[nń]\w*|opole|kielce|olsztyn\w*|gliwice|zakopane|tr[oó]jmiasto|[sś]l[aą]sk\w*|mazowsze|ma[lł]opolsk\w*)\b/i;
const FLAG = /🇵🇱/u;

/** True when a text names Poland, a Polish city or region, or carries the flag. */
export const mentionsPoland = (text: string): boolean => PLACE.test(text) || FLAG.test(text) || /\bPolish\b/.test(text); // the nationality is capitalised; nail polish is not

/** Words that are Polish and nothing else. Short words shared with other languages ("to", "do", "no", "na") are left out on purpose. */
const WORDS = new Set([
  'się', 'sie', 'nie', 'jest', 'że', 'jak', 'ale', 'czy', 'dla', 'już', 'juz', 'tylko', 'bardzo', 'może', 'moze', 'będzie', 'bedzie', 'mnie', 'jestem',
  'dzień', 'dzien', 'dobry', 'dzięki', 'dzieki', 'cześć', 'czesc', 'oraz', 'przez', 'który', 'ktory', 'która', 'które', 'tego', 'też', 'tez', 'gdzie', 'kiedy',
  'dlaczego', 'wszystko', 'wszystkim', 'trochę', 'troche', 'teraz', 'jeszcze', 'właśnie', 'wlasnie', 'czyli', 'można', 'mozna', 'trzeba', 'będę', 'był', 'była',
  'było', 'bylo', 'są', 'jego', 'ktoś', 'ktos', 'coś', 'pozdrawiam', 'witam', 'siema', 'kupić', 'sprzedać', 'sprzedam', 'kupię', 'ludzie',
  'świat', 'życie', 'zycie', 'praca', 'pieniądze', 'polska', 'polsce', 'polski', 'polskie', 'polskiego', 'polaków', 'polacy', 'jutro', 'dzisiaj', 'dziś', 'wczoraj',
  'zawsze', 'nigdy', 'chyba', 'pewnie', 'dobrze', 'fajnie', 'fajny', 'więcej', 'wiecej', 'mniej', 'każdy', 'kazdy', 'moje',
  'mój', 'moja', 'twój', 'nasz', 'nasze', 'wasz', 'tutaj', 'potem', 'przed', 'bez', 'albo', 'więc', 'wiec', 'jeśli',
  'jesli', 'żeby', 'zeby', 'gdy', 'przy', 'około', 'okolo', 'około', 'miłośnik', 'entuzjasta', 'inwestor', 'programista', 'kryptowaluty', 'kryptowalut', 'krypto',
]);
const DIACRITICS = /[ąęłńśźż]/i;

/** Share of a text's words that are distinctly Polish (0–1), with the number of words it was judged on. */
export function polishShare(text: string): { share: number; words: number } {
  const tokens = text.toLowerCase().match(/[\p{L}]{2,}/gu) ?? [];
  if (!tokens.length) return { share: 0, words: 0 };
  let hits = 0;
  for (const t of tokens) if (WORDS.has(t) || DIACRITICS.test(t)) hits++;
  return { share: hits / tokens.length, words: tokens.length };
}

/** Polish when at least a fifth of the words are distinctly Polish — and at least two of them, so one stray word decides nothing. */
export const isPolishText = (text: string, minWords = 4): boolean => {
  const { share, words } = polishShare(text);
  return words >= minWords && share >= 0.2 && share * words >= 2;
};

export function polishSignals(a: { location?: string; bio?: string; name?: string; url?: string; texts?: string[] }): PolishSignals {
  const reasons: string[] = [];
  let score = 0;
  if (a.location && (PLACE.test(a.location) || FLAG.test(a.location))) {
    score += 0.6;
    reasons.push(`podana lokalizacja: ${a.location}`);
  }
  if (a.bio && isPolishText(a.bio)) {
    score += 0.5;
    reasons.push('opis konta po polsku');
  } else if (a.bio && PLACE.test(a.bio)) {
    score += 0.3;
    reasons.push('opis konta wymienia Polskę lub polskie miasto');
  }
  if (FLAG.test(`${a.name ?? ''} ${a.bio ?? ''}`)) {
    score += 0.4;
    reasons.push('polska flaga w nazwie lub opisie');
  }
  if (a.url && /\.pl(\/|$)/i.test(a.url.replace(/^https?:\/\//, '').split(/[?#]/)[0])) {
    score += 0.3;
    reasons.push(`strona w domenie .pl: ${a.url}`);
  }
  const texts = (a.texts ?? []).filter((t) => (t.match(/[\p{L}]{2,}/gu) ?? []).length >= 4);
  if (texts.length >= 3) {
    const polish = texts.filter((t) => isPolishText(t)).length;
    if (polish / texts.length >= 0.3) {
      score += 0.6;
      reasons.push(`${polish} z ${texts.length} wpisów po polsku`);
    }
  }
  return { score: Math.min(1, Math.round(score * 100) / 100), reasons };
}

/**
 * Posts that an app wrote for its user ("I just minted…", "Claim yours 👇") or that many accounts repeat word for word.
 * They say nothing in the person's own words, and there are a great many of them, so they are set aside first —
 * by three independent signs: the same opening shared by several authors, the same opening repeated by one author,
 * and the phrasing apps use to recruit the reader.
 */

/** The opening of a post with everything variable removed: numbers, token symbols, links, mentions. */
export function templateSignature(text: string, words = 4): string | undefined {
  const t = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/@[\w.-]+/g, ' ').replace(/\$[a-z][a-z0-9]*/g, '$t').replace(/[\d.,]+/g, '#');
  const w = t.match(/[\p{L}$#]+/gu) ?? [];
  return w.length >= words ? w.slice(0, words).join(' ') : undefined;
}

const SHARE = [
  /^\W{0,6}i(?:'m| am)? just (?:minted|claimed|won|staked|pulled|collected|earned|opened|joined|completed|boosted|got my|became)\b/i,
  /^\W{0,6}just (?:minted|claimed|earned|became|got farpoints|cashed out)\b/i,
  /^\W{0,6}(?:Minted|Collected|Bought|Claimed|Earned|Airdropped:?) [^.!?\n]{2,90}$/, // "Minted Genesis Origin": a marketplace posting on the user's behalf
  /^\W{0,6}claiming my\b/i,
  /^\W{0,6}check out my\b/i,
  /\b(?:claim yours|mint yours|claim your|mint your own|join with my link|try your luck|check your (?:scores?|stats)|stake your|come claim|get your .{1,30} too|can you beat me|want to win|be part of|join the|my ref)\b/i,
  /\b(?:bonus alert|spin-to-claim|daily (?:reward|drip)|paid to engage)\b/i,
  /^\W{0,6}success! i just\b/i,
];

/** True when the wording alone shows an app posted this for the user. */
export const looksAppGenerated = (text: string): boolean => SHARE.some((r) => r.test(text.trim()));

export interface AuthoredPost {
  author: string;
  text: string;
}

/**
 * Openings that are templates in a set of posts: shared by at least `minAuthors` different authors,
 * or used at least `minRepeats` times by one author.
 */
export function findTemplates(posts: AuthoredPost[], opts: { minAuthors?: number; minRepeats?: number } = {}): Set<string> {
  const authors = new Map<string, Map<string, number>>();
  for (const p of posts) {
    const s = templateSignature(p.text);
    if (!s) continue;
    const by = authors.get(s) ?? new Map<string, number>();
    by.set(p.author, (by.get(p.author) ?? 0) + 1);
    authors.set(s, by);
  }
  const out = new Set<string>();
  for (const [s, by] of authors) {
    if (by.size >= (opts.minAuthors ?? 3) || Math.max(...by.values()) >= (opts.minRepeats ?? 3)) out.add(s);
  }
  return out;
}

/** Decides for each post whether it is the person's own words. `known` are template openings learned from a larger corpus. */
export function ownWords<T extends AuthoredPost>(posts: T[], known: ReadonlySet<string> = new Set()): { own: T[]; generated: T[] } {
  const local = findTemplates(posts);
  const own: T[] = [];
  const generated: T[] = [];
  for (const p of posts) {
    const s = templateSignature(p.text);
    (looksAppGenerated(p.text) || (s && (local.has(s) || known.has(s))) ? generated : own).push(p);
  }
  return { own, generated };
}

import { parseAddress } from '@olcys/core';

/** A crypto address found on a page of the corpus, with the words around it. */
export interface CorpusMention {
  chain: string;
  address: string;
  /** 'valid' when the address carries a checksum that holds; 'absent' for lower-case Ethereum addresses, which have none. */
  checksum: string;
  /** Text around the address, for reading what the page says about it. */
  context: string;
}

export interface PageHit {
  url: string;
  host: string;
  /** Languages detected by the crawler, most likely first, e.g. ["pol", "eng"]. */
  languages: string[];
  /** How many address occurrences the page has in all; `mentions` keeps at most `MAX_MENTIONS` distinct ones. */
  occurrences: number;
  mentions: CorpusMention[];
}

export const MAX_MENTIONS = 40;
const CONTEXT = 220;

/**
 * Anything shaped like a Bitcoin, Ethereum or Tron address. This is deliberately loose and very fast:
 * it throws away almost every page of the web in one pass, and the checksum then throws away almost
 * every remaining candidate. Addresses hidden by splitting or look-alike letters are not caught here;
 * the full extractor runs on pages of the domains this pass selects.
 */
const CANDIDATE = /(?<![A-Za-z0-9])(?:bc1[ac-hj-np-z02-9]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|0x[0-9a-fA-F]{40}|T[1-9A-HJ-NP-Za-km-z]{33})(?![A-Za-z0-9])/g;

const clean = (s: string) => s.replace(/�/g, '').replace(/\s+/g, ' ').trim();

/**
 * Finds checksum-valid addresses in the raw bytes of a page's text.
 * Works on bytes so that pages without a candidate cost one regular-expression pass and nothing else.
 */
export function scanPage(body: Buffer): { occurrences: number; mentions: CorpusMention[] } {
  // Addresses are plain ASCII, so a byte-per-character view is enough to find them and keeps offsets exact.
  const view = body.toString('latin1');
  const mentions: CorpusMention[] = [];
  const seen = new Set<string>();
  let occurrences = 0;
  CANDIDATE.lastIndex = 0;
  for (let m = CANDIDATE.exec(view); m; m = CANDIDATE.exec(view)) {
    const parsed = parseAddress(m[0]);
    if (!parsed) continue;
    occurrences++;
    if (seen.has(parsed.address) || mentions.length >= MAX_MENTIONS) continue;
    seen.add(parsed.address);
    const from = Math.max(0, m.index - CONTEXT);
    const to = Math.min(body.length, m.index + m[0].length + CONTEXT);
    mentions.push({ chain: parsed.chain, address: parsed.address, checksum: parsed.checksum, context: clean(body.subarray(from, to).toString('utf8')) });
  }
  return { occurrences, mentions };
}

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

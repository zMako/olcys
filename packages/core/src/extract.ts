import { defaultCodecs } from './chains';
import type { AddressCodec, Chain, ChecksumStatus, ParsedAddress } from './chains';

/** 'qr' and 'ens' are set by the engine: an address read from a code in an image, or resolved from a name given in the text. */
export type ExtractionMethod = 'plain' | 'deobfuscated' | 'joined' | 'qr' | 'ens';
export type Obfuscation = 'zero-width' | 'homoglyph' | 'compat-form' | 'split';

export interface AddressMention {
  chain: Chain;
  /** Canonical address. */
  address: string;
  addressType: string;
  checksum: ChecksumStatus;
  /** Exactly what stood in the source text. */
  raw: string;
  /** UTF-16 offsets into the original text. */
  start: number;
  end: number;
  method: ExtractionMethod;
  obfuscation: Obfuscation[];
  /** Surrounding text, for the analyst and for later context rules. */
  context: string;
}

const ZERO_WIDTH = /[­᠎​-‏‪-‮⁠-⁤﻿]/;

/** Letters from other scripts that render like Latin ones; used to hide addresses from simple filters. */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', Ј: 'J', Ѕ: 'S',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
  ο: 'o', ν: 'v', ρ: 'p',
};

interface Cleaned {
  text: string;
  /** For every char of `text`: offset of its source char in the original, and that source char's length. */
  origStart: number[];
  origLen: number[];
  /** Why the char differs from the original, if it does. */
  altered: (Obfuscation | undefined)[];
  /** Original offsets of removed zero-width characters. */
  removed: number[];
}

function clean(text: string): Cleaned {
  const out: Cleaned = { text: '', origStart: [], origLen: [], altered: [], removed: [] };
  let chars = '';
  let i = 0;
  for (const cp of text) {
    const len = cp.length;
    if (ZERO_WIDTH.test(cp)) {
      out.removed.push(i);
      i += len;
      continue;
    }
    let mapped = cp;
    let why: Obfuscation | undefined;
    if (HOMOGLYPHS[cp]) {
      mapped = HOMOGLYPHS[cp];
      why = 'homoglyph';
    } else if (cp.charCodeAt(0) > 0x7f) {
      const nfkc = cp.normalize('NFKC');
      if (nfkc !== cp && /^[A-Za-z0-9]+$/.test(nfkc)) {
        mapped = nfkc;
        why = 'compat-form';
      }
    }
    for (const ch of mapped) {
      chars += ch;
      for (let k = 0; k < ch.length; k++) {
        out.origStart.push(i);
        out.origLen.push(len);
        out.altered.push(why);
      }
    }
    i += len;
  }
  out.text = chars;
  return out;
}

interface Run {
  text: string;
  start: number;
  end: number;
}

function alnumRuns(text: string): Run[] {
  const runs: Run[] = [];
  const re = /[A-Za-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) runs.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return runs;
}

function parseWith(codecs: AddressCodec[], s: string): ParsedAddress | null {
  if (s.length < 14 || s.length > 90) return null;
  for (const c of codecs) {
    const p = c.parse(s);
    if (p) return p;
  }
  return null;
}

function contextOf(text: string, start: number, end: number, radius = 90): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return ((from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '')).replace(/\s+/g, ' ').trim();
}

/**
 * Finds every valid crypto address in a piece of text.
 *
 * Three passes, each only adding what the previous ones missed:
 *  1. plain        — contiguous addresses as written;
 *  2. deobfuscated — after removing invisible characters and mapping look-alike letters to Latin;
 *  3. joined       — addresses split into chunks by spaces, dashes or line breaks.
 *
 * Every candidate must pass the chain's own checksum, so random strings and typos are rejected.
 * The only checksum-free form (single-case EVM hex) is reported with checksum = 'absent'.
 */
export function extractAddresses(text: string, codecs: AddressCodec[] = defaultCodecs): AddressMention[] {
  const found: AddressMention[] = [];
  const overlaps = (s: number, e: number) => found.some((f) => s < f.end && e > f.start);
  const add = (p: ParsedAddress, start: number, end: number, method: ExtractionMethod, obfuscation: Obfuscation[]) => {
    if (overlaps(start, end)) return;
    found.push({
      chain: p.chain,
      address: p.address,
      addressType: p.type,
      checksum: p.checksum,
      raw: text.slice(start, end),
      start,
      end,
      method,
      obfuscation,
      context: contextOf(text, start, end),
    });
  };

  // Pass 1: plain.
  for (const run of alnumRuns(text)) {
    const p = parseWith(codecs, run.text);
    if (p) add(p, run.start, run.end, 'plain', []);
  }

  const c = clean(text);
  const toOrig = (s: number, e: number): [number, number] => [c.origStart[s], c.origStart[e - 1] + c.origLen[e - 1]];
  const tagsFor = (s: number, e: number, os: number, oe: number): Obfuscation[] => {
    const tags = new Set<Obfuscation>();
    for (let k = s; k < e; k++) if (c.altered[k]) tags.add(c.altered[k]!);
    if (c.removed.some((r) => r > os && r < oe)) tags.add('zero-width');
    return [...tags];
  };
  const runs = alnumRuns(c.text);

  // Pass 2: same scan on the cleaned text.
  for (const run of runs) {
    const p = parseWith(codecs, run.text);
    if (!p) continue;
    const [os, oe] = toOrig(run.start, run.end);
    add(p, os, oe, 'deobfuscated', tagsFor(run.start, run.end, os, oe));
  }

  // Pass 3: chunks separated by up to three non-alphanumeric characters.
  const joinable = (a: Run, b: Run) => {
    const gap = b.start - a.end;
    return gap >= 1 && gap <= 3;
  };
  for (let i = 0; i < runs.length; i++) {
    for (const codec of codecs) {
      const j0 = codec.join;
      if (!j0.canStart(runs[i].text) || !j0.tokenOk(runs[i].text)) continue;
      let acc = runs[i].text;
      for (let j = i + 1; j < runs.length; j++) {
        if (!joinable(runs[j - 1], runs[j]) || !j0.tokenOk(runs[j].text)) break;
        acc += runs[j].text;
        if (acc.length > j0.maxLength) break;
        if (acc.length < j0.minLength) continue;
        const p = codec.parse(acc);
        if (!p) continue;
        // Without a checksum we only trust the join if the chunk sequence ends here
        // (otherwise it may be the head of a longer hex string such as a transaction hash).
        const next = runs[j + 1];
        if (p.checksum === 'absent' && next && joinable(runs[j], next) && j0.tokenOk(next.text)) break;
        const [os, oe] = toOrig(runs[i].start, runs[j].end);
        const tags = new Set<Obfuscation>(['split', ...tagsFor(runs[i].start, runs[j].end, os, oe)]);
        add(p, os, oe, 'joined', [...tags]);
        break;
      }
    }
  }

  return found.sort((a, b) => a.start - b.start);
}

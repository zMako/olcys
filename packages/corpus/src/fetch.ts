import { gunzipSync } from 'node:zlib';
import { CC_DATA, ccFetch } from './cc';
import type { PagePointer } from './listing';
import { hostOf } from './scan';

/** One page exactly as the crawler stored it, with its readable text and the links it carries. */
export interface ArchivedPage {
  url: string;
  status: number;
  html: string;
  /** Visible text: scripts and markup removed, entities decoded. */
  text: string;
  /** Other hosts this page links to — how the search spreads to sites nobody named. */
  linkedHosts: string[];
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', bdquo: '„', rdquo: '”', ldquo: '“',
  oacute: 'ó', Oacute: 'Ó', copy: '©', reg: '®', euro: '€', middot: '·', bull: '•',
};

/** Markup to text, good enough to read sentences around an address. Not a browser: no layout, no scripts. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|article|section|td|th)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The character set a page declares, from its HTTP header or its first meta tag. Old Polish forums are rarely UTF-8. */
export function charsetOf(headers: string, head: string): string {
  const m = headers.match(/content-type:[^\r\n]*charset=["']?([\w-]+)/i) ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  const name = (m?.[1] ?? 'utf-8').toLowerCase();
  try {
    new TextDecoder(name);
    return name;
  } catch {
    return 'utf-8';
  }
}

export function linkedHostsOf(html: string, own: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']?(https?:\/\/[^"'\s>]+)/gi)) {
    const host = hostOf(m[1]);
    if (host && host !== own && !host.endsWith(`.${own}`)) out.add(host);
  }
  return [...out];
}

/** Splits a stored crawl record into the HTTP answer's headers and body. */
export function parseArchivedResponse(record: Buffer): { status: number; headers: string; body: Buffer } | undefined {
  const warcEnd = record.indexOf('\r\n\r\n');
  if (warcEnd < 0 || !/WARC-Type:\s*response/i.test(record.subarray(0, warcEnd).toString('latin1'))) return undefined;
  const http = record.subarray(warcEnd + 4);
  const httpEnd = http.indexOf('\r\n\r\n');
  if (httpEnd < 0) return undefined;
  const headers = http.subarray(0, httpEnd).toString('latin1');
  const status = Number(headers.match(/^HTTP\/[\d.]+\s+(\d{3})/)?.[1] ?? 0);
  return { status, headers, body: http.subarray(httpEnd + 4) };
}

/** Fetches a single page from the archive by its pointer: one small ranged download. */
export async function fetchArchived(p: Pick<PagePointer, 'url' | 'filename' | 'offset' | 'length'>): Promise<ArchivedPage | undefined> {
  const res = await ccFetch(`${CC_DATA}/${p.filename}`, { range: [p.offset, p.offset + p.length - 1] });
  const parsed = parseArchivedResponse(gunzipSync(Buffer.from(await res.arrayBuffer())));
  if (!parsed || parsed.status !== 200) return undefined;
  const charset = charsetOf(parsed.headers, parsed.body.subarray(0, 2048).toString('latin1'));
  const html = new TextDecoder(charset).decode(parsed.body);
  return { url: p.url, status: parsed.status, html, text: htmlToText(html), linkedHosts: linkedHostsOf(html, hostOf(p.url) ?? '') };
}

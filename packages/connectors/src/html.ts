import * as cheerio from 'cheerio';
import type { Segment } from '@olcys/core';

export type Dom = cheerio.CheerioAPI;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sel = cheerio.Cheerio<any>;

export const parseHtml = (html: string): Dom => cheerio.load(html);

/** Visible text of an element with line breaks preserved. */
export function textOf(el: Sel): string {
  const c = el.clone();
  // In HTML a line break in the source is just a space; only <br> and block ends are real breaks.
  c.find('*').addBack().contents().each((_, node) => {
    if (node.type === 'text') node.data = node.data.replace(/\s*\n\s*/g, ' ');
  });
  c.find('br').replaceWith('\n');
  c.find('p, div, li, h1, h2, h3, cite').append('\n');
  return c
    .text()
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Link targets inside an element. An address is often only in the URL
 * ("my wallet" linking to an explorer), so each target becomes its own segment.
 */
export function linkSegments($: Dom, el: Sel): Segment[] {
  const out: Segment[] = [];
  el.find('a[href]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    if (/^(https?:|bitcoin:|ethereum:|tron:)/i.test(href)) out.push({ kind: 'link', text: href });
  });
  return out;
}

export const absolute = (base: string, href: string) => new URL(href, base + '/').toString();

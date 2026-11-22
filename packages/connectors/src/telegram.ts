import { makeIdentifier, type Identifier, type Segment, type SourceConnector, type SourceItem } from '@olcys/core';
import { parseHtml } from './html';

export interface TelegramPreview {
  /** The name shown on the page: a person's first and last name, or the title of a channel or group. */
  name: string;
  /** The "about" text, if the owner wrote one. */
  description?: string;
  kind: 'account' | 'channel' | 'group';
  /** Links the owner put in the description. */
  links: string[];
  verified: boolean;
}

/**
 * Reads Telegram's public preview page of a handle (t.me/<handle>). The page of a handle nobody has looks the
 * same except that it carries no name; that case returns nothing.
 */
export function parseTelegramPreview(html: string): TelegramPreview | undefined {
  const $ = parseHtml(html);
  const title = $('.tgme_page_title').first();
  const name = title.find('span').first().text().trim() || title.clone().children('i').remove().end().text().trim();
  if (!name) return undefined;
  const about = $('.tgme_page_description').first();
  about.find('br').replaceWith('\n');
  const description = about.text().replace(/[ \t]+\n/g, '\n').trim() || undefined;
  const extra = $('.tgme_page_extra').map((_, el) => $(el).text().trim()).get().join(' | ').toLowerCase();
  const kind = /\bsubscribers?\b/.test(extra) ? 'channel' : /\bmembers?\b/.test(extra) ? 'group' : 'account';
  const links = [...new Set(about.find('a[href]').map((_, el) => String($(el).attr('href'))).get().filter((h) => /^https?:\/\//i.test(h)))].slice(0, 6);
  return { name, description, kind, links, verified: title.find('.verified-icon').length > 0 };
}

/**
 * Telegram, for one handle: the public preview page, which shows the name and the "about" text the owner chose
 * to make public. No messages are read and nothing behind a login is touched.
 */
export function createTelegramConnector(opts: { site?: string } = {}): SourceConnector {
  const site = (opts.site ?? 'https://t.me').replace(/\/+$/, '');
  const handleOf = (id: Identifier): string | undefined => {
    if (id.kind === 'username' || id.kind === 'messenger_id') return /^[a-z][a-z0-9_]{3,31}$/.test(id.normalized) ? id.normalized : undefined;
    if (id.kind !== 'profile_url') return undefined;
    try {
      const u = new URL(id.value);
      const first = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
      // "/s/…" is a channel's message preview, "/+…" and "/joinchat" are invitations: none of them is a handle.
      return /^(www\.)?(t\.me|telegram\.me)$/i.test(u.hostname) && first && /^[a-z][a-z0-9_]{3,31}$/.test(first) && first !== 'joinchat' ? first : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    id: 'telegram',
    descriptor: { name: 'Telegram (publiczna strona profilu)', kind: 'messenger', origin: 'telegram', hosts: [new URL(site).host], synthetic: false },
    supports: (id) => !!handleOf(id),
    async *search(id, ctx): AsyncGenerator<SourceItem> {
      const handle = handleOf(id);
      if (!handle) return;
      const res = await ctx.fetch(`${site}/${handle}`);
      if (res.status !== 200) return;
      const page = parseTelegramPreview(res.body);
      if (!page) return;
      const url = `https://t.me/${handle}`;
      const segments: Segment[] = [];
      if (page.description) segments.push({ kind: 'bio', text: page.description });
      for (const link of page.links) if (!page.description?.includes(link)) segments.push({ kind: 'link', text: link });
      const discovered: Identifier[] = page.links.map((l) => makeIdentifier('profile_url', l));
      yield {
        snapshotId: res.snapshotId, url, resourceId: `handle:${handle}`, docType: 'profile', title: handle,
        author: { handle, displayName: page.name, profileUrl: url },
        // A channel or a group under the same handle is a page run by the handle's owner, not a person's own profile.
        container: { kind: page.kind === 'account' ? 'profile' : page.kind }, relation: 'profile_owner', segments, discovered,
      };
    },
  };
}

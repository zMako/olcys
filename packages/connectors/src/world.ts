import {
  avatarFingerprint, extractAddresses, makeIdentifier, normalizeIdentifier, sshKeyFingerprint,
  type ConnectorContext, type Fingerprint, type Identifier, type Relation, type Segment, type SourceConnector, type SourceItem,
} from '@olcys/core';
import { linkSegments, parseHtml, textOf } from './html';

export interface WorldUrls {
  forum: string;
  code: string;
  ads: string;
}

const hostOf = (base: string) => new URL(base).host;
const search = (base: string, q: string) => `${base}/szukaj?q=${encodeURIComponent(q)}`;
const sameUser = (a: string, b: string) => normalizeIdentifier('username', a) === normalizeIdentifier('username', b);
const sameName = (a: string, b: string) => normalizeIdentifier('full_name', a) === normalizeIdentifier('full_name', b);

/** Nicks the site's own search returns for a nick, other than that nick itself. */
async function otherHandles(ctx: ConnectorContext, base: string, id: Identifier, selector: string): Promise<string[]> {
  if (id.kind !== 'username') return [];
  const res = await ctx.fetch(search(base, id.value));
  if (res.status !== 200) return [];
  const $ = parseHtml(res.body);
  return [...new Set($(selector).toArray().map((a) => $(a).text().trim()))].filter((h) => h && !sameUser(h, id.value));
}

/** Path of a profile URL if it belongs to this site, e.g. "/uzytkownik/abc" → ["uzytkownik", "abc"]. */
function pathOn(base: string, id: Identifier): string[] | null {
  if (id.kind !== 'profile_url') return null;
  try {
    const u = new URL(id.value);
    if (u.host !== hostOf(base)) return null;
    return u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------- forum

export function createForumConnector(base: string): SourceConnector {
  async function* threadPosts(ctx: ConnectorContext, threadId: string, wanted: Set<string>, relation: Relation): AsyncGenerator<SourceItem> {
    const res = await ctx.fetch(`${base}/watek/${threadId}`);
    if (res.status !== 200) return;
    const $ = parseHtml(res.body);
    const container = {
      kind: 'thread',
      id: threadId,
      title: $('h1.thread-title').text().trim(),
      section: $('.board-name').text().trim(),
      url: `${base}/watek/${threadId}`,
      // Raw facts for the "mass comments" rule: how many posts in the thread carry an address.
      stats: {
        posts: $('article.post').length,
        postsWithAddress: $('article.post').toArray().filter((el) => extractAddresses(textOf($(el).find('.post-body'))).length > 0).length,
      },
    };
    for (const el of $('article.post').toArray()) {
      const post = $(el);
      const id = post.attr('data-post-id')!;
      if (!wanted.has(id)) continue;
      const handle = post.find('a.author').text().trim();
      const segments: Segment[] = [];
      post.find('blockquote').each((_, q) => {
        segments.push({ kind: 'quote', text: textOf($(q).find('p')), quotedAuthor: $(q).attr('data-author') });
      });
      const body = post.find('.post-body');
      segments.push({ kind: 'body', text: textOf(body) }, ...linkSegments($, body));
      yield {
        snapshotId: res.snapshotId,
        url: `${base}/watek/${threadId}#post-${id}`,
        resourceId: `post:${id}`,
        docType: 'post',
        title: container.title,
        author: { handle, profileUrl: `${base}/uzytkownik/${handle}` },
        publishedAt: post.find('time').attr('datetime'),
        container,
        relation,
        segments,
        discovered: [],
      };
    }
  }

  async function* profile(ctx: ConnectorContext, handle: string, relation: Relation): AsyncGenerator<SourceItem> {
    const url = `${base}/uzytkownik/${encodeURIComponent(handle)}`;
    const res = await ctx.fetch(url);
    if (res.status !== 200) return;
    const $ = parseHtml(res.body);
    const displayName = $('.profile .display-name').text().trim() || undefined;
    const website = $('.profile a.website').attr('href');
    const signature = $('.profile .signature');
    const segments: Segment[] = [];
    if (signature.length) segments.push({ kind: 'signature', text: textOf(signature) });
    if (website) segments.push({ kind: 'link', text: website });
    const discovered: Identifier[] = [];
    if (website) discovered.push(makeIdentifier('profile_url', website));
    if (displayName) discovered.push(makeIdentifier('full_name', displayName));
    yield {
      snapshotId: res.snapshotId,
      url,
      resourceId: `user:${handle}`,
      docType: 'profile',
      title: handle,
      author: { handle, displayName, profileUrl: url },
      publishedAt: $('.profile time.joined').attr('datetime'),
      container: { kind: 'profile', section: $('.profile .location').text().trim() || undefined },
      relation,
      segments,
      discovered,
    };
    if (relation === 'mention') return;
    // Everything the account wrote, thread by thread.
    const byThread = new Map<string, Set<string>>();
    $('ul.user-posts a').each((_, a) => {
      const m = ($(a).attr('href') ?? '').match(/\/watek\/(\d+)#post-(\d+)/);
      if (m) byThread.set(m[1], (byThread.get(m[1]) ?? new Set()).add(m[2]));
    });
    for (const [threadId, ids] of byThread) yield* threadPosts(ctx, threadId, ids, 'author');
  }

  return {
    id: 'world-forum',
    descriptor: { name: 'BitRozmowy (forum, środowisko testowe)', kind: 'forum', origin: 'bitrozmowy', hosts: [hostOf(base)], synthetic: true },
    supports: (id) => ['username', 'full_name', 'crypto_address'].includes(id.kind) || pathOn(base, id)?.[0] === 'uzytkownik',
    async *search(id, ctx) {
      const path = pathOn(base, id);
      if (path) {
        if (path[1]) yield* profile(ctx, path[1], 'profile_owner');
        return;
      }
      const res = await ctx.fetch(search(base, id.value));
      if (res.status !== 200) return;
      const $ = parseHtml(res.body);
      for (const el of $('li.result-user').toArray()) {
        const handle = $(el).find('a').text().trim();
        const name = $(el).find('.display-name').text().trim();
        if (id.kind === 'username' && sameUser(handle, id.value)) yield* profile(ctx, handle, 'profile_owner');
        else if (id.kind === 'full_name' && name && sameName(name, id.value)) yield* profile(ctx, handle, 'profile_owner');
        else if (id.kind === 'crypto_address') yield* profile(ctx, handle, 'mention');
      }
      if (id.kind !== 'crypto_address') return;
      const byThread = new Map<string, Set<string>>();
      $('li.result-post a').each((_, a) => {
        const m = ($(a).attr('href') ?? '').match(/\/watek\/(\d+)#post-(\d+)/);
        if (m) byThread.set(m[1], (byThread.get(m[1]) ?? new Set()).add(m[2]));
      });
      for (const [threadId, ids] of byThread) yield* threadPosts(ctx, threadId, ids, 'mention');
    },
    enumerate: (id, ctx) => otherHandles(ctx, base, id, 'li.result-user a'),
  };
}

// ----------------------------------------------------------------------------- code hosting

export function createCodeConnector(base: string): SourceConnector {
  async function* repo(ctx: ConnectorContext, path: string, relation: Relation): AsyncGenerator<SourceItem> {
    const url = `${base}${path}`;
    const res = await ctx.fetch(url);
    if (res.status !== 200) return;
    const $ = parseHtml(res.body);
    const owner = $('a.owner').text().trim();
    const name = $('.repo-name').text().trim();
    yield {
      snapshotId: res.snapshotId,
      url,
      resourceId: `repo:${owner}/${name}`,
      docType: 'repo',
      title: `${owner}/${name}`,
      author: { handle: owner, profileUrl: `${base}/${owner}` },
      publishedAt: $('time.updated').attr('datetime'),
      container: { kind: 'repository', id: `${owner}/${name}`, title: $('.description').text().trim() },
      relation,
      segments: [{ kind: 'readme', text: $('pre.readme').text() }],
      discovered: [],
    };
  }

  async function* profile(ctx: ConnectorContext, handle: string, relation: Relation, mustHaveEmail?: string): AsyncGenerator<SourceItem> {
    const url = `${base}/${encodeURIComponent(handle)}`;
    const res = await ctx.fetch(url);
    if (res.status !== 200) return;
    const $ = parseHtml(res.body);
    const name = $('.profile .name').text().trim() || undefined;
    const email = $('.profile a.email').text().trim() || undefined;
    if (mustHaveEmail && email?.toLowerCase() !== mustHaveEmail) return;
    const readme = $('section.readme');
    const segments: Segment[] = [{ kind: 'bio', text: $('.profile .bio').text().trim() }];
    if (email) segments.push({ kind: 'contact', text: email });
    segments.push({ kind: 'readme', text: textOf(readme) }, ...linkSegments($, readme));
    const discovered: Identifier[] = [];
    if (email) discovered.push(makeIdentifier('email', email));
    if (name) discovered.push(makeIdentifier('full_name', name));
    $('.profile ul.links a').each((_, a) => {
      const href = $(a).attr('href');
      if (href) discovered.push(makeIdentifier('profile_url', href));
    });
    // What the profile gives away without saying it: the e-mail hash in the avatar address, and the public keys.
    const fingerprints: Fingerprint[] = [];
    const avatar = avatarFingerprint($('.profile img.avatar').attr('src'));
    if (avatar) fingerprints.push({ ...avatar, sourceUrl: url });
    if (relation !== 'mention') {
      const keys = await ctx.fetch(`${url}.keys`);
      if (keys.status === 200) {
        for (const line of keys.body.split('\n')) {
          const value = sshKeyFingerprint(line);
          if (value) fingerprints.push({ kind: 'ssh_key', value, sourceUrl: `${url}.keys` });
        }
      }
    }
    yield {
      snapshotId: res.snapshotId,
      url,
      resourceId: `user:${handle}`,
      docType: 'profile',
      title: handle,
      author: { handle, displayName: name, profileUrl: url },
      container: { kind: 'profile', section: $('.profile .location').text().trim() || undefined },
      relation,
      segments,
      discovered,
      fingerprints,
    };
    if (relation === 'mention') return;
    for (const a of $('ul.repos a').toArray()) yield* repo(ctx, $(a).attr('href')!, 'author');
  }

  return {
    id: 'world-code',
    descriptor: { name: 'Kodownia (repozytoria, środowisko testowe)', kind: 'code_hosting', origin: 'kodownia', hosts: [hostOf(base)], synthetic: true },
    supports: (id) => ['username', 'full_name', 'email', 'crypto_address'].includes(id.kind) || pathOn(base, id)?.length === 1,
    async *search(id, ctx) {
      const path = pathOn(base, id);
      if (path) {
        yield* profile(ctx, path[0], 'profile_owner');
        return;
      }
      const res = await ctx.fetch(search(base, id.value));
      if (res.status !== 200) return;
      const $ = parseHtml(res.body);
      for (const el of $('li.result-user').toArray()) {
        const handle = $(el).find('a').text().trim();
        const name = $(el).find('.name').text().trim();
        if (id.kind === 'username' && sameUser(handle, id.value)) yield* profile(ctx, handle, 'profile_owner');
        else if (id.kind === 'full_name' && name && sameName(name, id.value)) yield* profile(ctx, handle, 'profile_owner');
        else if (id.kind === 'email') yield* profile(ctx, handle, 'profile_owner', id.normalized);
        else if (id.kind === 'crypto_address') yield* profile(ctx, handle, 'mention');
      }
      if (id.kind !== 'crypto_address') return;
      for (const a of $('li.result-repo a').toArray()) yield* repo(ctx, $(a).attr('href')!, 'mention');
    },
    enumerate: (id, ctx) => otherHandles(ctx, base, id, 'li.result-user a'),
  };
}

// ----------------------------------------------------------------------------- P2P ads

export function createAdsConnector(base: string): SourceConnector {
  async function* ad(ctx: ConnectorContext, path: string, relation: Relation): AsyncGenerator<SourceItem> {
    const url = `${base}${path}`;
    const res = await ctx.fetch(url);
    if (res.status !== 200) return;
    const $ = parseHtml(res.body);
    const id = $('article.ad').attr('data-ad-id')!;
    const sellerHandle = $('a.seller').text().trim();
    const body = $('.ad-body');
    yield {
      snapshotId: res.snapshotId,
      url,
      resourceId: `ad:${id}`,
      docType: 'ad',
      title: $('h1.ad-title').text().trim(),
      author: { handle: sellerHandle, profileUrl: `${base}/sprzedawca/${sellerHandle}` },
      publishedAt: $('article.ad time').attr('datetime'),
      container: { kind: 'listing', id, section: $('.city').text().trim(), title: $('.price').text().trim() },
      relation,
      segments: [{ kind: 'title', text: $('h1.ad-title').text().trim() }, { kind: 'price', text: $('.price').text().trim() }, { kind: 'body', text: textOf(body) }, ...linkSegments($, body)],
      images: $('article.ad img').toArray().map((img) => ({ url: new URL($(img).attr('src') ?? '', url).toString() })),
      discovered: [],
    };
  }

  async function* seller(ctx: ConnectorContext, handle: string, check?: (phone: string, email?: string) => boolean): AsyncGenerator<SourceItem> {
    const url = `${base}/sprzedawca/${encodeURIComponent(handle)}`;
    const res = await ctx.fetch(url);
    if (res.status !== 200) return;
    const $ = parseHtml(res.body);
    const phone = $('.profile .phone').text().trim();
    const email = $('.profile a.email').text().trim() || undefined;
    if (check && !check(phone, email)) return;
    const discovered: Identifier[] = [makeIdentifier('phone', phone)];
    if (email) discovered.push(makeIdentifier('email', email));
    yield {
      snapshotId: res.snapshotId,
      url,
      resourceId: `seller:${handle}`,
      docType: 'profile',
      title: handle,
      author: { handle, profileUrl: url },
      publishedAt: $('.profile time.since').attr('datetime'),
      container: { kind: 'profile', section: $('.profile .city').text().trim() },
      relation: 'profile_owner',
      segments: [{ kind: 'contact', text: [phone, email].filter(Boolean).join('\n') }],
      discovered,
    };
    for (const a of $('ul.seller-ads a').toArray()) yield* ad(ctx, $(a).attr('href')!, 'author');
  }

  return {
    id: 'world-ads',
    descriptor: { name: 'Bazarek P2P (ogłoszenia, środowisko testowe)', kind: 'marketplace', origin: 'bazarek', hosts: [hostOf(base)], synthetic: true },
    supports: (id) => ['username', 'email', 'phone', 'crypto_address'].includes(id.kind) || pathOn(base, id)?.[0] === 'sprzedawca',
    async *search(id, ctx) {
      const path = pathOn(base, id);
      if (path) {
        if (path[1]) yield* seller(ctx, path[1]);
        return;
      }
      const res = await ctx.fetch(search(base, id.kind === 'phone' ? id.normalized : id.value));
      if (res.status !== 200) return;
      const $ = parseHtml(res.body);
      for (const el of $('li.result-seller a').toArray()) {
        const handle = $(el).text().trim();
        if (id.kind === 'username' && sameUser(handle, id.value)) yield* seller(ctx, handle);
        else if (id.kind === 'email') yield* seller(ctx, handle, (_p, email) => email?.toLowerCase() === id.normalized);
        else if (id.kind === 'phone') yield* seller(ctx, handle, (phone) => normalizeIdentifier('phone', phone) === id.normalized);
      }
      if (id.kind !== 'crypto_address') return;
      for (const a of $('li.result-ad a').toArray()) yield* ad(ctx, $(a).attr('href')!, 'mention');
    },
    enumerate: (id, ctx) => otherHandles(ctx, base, id, 'li.result-seller a'),
  };
}

/** The three sources of the built-in synthetic environment. */
export function createWorldConnectors(urls: WorldUrls): SourceConnector[] {
  const trim = (u: string) => u.replace(/\/+$/, '');
  return [createForumConnector(trim(urls.forum)), createCodeConnector(trim(urls.code)), createAdsConnector(trim(urls.ads))];
}

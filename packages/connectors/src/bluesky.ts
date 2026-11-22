import { makeIdentifier, type ConnectorContext, type Identifier, type Segment, type SourceConnector, type SourceItem } from '@olcys/core';

/**
 * Bluesky: an open social network. Profiles and posts are public data served by a public read-only API,
 * with no login. A handle is a domain name: "nick.bsky.social" for most people, their own domain for some.
 */
export const BLUESKY_API = 'https://public.api.bsky.app';

type Json = Record<string, any>;

export interface BlueskyProfile {
  /** Permanent account id ("did:plc:…"); the handle can change, this cannot. */
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  followers: number;
  follows: number;
  posts: number;
  createdAt?: string;
}

const clean = (s: unknown) => (typeof s === 'string' && s.trim()) || undefined;

/** Reads a profile from `getProfile`, or one entry of a `searchActors` answer. */
export function parseBlueskyProfile(json: Json | undefined): BlueskyProfile | undefined {
  if (typeof json?.did !== 'string' || typeof json.handle !== 'string') return undefined;
  return {
    did: json.did,
    handle: json.handle.toLowerCase(),
    displayName: clean(json.displayName),
    description: clean(json.description),
    followers: Number(json.followersCount ?? 0),
    follows: Number(json.followsCount ?? 0),
    posts: Number(json.postsCount ?? 0),
    createdAt: clean(json.createdAt),
  };
}

/** One page of an account search. */
export function parseBlueskyActors(json: Json | undefined): { actors: BlueskyProfile[]; cursor?: string } {
  const actors = ((json?.actors ?? []) as Json[]).map((a) => parseBlueskyProfile(a)).filter((a): a is BlueskyProfile => !!a);
  return { actors, cursor: clean(json?.cursor) };
}

export interface BlueskyPost {
  /** Record key: the last part of the post's address, used in its public link. */
  rkey: string;
  at: string;
  text: string;
  /** Full links of the post. The visible text often shows them shortened ("example.com/abc…"). */
  links: string[];
  /** True when the post answers someone else's post. */
  reply: boolean;
}

/**
 * The account's own posts from `getAuthorFeed`. Reposts are left out: they are other people's words.
 * So are quoted posts and the posts being replied to — only what the account itself wrote is kept.
 */
export function parseBlueskyFeed(json: Json | undefined, did: string): BlueskyPost[] {
  const out: BlueskyPost[] = [];
  for (const item of (json?.feed ?? []) as Json[]) {
    const post: Json | undefined = item.post;
    const record: Json | undefined = post?.record;
    if (item.reason || post?.author?.did !== did || typeof post?.uri !== 'string' || typeof record?.createdAt !== 'string') continue;
    const at = Date.parse(record.createdAt);
    const rkey = post.uri.split('/').pop();
    if (Number.isNaN(at) || !rkey) continue;
    const links = new Set<string>();
    for (const facet of (record.facets ?? []) as Json[]) for (const f of (facet.features ?? []) as Json[]) if (typeof f.uri === 'string') links.add(f.uri);
    const external = record.embed?.external?.uri ?? record.embed?.media?.external?.uri;
    if (typeof external === 'string') links.add(external);
    out.push({ rkey, at: new Date(at).toISOString(), text: typeof record.text === 'string' ? record.text : '', links: [...links].filter((l) => /^https?:\/\//i.test(l)), reply: !!record.reply });
  }
  return out;
}

/** "nick.bsky.social" → "nick"; a handle on the person's own domain stays whole. */
export const blueskyNick = (handle: string): string => handle.toLowerCase().replace(/\.bsky\.social$/, '');

/** Links in a profile description that point to the person's accounts or pages elsewhere. */
const linksIn = (text: string): string[] => [...new Set(text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [])].map((u) => u.replace(/[.,;:!?]+$/, '')).slice(0, 6);

export interface BlueskyOptions {
  api?: string;
  /** How many of the account's most recent posts are read (the API gives at most 100 per request). */
  maxPosts?: number;
}

/** A Bluesky profile as a document. */
export function blueskyProfileItem(p: BlueskyProfile, snapshotId: string): SourceItem {
  const url = `https://bsky.app/profile/${p.handle}`;
  const segments: Segment[] = [];
  if (p.description) segments.push({ kind: 'bio', text: p.description });
  const discovered: Identifier[] = [];
  for (const link of linksIn(p.description ?? '')) discovered.push(makeIdentifier('profile_url', link));
  // A handle on one's own domain is proof of controlling that domain; the domain is a lead in itself.
  if (!p.handle.endsWith('.bsky.social')) {
    segments.push({ kind: 'link', text: `https://${p.handle}` });
    discovered.push(makeIdentifier('profile_url', `https://${p.handle}`));
  }
  return {
    snapshotId, url, resourceId: p.did, docType: 'profile', title: p.handle,
    author: { handle: blueskyNick(p.handle), displayName: p.displayName, profileUrl: url },
    publishedAt: p.createdAt, container: { kind: 'profile', stats: { followers: p.followers, posts: p.posts } }, relation: 'profile_owner', segments, discovered,
  };
}

/**
 * Bluesky, live, for one account: the profile (name, description) and the account's own recent posts with
 * their full links and dates. Nothing here is verified by a signature; an address or a wallet name found in
 * the description or in a post counts as "published by the account", like on any other profile.
 */
export function createBlueskyConnector(opts: BlueskyOptions = {}): SourceConnector {
  const api = (opts.api ?? BLUESKY_API).replace(/\/+$/, '');
  const xrpc = (method: string, query: string) => `${api}/xrpc/${method}?${query}`;
  /** The handles to try for an identifier: the nick on the default domain, or the handle as given. */
  const handlesOf = (id: Identifier): string[] => {
    if (id.kind === 'username') {
      const nick = id.normalized;
      if (/^[a-z0-9][a-z0-9-]{1,61}(\.[a-z0-9-]{1,61})+$/.test(nick)) return [nick]; // already a full handle (a domain)
      return /^[a-z0-9][a-z0-9-]{2,17}$/.test(nick) ? [`${nick}.bsky.social`] : [];
    }
    if (id.kind !== 'profile_url') return [];
    try {
      const u = new URL(id.value);
      const [first, handle] = u.pathname.split('/').filter(Boolean);
      return /^(www\.)?bsky\.app$/i.test(u.hostname) && first === 'profile' && handle ? [decodeURIComponent(handle).toLowerCase()] : [];
    } catch {
      return [];
    }
  };
  const profile = async (ctx: ConnectorContext, actor: string): Promise<{ p: BlueskyProfile; snapshotId: string } | undefined> => {
    const res = await ctx.fetch(xrpc('app.bsky.actor.getProfile', `actor=${encodeURIComponent(actor)}`));
    if (res.status !== 200) return undefined; // 400 "Profile not found" for a handle nobody has
    const p = parseBlueskyProfile(JSON.parse(res.body));
    return p ? { p, snapshotId: res.snapshotId } : undefined;
  };

  return {
    id: 'bluesky',
    descriptor: { name: 'Bluesky', kind: 'social', origin: 'bluesky', hosts: [new URL(api).host], synthetic: false },
    supports: (id) => handlesOf(id).length > 0,
    async *search(id, ctx): AsyncGenerator<SourceItem> {
      for (const handle of handlesOf(id)) {
        const found = await profile(ctx, handle);
        if (!found) continue;
        const item = blueskyProfileItem(found.p, found.snapshotId);
        yield item;

        const limit = Math.min(100, opts.maxPosts ?? 60);
        const feed = await ctx.fetch(xrpc('app.bsky.feed.getAuthorFeed', `actor=${encodeURIComponent(found.p.did)}&limit=${limit}&filter=posts_with_replies`));
        if (feed.status !== 200) return;
        for (const post of parseBlueskyFeed(JSON.parse(feed.body), found.p.did)) {
          // Links the visible text shortens are added in full, so that an address or a name inside a link is not lost.
          const hidden = post.links.filter((l) => !post.text.includes(l));
          const text = [post.text, ...hidden].filter(Boolean).join('\n');
          if (!text) continue;
          yield {
            snapshotId: feed.snapshotId, url: `${item.url}/post/${post.rkey}`, resourceId: `post:${post.rkey}`, docType: 'post', title: post.text.replace(/\s+/g, ' ').slice(0, 70),
            author: item.author, publishedAt: post.at, container: { kind: post.reply ? 'reply' : 'feed' }, relation: 'author', segments: [{ kind: 'body', text }], discovered: [],
          };
        }
        return;
      }
    },
    /** Nicks on the default domain that contain the given nick (Bluesky's own account search), other than the nick itself. */
    async enumerate(id, ctx) {
      if (id.kind !== 'username' || !/^[a-z0-9][a-z0-9-]{4,17}$/.test(id.normalized)) return [];
      const res = await ctx.fetch(xrpc('app.bsky.actor.searchActors', `q=${encodeURIComponent(id.normalized)}&limit=25`));
      if (res.status !== 200) return [];
      return parseBlueskyActors(JSON.parse(res.body)).actors
        .filter((a) => a.handle.endsWith('.bsky.social'))
        .map((a) => blueskyNick(a.handle))
        .filter((nick) => nick !== id.normalized && nick.includes(id.normalized));
    },
  };
}

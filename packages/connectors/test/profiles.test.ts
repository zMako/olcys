import { describe, expect, it } from 'vitest';
import { extractAddresses, makeIdentifier, type ConnectorContext, type FetchInit, type FetchedResource, type SourceItem } from '@olcys/core';
import { blueskyNick, createBlueskyConnector, parseBlueskyActors, parseBlueskyFeed, parseBlueskyProfile } from '../src/bluesky';
import { createLensConnector, parseLensAccount } from '../src/lens';
import { createTelegramConnector, parseTelegramPreview } from '../src/telegram';

/** A stand-in for the network: canned answers by URL (or by a function of the request), and a record of what was asked. */
function fakeNet(routes: Record<string, unknown | ((init?: FetchInit) => unknown)>, missingStatus = 404) {
  const asked: { url: string; init?: FetchInit }[] = [];
  const ctx: ConnectorContext = {
    log: () => {},
    async fetch(url, init): Promise<FetchedResource> {
      asked.push({ url, init });
      const key = Object.keys(routes).find((k) => url === k || url.startsWith(k));
      const hit = key === undefined ? undefined : routes[key];
      const value = typeof hit === 'function' ? (hit as (i?: FetchInit) => unknown)(init) : hit;
      const body = value === undefined ? '{"error":"InvalidRequest","message":"Profile not found"}' : typeof value === 'string' ? value : JSON.stringify(value);
      return { snapshotId: `snap-${asked.length}`, url, status: value === undefined ? missingStatus : 200, contentType: 'application/json', body, sha256: '', fetchedAt: '2026-11-22T12:00:00.000Z' };
    },
  };
  return { ctx, asked };
}
const collect = async (gen: AsyncGenerator<SourceItem>) => {
  const out: SourceItem[] = [];
  for await (const x of gen) out.push(x);
  return out;
};
const ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('Bluesky connector', () => {
  const api = 'https://public.api.bsky.app/xrpc';
  const did = 'did:plc:oky5czdrnfjpqslsw2a5iclo';
  // Shapes as the public API returns them (trimmed to the fields that are read).
  const profile = {
    did, handle: 'Mokotowska.bsky.social', displayName: 'Ola z Mokotowa', description: `Programistka, Warszawa.\nNapiwki: mokotowska.eth albo ${ETH}\nKod: https://github.com/mokotowska`,
    followersCount: 412, followsCount: 120, postsCount: 3, createdAt: '2023-05-17T06:31:40.296Z', associated: { lists: 0 }, labels: [],
  };
  const author = { did, handle: 'mokotowska.bsky.social' };
  const feed = {
    cursor: '2026-10-01T00:00:00Z',
    feed: [
      // an own post whose visible text shortens the link
      { post: { uri: `at://${did}/app.bsky.feed.post/3n2tynzp4gs2t`, author, record: { $type: 'app.bsky.feed.post', createdAt: '2026-11-21T21:00:52.976Z', langs: ['pl'], text: 'Sprzedałam wczoraj 0,5 ETH, szczegóły: moja-strona.example/portf…', facets: [{ features: [{ $type: 'app.bsky.richtext.facet#link', uri: `https://moja-strona.example/portfel?adres=${ETH}` }], index: { byteStart: 40, byteEnd: 68 } }] } } },
      // a repost: someone else's words
      { post: { uri: 'at://did:plc:lqarmcw7eb6pg5veceb5wyld/app.bsky.feed.post/3n2tpt4hfv22s', author: { did: 'did:plc:lqarmcw7eb6pg5veceb5wyld', handle: 'ktos.inny.example' }, record: { $type: 'app.bsky.feed.post', createdAt: '2026-11-20T10:00:00.000Z', text: 'Wyślij BTC na bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' } }, reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: author, indexedAt: '2026-11-20T11:00:00.000Z' } },
      // an own reply, with an external link card
      { post: { uri: `at://${did}/app.bsky.feed.post/3mxwqdwktlk2j`, author, record: { $type: 'app.bsky.feed.post', createdAt: '2026-10-15T19:02:38.565Z', text: 'Tak, to mój projekt', reply: { parent: { uri: 'at://did:plc:x/app.bsky.feed.post/1' }, root: { uri: 'at://did:plc:x/app.bsky.feed.post/1' } }, embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://projekt.example/', title: 'Projekt', description: '' } } } }, reply: { parent: {}, root: {} } },
    ],
  };

  it('parses profiles, search pages and the account’s own posts', () => {
    expect(parseBlueskyProfile(profile)).toMatchObject({ did, handle: 'mokotowska.bsky.social', displayName: 'Ola z Mokotowa', followers: 412, posts: 3 });
    expect(parseBlueskyProfile({ handle: 'x.bsky.social' })).toBeUndefined();
    expect(parseBlueskyActors({ actors: [profile, { nope: true }], cursor: 'abc' })).toMatchObject({ actors: [{ handle: 'mokotowska.bsky.social' }], cursor: 'abc' });
    const posts = parseBlueskyFeed(feed, did);
    expect(posts.map((p) => [p.rkey, p.at, p.reply])).toEqual([['3n2tynzp4gs2t', '2026-11-21T21:00:52.976Z', false], ['3mxwqdwktlk2j', '2026-10-15T19:02:38.565Z', true]]);
    expect(posts[0].links).toEqual([`https://moja-strona.example/portfel?adres=${ETH}`]);
    expect(posts[1].links).toEqual(['https://projekt.example/']);
    expect(blueskyNick('Mokotowska.bsky.social')).toBe('mokotowska');
    expect(blueskyNick('ola.example.pl')).toBe('ola.example.pl');
  });

  it('returns the profile and own posts for a nick, with full links, and leaves reposts out', async () => {
    const { ctx, asked } = fakeNet({
      [`${api}/app.bsky.actor.getProfile?actor=mokotowska.bsky.social`]: profile,
      [`${api}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}`]: feed,
    }, 400);
    const connector = createBlueskyConnector();
    expect(connector.descriptor).toMatchObject({ origin: 'bluesky', kind: 'social', hosts: ['public.api.bsky.app'] });
    const items = await collect(connector.search(makeIdentifier('username', 'Mokotowska'), ctx));
    expect(items.map((i) => [i.docType, i.relation, i.url])).toEqual([
      ['profile', 'profile_owner', 'https://bsky.app/profile/mokotowska.bsky.social'],
      ['post', 'author', 'https://bsky.app/profile/mokotowska.bsky.social/post/3n2tynzp4gs2t'],
      ['post', 'author', 'https://bsky.app/profile/mokotowska.bsky.social/post/3mxwqdwktlk2j'],
    ]);
    const [p, post, reply] = items;
    expect(p).toMatchObject({ resourceId: did, author: { handle: 'mokotowska', displayName: 'Ola z Mokotowa' } });
    expect(p.segments[0]).toMatchObject({ kind: 'bio' });
    expect(extractAddresses(p.segments[0].text).map((m) => m.address)).toEqual([ETH]);
    expect(p.segments[0].text).toContain('mokotowska.eth');
    expect(p.discovered.map((d) => `${d.kind}:${d.value}`)).toEqual(['profile_url:https://github.com/mokotowska']);
    // the address sits only in the full link, which the visible text cuts short
    expect(post.publishedAt).toBe('2026-11-21T21:00:52.976Z');
    expect(extractAddresses(post.segments[0].text).map((m) => m.address)).toEqual([ETH]);
    expect(reply.container).toMatchObject({ kind: 'reply' });
    // the repost's address never reaches the engine
    expect(items.some((i) => i.segments.some((s) => s.text.includes('bc1qar0')))).toBe(false);
    expect(asked.map((a) => a.url.split('?')[0].split('/').pop())).toEqual(['app.bsky.actor.getProfile', 'app.bsky.feed.getAuthorFeed']);
  });

  it('takes a handle on the person’s own domain and a profile link, and returns nothing for a handle nobody has', async () => {
    const own = { ...profile, handle: 'ola.example.pl', description: undefined };
    const { ctx } = fakeNet({ [`${api}/app.bsky.actor.getProfile?actor=ola.example.pl`]: own, [`${api}/app.bsky.feed.getAuthorFeed`]: { feed: [] } }, 400);
    const connector = createBlueskyConnector();
    for (const id of [makeIdentifier('username', 'ola.example.pl'), makeIdentifier('profile_url', 'https://bsky.app/profile/ola.example.pl')]) {
      const [p] = await collect(connector.search(id, ctx));
      expect(p).toMatchObject({ url: 'https://bsky.app/profile/ola.example.pl', author: { handle: 'ola.example.pl' } });
      expect(p.discovered.map((d) => d.value)).toEqual(['https://ola.example.pl']);
    }
    expect(await collect(connector.search(makeIdentifier('username', 'nikt-taki'), ctx))).toEqual([]);
    expect(connector.supports(makeIdentifier('email', 'a@b.pl'))).toBe(false);
    expect(connector.supports(makeIdentifier('profile_url', 'https://github.com/ola'))).toBe(false);
  });

  it('lists similar nicks from the account search', async () => {
    const { ctx } = fakeNet({
      [`${api}/app.bsky.actor.searchActors?q=mokotowska`]: { actors: [profile, { ...profile, did: 'did:plc:b', handle: 'mokotowska-krk.bsky.social' }, { ...profile, did: 'did:plc:c', handle: 'mokotowska.example.pl' }, { ...profile, did: 'did:plc:d', handle: 'ktos.bsky.social' }] },
    });
    expect(await createBlueskyConnector().enumerate!(makeIdentifier('username', 'mokotowska'), ctx)).toEqual(['mokotowska-krk']);
  });
});

describe('Telegram connector', () => {
  // The relevant part of t.me/<handle>, as served: an account, a channel, and a handle nobody has.
  const page = (inner: string, og: string) => `<!DOCTYPE html><html><head><meta property="og:title" content="${og}"></head><body><div class="tgme_page">${inner}</div></body></html>`;
  const account = page(
    `<div class="tgme_page_title"><span dir="auto">Ola Mokotowska</span></div>
<div class="tgme_page_extra">
  @mokotowska
</div>
<div class="tgme_page_description ">Kupię/sprzedam krypto, Warszawa.<br/>ETH: ${ETH}<br/><a href="https://mokotowska.example/" target="_blank" rel="noopener">mokotowska.example</a></div>`, 'Ola Mokotowska');
  const channel = page(
    `<div class="tgme_page_title" dir="auto">
  <span dir="auto">Krypto Mokotów</span><i class="verified-icon"> ✔</i>
</div>
<div class="tgme_page_extra">9 910 subscribers</div>
<div class="tgme_page_description" dir="auto">Kanał o kryptowalutach.</div>`, 'Krypto Mokotów');
  const nobody = page('<div class="tgme_page_icon"></div><div class="tgme_page_description">If you have <strong>Telegram</strong>, you can contact <a class="tgme_username_link" href="tg://resolve?domain=nikt_taki">@nikt_taki</a> right away.</div>', 'Telegram: Contact @nikt_taki');

  it('reads the name, the description and the kind of page, and recognises a handle nobody has', () => {
    expect(parseTelegramPreview(account)).toEqual({ name: 'Ola Mokotowska', description: `Kupię/sprzedam krypto, Warszawa.\nETH: ${ETH}\nmokotowska.example`, kind: 'account', links: ['https://mokotowska.example/'], verified: false });
    expect(parseTelegramPreview(channel)).toMatchObject({ name: 'Krypto Mokotów', kind: 'channel', verified: true, description: 'Kanał o kryptowalutach.' });
    expect(parseTelegramPreview(nobody)).toBeUndefined();
  });

  it('returns the public profile for a handle or a t.me link, and nothing else', async () => {
    const { ctx, asked } = fakeNet({ 'https://t.me/mokotowska': account, 'https://t.me/krypto_mokotow': channel, 'https://t.me/nikt_taki': nobody });
    const connector = createTelegramConnector();
    expect(connector.descriptor).toMatchObject({ origin: 'telegram', kind: 'messenger', hosts: ['t.me'] });
    for (const id of [makeIdentifier('username', '@Mokotowska'), makeIdentifier('profile_url', 'https://t.me/mokotowska'), makeIdentifier('messenger_id', 'mokotowska')]) {
      const items = await collect(connector.search(id, ctx));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ url: 'https://t.me/mokotowska', docType: 'profile', relation: 'profile_owner', author: { handle: 'mokotowska', displayName: 'Ola Mokotowska' }, container: { kind: 'profile' } });
      expect(extractAddresses(items[0].segments[0].text).map((m) => m.address)).toEqual([ETH]);
      expect(items[0].discovered.map((d) => d.value)).toEqual(['https://mokotowska.example/']);
    }
    expect((await collect(connector.search(makeIdentifier('username', 'krypto_mokotow'), ctx)))[0].container).toMatchObject({ kind: 'channel' });
    expect(await collect(connector.search(makeIdentifier('username', 'nikt_taki'), ctx))).toEqual([]);
    // invitations and message previews are not handles; too-short or dotted nicks are not asked about at all
    for (const id of [makeIdentifier('profile_url', 'https://t.me/joinchat/AAAA'), makeIdentifier('profile_url', 'https://t.me/s/mokotowska'), makeIdentifier('username', 'ola'), makeIdentifier('username', 'ola.example.pl')]) expect(connector.supports(id)).toBe(false);
    expect(asked.every((a) => /^https:\/\/t\.me\/[a-z_]+$/.test(a.url))).toBe(true);
  });
});

describe('Lens connector', () => {
  // The answer of api.lens.xyz for account(request:{username:{localName:"stani"}}), as served.
  const stani = {
    address: '0xAd2c0BEAdE60fb9f7ec5C87bDE8e4c126145F6E7', owner: '0x7241DDDec3A6aF367882eAF9651b87E1C7549Dff', createdAt: '2022-05-17T17:36:56+00:00',
    username: { value: 'lens/stani', localName: 'stani' },
    metadata: { name: 'Stani', bio: 'Founder & CEO @Aave', attributes: [{ key: 'location', value: 'Lens' }, { key: 'website', value: 'https://aave.com' }, { key: 'x', value: 'https://x.com/StaniKulechov' }] },
  };

  it('parses an account with its owner address and attributes', () => {
    expect(parseLensAccount(stani)).toEqual({
      localName: 'stani', account: '0xAd2c0BEAdE60fb9f7ec5C87bDE8e4c126145F6E7', owner: '0x7241DDDec3A6aF367882eAF9651b87E1C7549Dff', createdAt: '2022-05-17T17:36:56.000Z',
      name: 'Stani', bio: 'Founder & CEO @Aave', location: 'Lens', website: 'https://aave.com', x: 'StaniKulechov',
    });
    expect(parseLensAccount(null)).toBeUndefined();
    expect(parseLensAccount({ ...stani, owner: 'not-an-address' })).toBeUndefined();
    expect(parseLensAccount({ ...stani, username: null })).toBeUndefined();
  });

  it('returns the profile with the owner address as a statement vouched for by the network', async () => {
    const { ctx, asked } = fakeNet({ 'https://api.lens.xyz/graphql': (init?: FetchInit) => ({ data: { account: JSON.parse(init!.body!).variables.name === 'stani' ? stani : null } }) });
    const connector = createLensConnector();
    expect(connector.descriptor).toMatchObject({ origin: 'lens', kind: 'social', hosts: ['api.lens.xyz'] });
    for (const id of [makeIdentifier('username', 'Stani'), makeIdentifier('username', 'lens/stani'), makeIdentifier('profile_url', 'https://hey.xyz/u/stani')]) {
      const items = await collect(connector.search(id, ctx));
      expect(items).toHaveLength(1);
      const [p] = items;
      expect(p).toMatchObject({ url: 'https://hey.xyz/u/stani', docType: 'profile', relation: 'profile_owner', title: 'lens/stani', author: { handle: 'stani', displayName: 'Stani' }, container: { section: 'Lens' } });
      // the owner address is on the profile (so it is a mention of the account's own), and only that address
      expect(p.segments.flatMap((s) => extractAddresses(s.text).map((m) => m.address))).toEqual(['0x7241DDDec3A6aF367882eAF9651b87E1C7549Dff']);
      expect(p.discovered.map((d) => d.value)).toEqual(['https://aave.com', 'https://x.com/StaniKulechov']);
      // vouched for by the service, not verified here; the statement names the account, as rule C3 requires
      expect(p.attestations).toHaveLength(1);
      expect(p.attestations![0]).toMatchObject({ chain: 'ethereum', address: '0x7241DDDec3A6aF367882eAF9651b87E1C7549Dff', valid: true, attestedBy: 'sieć Lens' });
      expect(p.attestations![0].message.toLowerCase()).toContain(p.author!.handle!);
    }
    expect(await collect(connector.search(makeIdentifier('username', 'nikt-taki'), ctx))).toEqual([]);
    // the name travels as a variable, never spliced into the query text
    expect(asked.every((a) => a.init?.method === 'POST' && !JSON.parse(a.init.body!).query.includes('stani'))).toBe(true);
    expect(connector.supports(makeIdentifier('username', 'a b'))).toBe(false);
  });

  it('lists similar names from the name search', async () => {
    const { ctx } = fakeNet({ 'https://api.lens.xyz/graphql': { data: { accounts: { items: [stani, { ...stani, username: { localName: 'stani-labs' } }, { ...stani, username: { localName: 'starny' } }] } } } });
    expect(await createLensConnector().enumerate!(makeIdentifier('username', 'stani'), ctx)).toEqual(['stani-labs']);
  });
});

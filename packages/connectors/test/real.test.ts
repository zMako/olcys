import { describe, expect, it } from 'vitest';
import { extractAddresses, makeIdentifier, type ConnectorContext, type FetchInit, type FetchedResource, type SourceItem } from '@olcys/core';
import { createEnsNameService, createEsploraConnector, createEvmRpcConnector, createGithubConnector, createWaybackConnector, decodeString, namehash, selector, transfersFromTx } from '../src';

/** A stand-in for the network: canned answers by URL, and a record of what was asked. */
function fakeNet(routes: Record<string, unknown | ((init?: FetchInit) => unknown)>) {
  const asked: { url: string; init?: FetchInit }[] = [];
  const ctx: ConnectorContext = {
    log: () => {},
    async fetch(url, init): Promise<FetchedResource> {
      asked.push({ url, init });
      const key = Object.keys(routes).find((k) => url === k || url.startsWith(k));
      const hit = key === undefined ? undefined : routes[key];
      const value = typeof hit === 'function' ? (hit as (i?: FetchInit) => unknown)(init) : hit;
      const body = value === undefined ? '{"message":"Not Found"}' : typeof value === 'string' ? value : JSON.stringify(value);
      return { snapshotId: `snap-${asked.length}`, url, status: value === undefined ? 404 : 200, contentType: 'application/json', body, sha256: '', fetchedAt: '2026-11-21T12:00:00.000Z' };
    },
  };
  return { ctx, asked };
}
const collect = async (gen: AsyncGenerator<SourceItem>) => {
  const out: SourceItem[] = [];
  for await (const x of gen) out.push(x);
  return out;
};
const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('GitHub connector', () => {
  const api = 'https://api.github.com';
  const user = { login: 'devka', type: 'User', name: 'Ewa Rzecka', bio: `Tips: ${ETH}`, blog: 'https://rzecka.example', email: 'ewa@example.test', location: 'Radom', twitter_username: 'devka_pl', html_url: 'https://github.com/devka', created_at: '2019-04-01T10:00:00Z' };
  const routes = {
    [`${api}/users/devka/repos`]: [
      { full_name: 'devka/fork', html_url: 'https://github.com/devka/fork', description: null, fork: true, stargazers_count: 900, pushed_at: '2025-01-01T00:00:00Z' },
      { full_name: 'devka/portfel', html_url: 'https://github.com/devka/portfel', description: 'CLI', fork: false, stargazers_count: 12, pushed_at: '2025-05-01T00:00:00Z' },
    ],
    [`${api}/users/devka`]: user,
    [`${api}/repos/devka/devka/readme`]: `# Cześć\nBTC: ${BTC}`,
    [`${api}/repos/devka/portfel/readme`]: '# portfel\nNarzędzie.',
    [`${api}/repos/devka/portfel/contents/.github/FUNDING.yml`]: `custom: ["bitcoin:${BTC}"]`,
  };

  it('reads the profile, the profile README and the funding files of own repositories', async () => {
    const { ctx, asked } = fakeNet(routes);
    const items = await collect(createGithubConnector({ token: 'secret-token' }).search(makeIdentifier('username', 'devka'), ctx));
    expect(items.map((i) => [i.docType, i.resourceId, i.relation])).toEqual([['profile', 'user:devka', 'profile_owner'], ['repo', 'repo:devka/portfel', 'author']]);
    const [profile, repo] = items;
    expect(profile).toMatchObject({ url: 'https://github.com/devka', author: { handle: 'devka', displayName: 'Ewa Rzecka' } });
    expect(profile.segments.flatMap((s) => extractAddresses(s.text).map((m) => m.address))).toEqual([ETH, BTC]);
    expect(profile.discovered.map((d) => `${d.kind}:${d.value}`)).toEqual(['email:ewa@example.test', 'full_name:Ewa Rzecka', 'profile_url:https://rzecka.example', 'username:devka_pl']);
    expect(repo.segments.flatMap((s) => extractAddresses(s.text).map((m) => m.address))).toEqual([BTC]);
    // forks are not the account's own work
    expect(asked.some((a) => a.url.includes('devka/fork'))).toBe(false);
    // the token travels in a header, which the engine never stores
    expect(asked.every((a) => a.init?.headers?.authorization === 'Bearer secret-token')).toBe(true);
    expect(asked.every((a) => !a.url.includes('secret-token'))).toBe(true);
  });

  it('accepts a profile address, matches names exactly, and searches code only with a token', async () => {
    const { ctx } = fakeNet({ ...routes, [`${api}/search/users`]: { items: [{ login: 'devka' }] } });
    const gh = createGithubConnector();
    expect((await collect(gh.search(makeIdentifier('profile_url', 'https://github.com/devka'), ctx)))[0].resourceId).toBe('user:devka');
    expect(await collect(gh.search(makeIdentifier('full_name', 'Ewa Rzecka'), ctx))).toHaveLength(2);
    expect(await collect(gh.search(makeIdentifier('full_name', 'Ewa Inna'), ctx))).toHaveLength(0);
    expect(gh.supports(makeIdentifier('crypto_address', BTC))).toBe(false);
    expect(createGithubConnector({ token: 't' }).supports(makeIdentifier('crypto_address', BTC))).toBe(true);
    expect(gh.supports(makeIdentifier('profile_url', 'https://example.org/devka'))).toBe(false);
  });

  it('returns nothing, without failing, when the API refuses', async () => {
    const { ctx } = fakeNet({});
    expect(await collect(createGithubConnector().search(makeIdentifier('username', 'devka'), ctx))).toEqual([]);
  });
});

describe('Bitcoin explorer connector', () => {
  const tx = (txid: string, time: number, vin: [string, number][], vout: [string, number][]) => ({
    txid, status: { confirmed: true, block_time: time },
    vin: vin.map(([a, v]) => ({ prevout: { scriptpubkey_address: a, value: v } })),
    vout: vout.map(([a, v]) => ({ scriptpubkey_address: a, value: v })),
  });

  it('reports the other funding addresses of a transaction and ignores change', () => {
    const t = tx('t1', 1_750_000_000, [['ME', 60_000_000], ['MINE2', 40_000_000]], [['SHOP', 90_000_000], ['ME', 9_000_000]]);
    expect(transfersFromTx(t, 'ME')).toEqual([{ chain: 'bitcoin', txHash: 't1', at: '2025-06-15T15:06:40.000Z', asset: 'BTC', from: 'ME', to: 'SHOP', amount: 0.54, coInputs: ['MINE2'] }]);
    expect(transfersFromTx(t, 'SHOP')).toEqual([{ chain: 'bitcoin', txHash: 't1', at: '2025-06-15T15:06:40.000Z', asset: 'BTC', from: 'ME', to: 'SHOP', amount: 0.9 }]);
  });

  it('reads balance, transaction count and history from an Esplora-style API', async () => {
    const base = 'https://explorer.example/api';
    const { ctx } = fakeNet({
      [`${base}/address/ME/txs`]: [tx('t2', 1_750_100_000, [['ME', 50_000_000]], [['SHOP', 49_000_000]]), tx('t1', 1_750_000_000, [['PAYER', 80_000_000]], [['ME', 50_000_000]])],
      [`${base}/address/ME`]: { chain_stats: { funded_txo_sum: 50_000_000, spent_txo_sum: 50_000_000, tx_count: 2 } },
    });
    const c = createEsploraConnector(base);
    expect(await c.getAccount('bitcoin', 'ME', ctx)).toMatchObject({ kind: 'eoa', txCount: 2, balances: [], labels: [] });
    const transfers = await c.getTransfers('bitcoin', 'ME', ctx);
    expect(transfers.map((t) => [t.txHash, t.from, t.to, t.amount])).toEqual([['t1', 'PAYER', 'ME', 0.5], ['t2', 'ME', 'SHOP', 0.49]]);
    expect(transfers.every((t) => t.snapshotId)).toBe(true);
  });
});

describe('Ethereum node and ENS', () => {
  it('uses the standard function selectors and name hashing', () => {
    expect([selector('resolver(bytes32)'), selector('addr(bytes32)'), selector('name(bytes32)'), selector('text(bytes32,string)')]).toEqual(['0178b8bf', '3b3b57de', '691f3431', '59d1d43c']);
    // test vectors from the ENS specification (EIP-137)
    expect(namehash('')).toBe('0'.repeat(64));
    expect(namehash('eth')).toBe('93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae');
    expect(namehash('foo.eth')).toBe('de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f');
    expect(decodeString('0x' + '20'.padStart(64, '0') + '05'.padStart(64, '0') + '6465766b61'.padEnd(64, '0'))).toBe('devka');
  });

  const word = (h: string) => h.replace(/^0x/, '').padStart(64, '0');
  const str = (s: string) => word('20') + word(s.length.toString(16)) + Buffer.from(s).toString('hex').padEnd(64, '0');
  const node = 'https://node.example';
  const RESOLVER = '0x' + '11'.repeat(20);
  const answer = (init?: FetchInit) => {
    const calls = JSON.parse(init!.body!) as { id: number; method: string; params: [{ to: string; data: string }] | [string, string] }[];
    return calls.map((c) => {
      if (c.method === 'eth_getCode') return { id: c.id, result: (c.params[0] as string) === ETH ? '0x' : '0x6080604052' };
      if (c.method === 'eth_getTransactionCount') return { id: c.id, result: '0x2a' };
      if (c.method === 'eth_getBalance') return { id: c.id, result: '0x' + (15n * 10n ** 17n).toString(16) };
      const data = (c.params[0] as { data: string }).data.slice(2);
      const fn = data.slice(0, 8);
      if (fn === selector('resolver(bytes32)')) return { id: c.id, result: '0x' + word(RESOLVER) };
      if (fn === selector('addr(bytes32)')) return { id: c.id, result: '0x' + word(ETH) };
      if (fn === selector('name(bytes32)')) return { id: c.id, result: '0x' + str('devka.eth') };
      return { id: c.id, result: '0x' + str(data.includes(Buffer.from('com.github').toString('hex')) ? 'devka' : '') };
    });
  };

  it('tells a plain account from a contract through the node', async () => {
    const { ctx, asked } = fakeNet({ [node]: answer });
    const c = createEvmRpcConnector(node);
    expect(await c.getAccount('ethereum', ETH, ctx)).toMatchObject({ kind: 'eoa', code: '0x', txCount: 42, balances: [{ asset: 'ETH', amount: 1.5 }] });
    expect((await c.getAccount('ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7', ctx)).kind).toBe('contract');
    expect(asked[0].init).toMatchObject({ method: 'POST' });
  });

  it('resolves a name, reads its records, and accepts a reverse name only if it points back', async () => {
    const { ctx } = fakeNet({ [node]: answer });
    const ens = createEnsNameService(node);
    expect(await ens.resolve('devka.eth', ctx)).toMatchObject({ name: 'devka.eth', address: ETH, records: { 'com.github': 'devka' } });
    expect(await ens.reverse('ethereum', ETH, ctx)).toMatchObject({ name: 'devka.eth', address: ETH });
    // the reverse record of another address claims the same name, but the name does not point back at it
    expect(await ens.reverse('ethereum', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', ctx)).toBeUndefined();
    expect(await ens.reverse('bitcoin', BTC, ctx)).toBeUndefined();
  });
});

describe('Wayback Machine connector', () => {
  it('lists captures and points at the pages exactly as they were stored', async () => {
    const { ctx } = fakeNet({ 'https://web.archive.org/cdx/search/cdx': [['timestamp'], ['20220810101500'], ['20240920101500']] });
    expect(await createWaybackConnector().captures('https://github.com/devka', ctx)).toEqual([
      { timestamp: '20220810101500', at: '2022-08-10T10:15:00.000Z', url: 'https://web.archive.org/web/20220810101500id_/https://github.com/devka' },
      { timestamp: '20240920101500', at: '2024-09-20T10:15:00.000Z', url: 'https://web.archive.org/web/20240920101500id_/https://github.com/devka' },
    ]);
  });
});

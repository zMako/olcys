import { describe, expect, it } from 'vitest';
import { extractAddresses, makeIdentifier, type ConnectorContext, type FetchInit, type FetchedResource, type SourceItem } from '@olcys/core';
import { createEnsNameService, createEsploraConnector, createEvmRpcConnector, createFarcasterConnector, createGithubConnector, createKeybaseConnector, createWaybackConnector, decodeString, namehash, selector, transfersFromTx } from '../src';
import { signFarcasterClaim, toEip55 } from '@olcys/core';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

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

describe('signals from live sources', () => {
  it('GitHub: logins that contain the nick, and the fingerprints of an account\'s public keys', async () => {
    const api = 'https://api.github.com';
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
    const { ctx, asked } = fakeNet({
      [`${api}/search/users`]: { items: [{ login: 'devka' }, { login: 'devka-labs' }, { login: 'DevkaTools' }] },
      [`${api}/users/devka-labs/keys`]: [{ id: 1, key }],
      [`${api}/users/devka-labs/repos`]: [],
      [`${api}/users/devka-labs`]: { login: 'devka-labs', type: 'User', name: null, bio: null, blog: null, email: null, location: null, twitter_username: null, html_url: 'https://github.com/devka-labs', created_at: '2024-01-01T00:00:00Z' },
    });
    const gh = createGithubConnector();
    expect(await gh.enumerate!(makeIdentifier('username', 'devka'), ctx)).toEqual(['devka-labs', 'DevkaTools']);
    expect(asked[0].url).toContain(encodeURIComponent('devka in:login'));
    expect(await gh.enumerate!(makeIdentifier('username', 'ab'), ctx)).toEqual([]); // too short to mean anything

    const [profile] = await collect(gh.search(makeIdentifier('username', 'devka-labs'), ctx));
    expect(profile.fingerprints).toEqual([{ kind: 'ssh_key', value: expect.stringMatching(/^SHA256:/), sourceUrl: 'https://github.com/devka-labs.keys' }]);
  });

  it('Ethereum: asks an indexer which address created a contract, when one is configured', async () => {
    const rpc = 'https://node.example/rpc';
    const creator = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const { ctx } = fakeNet({ 'https://indexer.example/api/v2/addresses/': { creator_address_hash: creator.toLowerCase(), creation_transaction_hash: '0xabc' } });
    expect(createEvmRpcConnector(rpc).getCreator).toBeUndefined();
    const evm = createEvmRpcConnector(rpc, { indexer: 'https://indexer.example/' });
    expect(evm.descriptor.hosts).toEqual(['node.example', 'indexer.example']);
    expect(await evm.getCreator!('ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7', ctx)).toMatchObject({ contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', creator, txHash: '0xabc' });
  });
});

describe('accounts that sign for their addresses', () => {
  // A wallet made for the test: the claim is signed with its key exactly as a real wallet signs one.
  const key = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  const wallet = toEip55(bytesToHex(keccak_256(secp256k1.getPublicKey(hexToBytes(key), false).slice(1)).slice(-20)));
  const blockHash = '0x63b7b8ab38a49f0571f36572533c4197a1f265a422efcef3454cb7c6ed81f7d1';
  const b64 = (hex: string) => Buffer.from(hex.slice(2), 'hex').toString('base64');
  const claim = (address: string, signature: string, type = 0) => ({ data: { timestamp: 137115720, verificationAddAddressBody: { address: address.toLowerCase(), claimSignature: signature, blockHash, type, protocol: 'PROTOCOL_ETHEREUM' } } });

  it('Farcaster: profile, wallets with claims checked here, other accounts, and posts', async () => {
    const api = 'https://api.farcaster.xyz';
    const node = 'https://snap.farcaster.xyz:3381';
    const good = b64(signFarcasterClaim({ fid: 4242, address: wallet, blockHash }, key));
    const forged = b64(signFarcasterClaim({ fid: 9999, address: wallet, blockHash }, key)); // signed for another account
    const { ctx, asked } = fakeNet({
      [`${api}/v2/user-by-username?username=ania`]: { result: {
        user: { fid: 4242, username: 'ania', displayName: 'Ania', profile: { bio: { text: 'Buduję w sieci.' }, location: { description: 'Gdańsk, Poland' }, url: 'https://ania.example.pl' }, followerCount: 10, followingCount: 5, connectedAccounts: [{ platform: 'x', username: 'ania_x', expired: false }, { platform: 'github', username: 'ania-dev', expired: true }] },
        extras: { custodyAddress: ETH, ethWallets: [wallet] },
      } },
      [`${node}/v1/verificationsByFid`]: { messages: [
        claim(wallet, good),
        claim(ETH, forged),
        { data: { timestamp: 1, verificationAddAddressBody: { address: 'Gxt817xZ8B91RQ9sAiqaovDi457k5xqS4xsUcr2Vt8NV', claimSignature: 'AA==', blockHash: 'x', type: 0, protocol: 'PROTOCOL_SOLANA' } } },
      ] },
      [`${node}/v1/castsByFid`]: { messages: [
        { hash: '0xabcdef0123456789', data: { timestamp: 185640207, castAddBody: { text: 'Sprzedałam wczoraj 2 ETH', parentUrl: 'https://farcaster.xyz/~/channel/polska' } } },
        { hash: '0x1111111111111111', data: { timestamp: 185640300, castAddBody: { text: '   ' } } },
      ] },
    });
    const fc = createFarcasterConnector();
    expect(fc.descriptor.hosts).toEqual(['api.farcaster.xyz', 'snap.farcaster.xyz:3381']);
    expect(fc.supports(makeIdentifier('profile_url', 'https://warpcast.com/ania'))).toBe(true);
    expect(fc.supports(makeIdentifier('profile_url', 'https://example.com/ania'))).toBe(false);
    const [profile, post, ...rest] = await collect(fc.search(makeIdentifier('username', 'Ania'), ctx));
    expect(rest).toEqual([]);
    expect(profile).toMatchObject({ url: 'https://farcaster.xyz/ania', resourceId: 'fid:4242', docType: 'profile', relation: 'profile_owner', author: { handle: 'ania', displayName: 'Ania' }, container: { section: 'Gdańsk, Poland' } });
    expect(extractAddresses(profile.segments.find((x) => x.kind === 'contact')!.text).map((m) => m.address).sort()).toEqual([wallet, ETH].sort());
    // an expired connection is not a lead; the custody address is not shown as the person's wallet
    expect(profile.discovered.map((d) => d.value)).toEqual(['https://ania.example.pl', 'https://x.com/ania_x']);
    // the claim signed by the wallet for this account holds; a signature made for another account does not
    expect(profile.attestations).toEqual([
      expect.objectContaining({ chain: 'ethereum', address: wallet, valid: true }),
      expect.objectContaining({ chain: 'ethereum', address: ETH, valid: false, reason: 'podpis nie pochodzi od tego adresu' }),
    ]);
    expect(profile.attestations![0].message).toContain('konta ania');
    expect(profile.attestations![0].attestedBy).toBeUndefined();
    expect(post).toMatchObject({ docType: 'post', relation: 'author', publishedAt: '2026-11-19T14:43:27.000Z', url: 'https://farcaster.xyz/ania/0xabcdef01', segments: [{ kind: 'body', text: 'Sprzedałam wczoraj 2 ETH' }] });
    expect(asked).toHaveLength(3);
    // nothing is asked for a name the network cannot have
    expect(await collect(fc.search(makeIdentifier('username', 'to_nie_jest_nazwa_farcaster'), ctx))).toEqual([]);
  });

  it('Keybase: accounts proven on other services and addresses signed with the account key', async () => {
    const api = 'https://keybase.io/_/api/1.0';
    const user = {
      basics: { username: 'ewa_r' }, profile: { full_name: 'Ewa Rzecka', location: 'Radom', bio: 'Programistka.' },
      proofs_summary: { all: [
        { proof_type: 'github', nametag: 'devka', state: 1, service_url: 'https://github.com/devka', proof_url: 'https://gist.github.com/x' },
        { proof_type: 'twitter', nametag: 'stare', state: 2, service_url: 'https://twitter.com/stare', proof_url: 'https://twitter.com/stare/status/1' },
      ] },
      cryptocurrency_addresses: { bitcoin: [{ address: BTC, sig_id: 'abc123' }], zcash: [{ address: 't1KiyNNYFy7jEEFsveRJjTaDzE1MtfT2FSx', sig_id: 'z' }] },
    };
    const { ctx, asked } = fakeNet({
      [`${api}/user/lookup.json?usernames=devka`]: { them: [null] },
      [`${api}/user/lookup.json?github=devka`]: { them: [user] },
      [`${api}/user/lookup.json?twitter=devka`]: { them: [user] },
    });
    const items = await collect(createKeybaseConnector().search(makeIdentifier('username', 'devka'), ctx));
    expect(asked).toHaveLength(3);
    expect(items).toHaveLength(1); // the same Keybase account reached twice is one account
    expect(items[0]).toMatchObject({ url: 'https://keybase.io/ewa_r', author: { handle: 'ewa_r', displayName: 'Ewa Rzecka' }, relation: 'profile_owner' });
    expect(items[0].discovered.map((d) => `${d.kind}:${d.value}`)).toEqual(['profile_url:https://github.com/devka', 'full_name:Ewa Rzecka']); // a broken proof is not a lead
    expect(items[0].attestations).toEqual([expect.objectContaining({ chain: 'bitcoin', address: BTC, valid: true, attestedBy: 'Keybase' })]);
    expect(extractAddresses(items[0].segments.find((x) => x.kind === 'contact')!.text).map((m) => m.address)).toEqual([BTC]);
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

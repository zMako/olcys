import { describe, expect, it } from 'vitest';
import type { ConnectorContext, FetchInit, FetchedResource } from '@olcys/core';
import { BABT_CONTRACT, babtHolderUrl, binanceAttestations, decodeBabt, encodeBabtCalls } from '../src/babt';
import { EAS_ATTESTERS, EAS_BASE, decodeAttestationData, describeAttestation, readAttestationRows, walletAttestations } from '../src/eas';
import { coinbaseAttestations } from '../src/evm';

/** A stand-in for the network: one canned answer per host, and a record of what was asked. */
function fakeNet(answer: (url: string, init?: FetchInit) => unknown) {
  const asked: { url: string; init?: FetchInit }[] = [];
  const ctx: ConnectorContext = {
    log: () => {},
    async fetch(url, init): Promise<FetchedResource> {
      asked.push({ url, init });
      return { snapshotId: `snap-${asked.length}`, url, status: 200, contentType: 'application/json', body: JSON.stringify(answer(url, init)), sha256: '', fetchedAt: '2026-11-22T00:00:00.000Z' };
    },
  };
  return { ctx, asked };
}

// The index's "decoded data": a list of fields, each wrapped twice. Shapes below are copied from real answers.
const field = (name: string, type: string, value: unknown) => ({ name, type, signature: `${type} ${name}`, value: { name, type, value } });
const data = (...fields: unknown[]) => JSON.stringify(fields);
const stamps = (...providers: string[]) => providers.map((p) => [{ name: 'provider', type: 'string', value: p }, { name: 'score', type: 'uint256', value: { type: 'BigNumber', hex: '0x2710' } }]);

const COINBASE = '0x357458739F90461b99789350868CD7CF330Dd7EE';
const PASSPORT = '0xCc90105D4A2aa067ee768120AdA19886021dF422';
const BONDEX = '0x1aE9c5732aB62d7BE70d087F23Bcc1cca33ddac9';
const LINK3 = '0x2A2EA826102c067ECE82Bc6E2B7cf38D7EbB1B82';
const S = {
  account: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
  country: '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065',
  one: '0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4',
  passport: '0x1f3dce6501d8aad23563c0cf4f0c32264aed9311cb050056ebf72774f89ba912',
  bondex: '0xf3ff6dd4a9dab34450af4e60df1eb41ca1e60fd719ce8645bbbed68aa84b489f',
  link3: '0xcfcf329b79035809704e8d33780714ddf7815a06490a94d57fac562937edbcef',
};
const row = (id: string, attester: string, schemaId: string, name: string, time: number, decodedDataJson: string, expirationTime = 0) => ({ id, attester, time, expirationTime, schemaId, decodedDataJson, schema: { schemaNames: name ? [{ name }] : [] } });
const WALLET = '0x60EDB7CfB31C85d69A94DA6491f37F3067CECFEC';
const NOW = Date.parse('2026-11-22T00:00:00Z');

describe('attestations about a wallet (Ethereum Attestation Service)', () => {
  const coinbaseRows = [
    row('0x859909d5dec4988f1df388086bda7739ab10cc38c8b14b43b795bb514da73a95', COINBASE, S.country, 'Verified Country', 1758096859, data(field('verifiedCountry', 'string', 'PL'))),
    row('0xfe7ece8b240833e1e03477e85c0a2c15ed4c8a43cea333a04991b82c386b216c', COINBASE, S.account, 'Verified Account', 1717764591, data(field('verifiedAccount', 'bool', true))),
    row('0x11', COINBASE, S.one, 'Verified Coinbase One', 1717764600, data(field('verifiedCoinbaseOne', 'bool', true))),
  ];

  it('returns everything the Coinbase-only reader returns, and more', async () => {
    const net = fakeNet(() => ({ data: { attestations: coinbaseRows } }));
    const all = await walletAttestations(EAS_BASE, WALLET, net.ctx);
    const coinbase = await coinbaseAttestations(EAS_BASE, WALLET, net.ctx);
    expect(coinbase).toHaveLength(2);
    for (const c of coinbase) expect(all).toContainEqual(c);
    expect(all.map((a) => [a.issuer, a.claim, a.value])).toEqual([
      ['Coinbase', 'verified_country', 'PL'],
      ['Coinbase', 'verified_coinbase_one', undefined],
      ['Coinbase', 'verified_account', undefined],
    ]);
    expect(all[0].sourceUrl).toBe('https://base.easscan.org/attestation/view/0x859909d5dec4988f1df388086bda7739ab10cc38c8b14b43b795bb514da73a95');
    expect(all[0].at).toBe('2025-09-17T08:14:19.000Z');
    // By default only the attesters we can name are asked for, so junk attestations cannot crowd them out.
    const query = JSON.parse(net.asked[0].init!.body!).query as string;
    for (const attester of Object.keys(EAS_ATTESTERS)) expect(query).toContain(attester);
    expect(query).toContain('revoked: { equals: false }');
  });

  it('reads a proof of personhood once, with the identities behind it, and drops expired ones', () => {
    const rows = [
      row('0xnew', PASSPORT, S.passport, 'Human Passport', 1795282701, data(field('passing_score', 'bool', true), field('score', 'uint32', 503040), field('stamps', '(string,uint256)[]', stamps('NFT', 'ETHScore#75', 'HolonymGovIdProvider', 'BinanceBABT2', 'githubContributionActivityGte#30', 'githubContributionActivityGte#60', 'Google'))), 1803058701),
      row('0xold', PASSPORT, S.passport, 'Human Passport', 1790000000, data(field('passing_score', 'bool', true), field('stamps', '(string,uint256)[]', stamps('Discord'))), 1799867194),
      row('0xexpired', PASSPORT, S.passport, 'Human Passport', 1700000000, data(field('passing_score', 'bool', true), field('stamps', '(string,uint256)[]', stamps('Linkedin'))), 1710000000),
    ];
    const out = readAttestationRows(rows, WALLET, 'https://base.easscan.org', { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ issuer: 'Human Passport', claim: 'proof_of_personhood', value: 'HolonymGovIdProvider, BinanceBABT, Github, Google', uid: '0xnew' });
    expect(describeAttestation(out[0])).toContain('dokument tożsamości (Holonym)');
    // Without a passing score the stamps still say which identities the owner confirmed.
    const failing = readAttestationRows([row('0xf', PASSPORT, S.passport, 'Human Passport', 1795282701, data(field('passing_score', 'bool', false), field('stamps', '(string,uint256)[]', stamps('NFT', 'Linkedin'))))], WALLET, 'https://x', { now: NOW });
    expect(failing.map((a) => [a.claim, a.value])).toEqual([['identity_stamps', 'Linkedin']]);
    expect(readAttestationRows([row('0xn', PASSPORT, S.passport, 'Human Passport', 1795282701, data(field('passing_score', 'bool', false), field('stamps', '(string,uint256)[]', stamps('NFT'))))], WALLET, 'https://x', { now: NOW })).toEqual([]);
  });

  it('reads identity checks and linked accounts, and ignores attestations that say nothing about the owner', () => {
    const bondex = (id: string, time: number, type: string, context: string) => row(id, BONDEX, S.bondex, 'BONDEX VERIFICATIONS', time, data(field('issuance_date', 'uint64', String(time)), field('user_address', 'address', WALLET), field('verification_type', 'string', type), field('context', 'string', context)));
    const rows = [
      bondex('0xb1', 1782923952, 'didit', 'KYC Complete'),
      bondex('0xb2', 1768569013, 'github', 'Verified Account'),
      bondex('0xb3', 1768291669, 'twitter', 'Verified Account'),
      bondex('0xb4', 1768291000, 'bdx_resume', 'Verified Resume'),
      bondex('0xb5', 1768290000, 'wallet_activity', 'Token Swapper'),
      bondex('0xb6', 1768200000, 'github', 'Verified Account'),
      row('0xl1', LINK3, S.link3, '', 1711500000, data(field('cyberID', 'string', 'cerboai'), field('twitterHandle', 'string', 'CerboAI'), field('profileLink', 'string', 'https://link3.to/cerboai'), field('issuer', 'address', WALLET))),
    ];
    const out = readAttestationRows(rows, WALLET, 'https://base.easscan.org', { now: NOW });
    expect(out.map((a) => [a.issuer, a.claim, a.value, a.uid])).toEqual([
      ['Bondex', 'identity_check', 'Didit', '0xb1'],
      ['Bondex', 'linked_account', 'github', '0xb2'],
      ['Bondex', 'linked_account', 'x', '0xb3'],
      ['Link3 (CyberConnect)', 'linked_account', 'x:CerboAI link3:cerboai', '0xl1'],
    ]);
    expect(describeAttestation(out[3])).toBe('Link3 (CyberConnect) poświadcza, że właściciel adresu kontroluje konto: x: CerboAI, link3: cerboai');
  });

  it('does not take a stranger’s attestation for an institution’s, even when it copies the institution’s form', async () => {
    const forged = row('0xforged', '0x82b0935c3A7C7D9A0dE5ac5A0aA1D3F1B2C37C23', S.country, 'Verified Country', 1795282701, data(field('verifiedCountry', 'string', 'PL')));
    expect(readAttestationRows([forged], WALLET, 'https://base.easscan.org', { now: NOW })).toEqual([]);
    const net = fakeNet(() => ({ data: { attestations: [forged, coinbaseRows[1]] } }));
    const out = await walletAttestations(EAS_BASE, WALLET, net.ctx, { unknown: true });
    expect(out.map((a) => [a.issuer, a.claim, a.value])).toEqual([
      ['0x82b0…7C23', 'Verified Country', undefined],
      ['Coinbase', 'verified_account', undefined],
    ]);
    expect(JSON.parse(net.asked[0].init!.body!).query).not.toContain('attester: {');
  });

  it('copes with unreadable data and bad input', async () => {
    expect(decodeAttestationData('not json')).toEqual({});
    expect(readAttestationRows([row('0x1', COINBASE, S.country, 'Verified Country', 1, 'not json')], WALLET, 'https://x')).toEqual([]);
    const net = fakeNet(() => ({ errors: [{ message: 'boom' }] }));
    expect(await walletAttestations(EAS_BASE, WALLET, net.ctx)).toEqual([]);
    expect(await walletAttestations(EAS_BASE, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', net.ctx)).toEqual([]);
    expect(net.asked).toHaveLength(1);
  });
});

describe('Binance account-bound token', () => {
  const HOLDER = '0xb0497e6314a527bd68A4a20D160E7340Fc621724';
  const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

  it('encodes the two calls and reads their answers', () => {
    const calls = encodeBabtCalls(HOLDER);
    expect(calls.map((c) => (c.params[0] as { to: string; data: string }).data)).toEqual([
      '0x70a08231000000000000000000000000b0497e6314a527bd68a4a20d160e7340fc621724',
      '0x773c02d4000000000000000000000000b0497e6314a527bd68a4a20d160e7340fc621724',
    ]);
    expect((calls[0].params[0] as { to: string }).to).toBe(BABT_CONTRACT);
    expect(decodeBabt(word(1n), word(1019257n))).toEqual({ holds: true, tokenId: '1019257' });
    expect(decodeBabt(word(0n), undefined)).toEqual({ holds: false, tokenId: undefined });
    expect(decodeBabt(undefined, undefined)).toEqual({ holds: false, tokenId: undefined });
    expect(decodeBabt(word(1n), undefined)).toEqual({ holds: true, tokenId: undefined });
  });

  it('turns a held token into an attestation by Binance, and no token into nothing', async () => {
    const holder = fakeNet(() => [{ jsonrpc: '2.0', id: 1, result: word(1n) }, { jsonrpc: '2.0', id: 2, result: word(1019257n) }]);
    expect(await binanceAttestations('https://bsc.example', HOLDER, holder.ctx)).toEqual([
      { chain: 'ethereum', address: HOLDER, issuer: 'Binance', claim: 'verified_account', uid: 'BABT-1019257', sourceUrl: babtHolderUrl(HOLDER) },
    ]);
    expect(holder.asked).toHaveLength(1);
    // The contract refuses to name a token for an address that has none; that is an answer, not a failure.
    const nobody = fakeNet(() => [{ jsonrpc: '2.0', id: 1, result: word(0n) }, { jsonrpc: '2.0', id: 2, error: { code: 3, message: 'execution reverted: The wallet has not attested any SBT' } }]);
    expect(await binanceAttestations('https://bsc.example', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', nobody.ctx)).toEqual([]);
    expect(await binanceAttestations('https://bsc.example', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', nobody.ctx)).toEqual([]);
  });
});

import { gzipSync } from 'node:zlib';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { keywordsIn, parseSurt, parseWarc, scanPage, tldOf, hostOf, type WarcRecord } from '../src';

const record = (headers: Record<string, string>, body: string) => {
  const bytes = Buffer.from(body, 'utf8');
  const head = ['WARC/1.0', ...Object.entries({ ...headers, 'Content-Length': String(bytes.length) }).map(([k, v]) => `${k}: ${v}`)].join('\r\n');
  return Buffer.concat([Buffer.from(`${head}\r\n\r\n`), bytes, Buffer.from('\r\n\r\n')]);
};
const collect = async (stream: AsyncIterable<Uint8Array>) => {
  const out: WarcRecord[] = [];
  for await (const r of parseWarc(stream)) out.push({ headers: r.headers, body: Buffer.from(r.body) });
  return out;
};

describe('reading the crawl archive', () => {
  const pages = [
    record({ 'WARC-Type': 'warcinfo' }, 'software: test'),
    record({ 'WARC-Type': 'conversion', 'WARC-Target-URI': 'https://forum.example.pl/watek/1', 'WARC-Identified-Content-Language': 'pol,eng' }, 'Zażółć gęślą jaźń — wpłaty na adres poniżej'),
    record({ 'WARC-Type': 'conversion', 'WARC-Target-URI': 'https://example.com/' }, ''),
    record({ 'WARC-Type': 'conversion', 'WARC-Target-URI': 'https://example.org/b' }, 'x'.repeat(70_000)),
  ];

  it('reads records whatever way the bytes are cut into chunks', async () => {
    const whole = Buffer.concat(pages);
    for (const size of [1, 7, 1024, whole.length]) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < whole.length; i += size) chunks.push(whole.subarray(i, i + size));
      const got = await collect(Readable.from(chunks));
      expect(got.map((r) => r.headers['warc-type'])).toEqual(['warcinfo', 'conversion', 'conversion', 'conversion']);
      expect(got[1].headers['warc-target-uri']).toBe('https://forum.example.pl/watek/1');
      expect(got[1].body.toString('utf8')).toBe('Zażółć gęślą jaźń — wpłaty na adres poniżej');
      expect(got[2].body.length).toBe(0);
      expect(got[3].body.length).toBe(70_000);
    }
  });

  it('reads a file made of separately compressed records, as the archive stores them', async () => {
    const file = Buffer.concat(pages.map((p) => gzipSync(p)));
    const got = await collect(Readable.from([file]).pipe(createGunzip()));
    expect(got).toHaveLength(4);
    expect(got[3].headers['warc-target-uri']).toBe('https://example.org/b');
  });
});

describe('address filter', () => {
  const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const scan = (text: string) => scanPage(Buffer.from(text, 'utf8'));

  it('keeps checksum-valid addresses with the words around them, Polish letters intact', () => {
    const r = scan(`Żółta łódź. Darowizny proszę wysyłać na mój adres ${BTC} — dziękuję! A tu ETH: ${ETH}.`);
    expect(r.mentions.map((m) => [m.chain, m.address, m.checksum])).toEqual([['bitcoin', BTC, 'valid'], ['ethereum', ETH, 'valid']]);
    expect(r.mentions[0].context).toContain('Żółta łódź. Darowizny proszę wysyłać na mój adres');
    expect(r.mentions[0].context).toContain('dziękuję');
  });

  it('throws away look-alikes: wrong checksum, hashes, longer strings', () => {
    expect(scan('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3 oraz bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5').mentions).toEqual([]);
    expect(scan('tx 0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060').mentions).toEqual([]);
    expect(scan(`x${BTC}y i sha1 da39a3ee5e6b4b0d3255bfef95601890afd80709`).mentions).toEqual([]);
    expect(scan('Zwykła strona o gotowaniu bez żadnych adresów.')).toEqual({ occurrences: 0, mentions: [] });
  });

  it('counts repeats but keeps each address once', () => {
    const r = scan(`${BTC} ${BTC}\n${BTC}`);
    expect(r.occurrences).toBe(3);
    expect(r.mentions).toHaveLength(1);
  });

  it('marks lower-case Ethereum addresses as having no checksum', () => {
    expect(scan(ETH.toLowerCase()).mentions[0]).toMatchObject({ address: ETH, checksum: 'absent' });
  });
});

describe('seeds from URLs', () => {
  it('reads the index key back into a host and a path', () => {
    expect(parseSurt('pl,bitcoin,forum)/watek/12?strona=2')).toEqual({ host: 'forum.bitcoin.pl', path: '/watek/12?strona=2' });
    expect(parseSurt('com,example,www:8080)/')).toEqual({ host: 'example.com', path: '/' });
    expect(parseSurt('0,100,22,165)/')).toEqual({ host: '165.22.100.0', path: '/' });
    expect(parseSurt('nonsense')).toBeUndefined();
    expect(tldOf('pl,bitcoin,forum)/')).toBe('pl');
    expect(hostOf('https://WWW.Example.PL/a?b#c')).toBe('example.pl');
  });

  it('matches long keywords inside words and short ones only as whole words', () => {
    expect(keywordsIn('forum-kryptowaluty.example.pl')).toEqual(expect.arrayContaining(['krypto', 'waluty']));
    expect(keywordsIn('btc-kantor24.pl').sort()).toEqual(['btc', 'kantor']);
    expect(keywordsIn('/dzial/eth/watek')).toEqual(['eth']);
    expect(keywordsIn('methodist-church.org')).toEqual([]);
    expect(keywordsIn('przepisy-kulinarne.pl/zupa')).toEqual([]);
  });
});

describe('pages from the archive', () => {
  it('turns markup into readable text', async () => {
    const { htmlToText, linkedHostsOf, charsetOf, parseArchivedResponse } = await import('../src');
    const html = '<html><head><style>p{color:red}</style><script>var a = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";</script></head><body><p>Wp&#322;aty na <b>m&oacute;j</b> adres:&nbsp;bc1q&hellip;</p><div>Dzi&#x119;ki &amp; pozdrawiam</div><a href="https://Forum.Example.org/t/1">forum</a><a href="/lokalny">x</a><a href="https://sub.moja.pl/a">y</a></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('Wpłaty na mój adres: bc1q…');
    expect(text).toContain('Dzięki & pozdrawiam');
    expect(text).not.toContain('var a');
    expect(linkedHostsOf(html, 'moja.pl')).toEqual(['forum.example.org']);
    expect(charsetOf('HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=ISO-8859-2', '')).toBe('iso-8859-2');
    expect(charsetOf('HTTP/1.1 200 OK', '<meta charset="windows-1250">')).toBe('windows-1250');
    expect(charsetOf('HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=nonsense', '')).toBe('utf-8');

    const stored = Buffer.from('WARC/1.0\r\nWARC-Type: response\r\nContent-Length: 60\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<p>ok</p>');
    expect(parseArchivedResponse(stored)).toMatchObject({ status: 200 });
    expect(parseArchivedResponse(stored)!.body.toString()).toBe('<p>ok</p>');
    expect(parseArchivedResponse(Buffer.from('WARC/1.0\r\nWARC-Type: request\r\n\r\nGET / HTTP/1.1\r\n\r\n'))).toBeUndefined();
  });
});

describe('Polish accounts', () => {
  it('tells Polish text from other languages', async () => {
    const { isPolishText, polishShare, mentionsPoland } = await import('../src');
    expect(isPolishText('Cześć, jestem programistą z Krakowa i lubię kryptowaluty')).toBe(true);
    expect(isPolishText('Inwestor, nie doradca. Tylko moje zdanie.')).toBe(true);
    expect(isPolishText('Building onchain things. To the moon, no doubt about it.')).toBe(false);
    expect(isPolishText('Desarrollador de software en Madrid, me gusta el café')).toBe(false);
    expect(isPolishText('gm')).toBe(false);
    expect(polishShare('').words).toBe(0);
    expect(mentionsPoland('english speaking channel for everything related to poland')).toBe(true);
    expect(mentionsPoland('Connect with nail lovers. Let’s polish and share')).toBe(false);
    expect(mentionsPoland('polski degen')).toBe(true);
    expect(mentionsPoland('Polish Mafia community 🇵🇱')).toBe(true);
  });

  it('weighs location, language, flag and website, and keeps the reasons', async () => {
    const { polishSignals } = await import('../src');
    expect(polishSignals({ location: 'Warsaw, Poland', bio: 'studying' })).toMatchObject({ score: 0.6, reasons: ['podana lokalizacja: Warsaw, Poland'] });
    expect(polishSignals({ bio: 'Buduję rzeczy w sieci. Tylko po polsku.', url: 'https://example.pl/o-mnie' }).score).toBe(0.8);
    expect(polishSignals({ location: 'Lisbon, Portugal', bio: 'gm frens' }).score).toBe(0);
    expect(polishSignals({ name: 'Ania 🇵🇱', bio: 'NFT artist' }).score).toBe(0.4); // a flag alone is not enough
    const posts = ['Dzień dobry wszystkim, jak się macie', 'Ktoś jeszcze nie śpi o tej porze', 'gm', 'Właśnie kupiłem trochę więcej', 'great project'];
    expect(polishSignals({ texts: posts })).toMatchObject({ score: 0.6 });
  });
});

describe('the local index: from an address or a nick on another service to the account', () => {
  it('finds the account, fetches it afresh, and drops ties that no longer hold', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { makeIdentifier } = await import('@olcys/core');
    const { createCorpusConnector, loadCorpusIndex } = await import('../src');
    const dir = mkdtempSync(`${tmpdir()}/olcys-corpus-`);
    mkdirSync(`${dir}/farcaster`);
    const wallet = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const gone = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
    const record = { fid: 77, username: 'ania', followers: 1, following: 1, wallets: [wallet, gone], connected: [{ platform: 'x', username: 'Ania_X' }], polish: { score: 0.6, reasons: [] }, via: 'kanał polska', fetchedAt: '2026-11-21T00:00:00.000Z' };
    writeFileSync(`${dir}/farcaster/profiles.jsonl`, JSON.stringify(record) + '\n');
    writeFileSync(`${dir}/farcaster/enrichment.jsonl`, JSON.stringify({ fid: 77, ens: [{ address: wallet, name: 'ania.eth', records: {} }], keybase: [{ username: 'ania_kb', via: 'x:Ania_X', proofs: [{ service: 'github', handle: 'ania-dev' }], bitcoin: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'] }], at: '2026-11-21T00:00:00.000Z' }) + '\n');

    const index = loadCorpusIndex(dir);
    expect(index).toMatchObject({ accounts: 1, addresses: 2 });
    expect([...index.byAnyHandle.keys()].sort()).toEqual(['ania', 'ania-dev', 'ania.eth', 'ania_kb', 'ania_x']);
    expect(index.people.get(77)).toMatchObject({ keybase: ['ania_kb'], names: [{ name: 'ania.eth', address: wallet }], bitcoin: ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'] });

    const asked: string[] = [];
    // today the account lists only one of the two wallets, and the X account is still connected
    const live = { result: { user: { fid: 77, username: 'ania', profile: { bio: { text: 'x' } }, connectedAccounts: [{ platform: 'x', username: 'Ania_X', expired: false }] }, extras: { ethWallets: [wallet] } } };
    const ctx = { log: () => {}, fetch: async (url: string) => (asked.push(url), { snapshotId: 's1', url, status: 200, contentType: 'application/json', body: JSON.stringify(live), sha256: '', fetchedAt: '' }) };
    const c = createCorpusConnector(dir);
    const all = async (kind: 'crypto_address' | 'username', value: string) => {
      const out = [];
      for await (const x of c.search(makeIdentifier(kind, value), ctx)) out.push(x);
      return out;
    };
    expect(c.supports(makeIdentifier('crypto_address', wallet))).toBe(true);
    expect(c.supports(makeIdentifier('crypto_address', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB'))).toBe(false);
    // an address: the account is a publisher of it, read afresh from the network
    expect(await all('crypto_address', wallet)).toEqual([expect.objectContaining({ resourceId: 'fid:77', relation: 'mention', snapshotId: 's1' })]);
    // an address the account has since removed is not reported
    expect(await all('crypto_address', gone)).toEqual([]);
    // the nick the person holds on X leads to their account, with the Keybase account as a lead
    const [byX] = await all('username', 'ania_x');
    expect(byX).toMatchObject({ relation: 'profile_owner', author: { handle: 'ania' } });
    expect(byX.discovered.map((d) => d.value)).toContain('https://keybase.io/ania_kb');
    expect(byX.discovered.map((d) => d.value)).toContain('https://farcaster.xyz/ania'); // so that the live connector reads the claims and posts
    // a nick proven on Keybase counts too, and so does the on-chain name of a wallet that is still attached
    expect(await all('username', 'ania-dev')).toHaveLength(1);
    expect(await all('username', 'ania.eth')).toHaveLength(1);
    // the account's own name is left to the live connector
    expect(await all('username', 'ania')).toEqual([]);
    expect(asked.every((u) => u === 'https://api.farcaster.xyz/v2/user-by-fid?fid=77')).toBe(true);
  });
});

describe('locations given as coordinates', () => {
  it('places Polish cities inside the outline and neighbouring capitals outside', async () => {
    const { inPoland, nearestCity, parseGeo, polishSignals } = await import('../src');
    const inside: [string, number, number][] = [['Warszawa', 52.23, 21.01], ['Kraków', 50.06, 19.94], ['Gdańsk', 54.35, 18.65], ['Szczecin', 53.43, 14.55], ['Rzeszów', 50.04, 22.0], ['Białystok', 53.13, 23.16], ['Wrocław', 51.11, 17.03], ['Zakopane', 49.3, 19.95], ['Suwałki', 54.1, 22.93]];
    const outside: [string, number, number][] = [['Berlin', 52.52, 13.4], ['Praga', 50.08, 14.44], ['Lwów', 49.84, 24.03], ['Wilno', 54.69, 25.28], ['Kaliningrad', 54.71, 20.51], ['Brześć', 52.1, 23.7], ['Bratysława', 48.15, 17.11], ['Grodno', 53.68, 23.83], ['Londyn', 51.5, -0.12]];
    for (const [name, lat, lon] of inside) expect(inPoland(lat, lon), name).toBe(true);
    for (const [name, lat, lon] of outside) expect(inPoland(lat, lon), name).toBe(false);
    expect(nearestCity(52.25, 21.0)).toEqual({ city: 'Warszawa', km: 2 });
    expect(parseGeo('geo:52.23,21.01')).toEqual({ lat: 52.23, lon: 21.01 });
    expect(parseGeo('Warsaw')).toBeUndefined();
    expect(polishSignals({ geo: { lat: 52.23, lon: 21.01 }, bio: 'studying' })).toEqual({ score: 0.6, reasons: ['podana lokalizacja w Polsce (Warszawa)'] });
    expect(polishSignals({ geo: { lat: 52.52, lon: 13.4 }, bio: 'studying' }).score).toBe(0);
  });
});

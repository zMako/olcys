import { describe, expect, it } from 'vitest';
import { emailHashes, makeIdentifier, similarHandle, avatarFingerprint, sshKeyFingerprint } from '@olcys/core';
import { DEFAULT_RULESET, assess, binomialAtMost, compareRhythm, quietWindow, warsawHour, type DocFact, type RunFacts } from '../src';

const profile = (origin: string, handle: string, extra: Partial<DocFact> = {}): DocFact => ({
  id: `${origin}:${handle}`, origin, connectorId: origin, url: `https://${origin}.test/${handle}`, docType: 'profile', authorHandle: handle,
  authorProfileUrl: `https://${origin}.test/${handle}`, relation: 'profile_owner', discovered: [], fetchedAt: '2026-01-01T00:00:00.000Z', snapshotSha256: 'x', ...extra,
});
const hit = (d: DocFact, kind: 'username' | 'email', value: string) => ({ documentId: d.id, identifier: makeIdentifier(kind, value), relation: 'profile_owner' });
const facts = (f: Partial<RunFacts>): RunFacts => ({ seeds: [], documents: [], hits: [], mentions: [], accounts: [], ...f });

describe('similar nicks', () => {
  it('needs containment and a stem long enough to mean something', () => {
    expect(similarHandle('szklane_domy', 'szklanedomy-labs')).toBe(true);
    expect(similarHandle('szklanedomy-labs', 'szklane_domy')).toBe(true);
    expect(similarHandle('szklane_domy', 'SzklaneDomy')).toBe(false); // the same nick in another spelling is a variant, not a look-alike
    expect(similarHandle('btc', 'btc_krol')).toBe(false);
    expect(similarHandle('krypto_wilk', 'krypto_lis')).toBe(false);
  });
});

describe('fingerprints', () => {
  it('reads the e-mail hash from an avatar address and fingerprints an SSH key', () => {
    const h = emailHashes('  Jan.Kowalski@Example.com ');
    expect(h.md5).toHaveLength(32);
    expect(avatarFingerprint(`https://www.gravatar.com/avatar/${h.md5}?s=80&d=identicon`)).toMatchObject({ kind: 'email_md5', value: h.md5 });
    expect(avatarFingerprint(`https://secure.gravatar.com/avatar/${h.sha256}`)).toMatchObject({ kind: 'email_sha256', value: h.sha256 });
    expect(avatarFingerprint('https://avatars.example.com/u/1234')).toBeUndefined();
    expect(sshKeyFingerprint('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl jan@laptop')).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(sshKeyFingerprint('not a key')).toBeUndefined();
  });
});

describe('identity from fingerprints', () => {
  const email = 'jan.kowalski@poczta.test';
  const main = profile('forum', 'janek_kowal', { discovered: [makeIdentifier('email', email)] });
  const key = { kind: 'ssh_key' as const, value: 'SHA256:abc' };

  it('joins an account whose avatar hash is the hash of an e-mail another account lists', () => {
    const alt = profile('code', 'janek-kowal-dev', { fingerprints: [{ kind: 'email_sha256', value: emailHashes(email).sha256 }] });
    const a = assess(facts({ seeds: [makeIdentifier('username', 'janek_kowal')], documents: [main, alt], hits: [hit(main, 'username', 'janek_kowal'), hit(alt, 'username', 'janek-kowal-dev')] }));
    expect(a.clusters).toHaveLength(1);
    expect(a.clusters[0]).toMatchObject({ level: 'entered' });
    expect(a.clusters[0].joins.map((j) => j.rule)).toEqual(['J8']);
  });

  it('an entered e-mail matches an account that shows only its hash', () => {
    const alt = profile('code', 'zupelnie_inny', { fingerprints: [{ kind: 'email_md5', value: emailHashes(email).md5 }] });
    const a = assess(facts({ seeds: [makeIdentifier('email', email)], documents: [alt], hits: [hit(alt, 'username', 'zupelnie_inny')] }));
    expect(a.clusters).toEqual([expect.objectContaining({ level: 'entered', identityCap: 100 })]);
  });

  it('joins on a shared key, but not when the key sits on many accounts', () => {
    const docs = ['a', 'b'].map((h) => profile('code', `konto_${h}`, { fingerprints: [key] }));
    const seeds = [makeIdentifier('username', 'konto_a')];
    const two = assess(facts({ seeds, documents: docs, hits: docs.map((d) => hit(d, 'username', d.authorHandle!)) }));
    expect(two.clusters[0].accounts).toHaveLength(2);
    expect(two.clusters[0].joins.map((j) => j.rule)).toEqual(['J9']);

    const many = ['a', 'b', 'c', 'd'].map((h) => profile('code', `konto_${h}`, { fingerprints: [key] }));
    const four = assess(facts({ seeds, documents: many, hits: many.map((d) => hit(d, 'username', d.authorHandle!)) }));
    expect(four.clusters[0].accounts).toHaveLength(1); // a deploy key or a shared machine
  });

  it('a different hash and a different key leave a similar nick unconfirmed', () => {
    const other = profile('code', 'janek_kowal_2', { fingerprints: [{ kind: 'email_md5', value: emailHashes('ktos.inny@poczta.test').md5 }, { kind: 'ssh_key', value: 'SHA256:zzz' }] });
    const a = assess(facts({ seeds: [makeIdentifier('username', 'janek_kowal')], documents: [{ ...main, fingerprints: [key] }, other], hits: [hit(main, 'username', 'janek_kowal'), hit(other, 'username', 'janek_kowal_2')] }));
    expect(a.clusters.map((c) => [c.level, c.identityCap])).toEqual([['entered', 100], ['handle_similar', 49]]);
  });
});

describe('daily rhythm', () => {
  const at = (hourUtc: number, day = 1) => `2025-07-${String(day).padStart(2, '0')}T${String(hourUtc).padStart(2, '0')}:30:00.000Z`;

  it('uses Polish time, with daylight saving', () => {
    expect(warsawHour('2025-07-01T22:30:00.000Z')).toBe(0);
    expect(warsawHour('2025-01-01T22:30:00.000Z')).toBe(23);
  });

  it('finds the quietest stretch, also across midnight', () => {
    const hist = Array<number>(24).fill(2);
    for (const h of [23, 0, 1, 2, 3, 4, 5]) hist[h] = 0;
    expect(quietWindow(hist, 7)).toMatchObject({ from: 23, to: 6, webInside: 0 });
  });

  it('binomial tail', () => {
    expect(binomialAtMost(10, 0, 0.5)).toBeCloseTo(1 / 1024, 10);
    expect(binomialAtMost(10, 10, 0.3)).toBeCloseTo(1, 10);
    expect(binomialAtMost(4, 1, 0.5)).toBeCloseTo(5 / 16, 10);
  });

  it('calls it consistent, conflicting or undecided, and refuses to judge on too little', () => {
    const web = Array.from({ length: 14 }, (_, i) => at(8 + (i % 12), 1 + i)); // active 10:00–22:00 Polish time
    const day = Array.from({ length: 12 }, (_, i) => at(9 + (i % 10), 1 + i));
    const night = Array.from({ length: 12 }, (_, i) => at(i % 3, 1 + i)); // 02:00–05:00 Polish time
    expect(compareRhythm(web, day, [], DEFAULT_RULESET)).toMatchObject({ verdict: 'consistent', chainInQuiet: 0 });
    expect(compareRhythm(web, night, [], DEFAULT_RULESET)).toMatchObject({ verdict: 'conflict', chainInQuiet: 12 });
    expect(compareRhythm(web, [...day.slice(0, 9), ...night.slice(0, 3)], [], DEFAULT_RULESET).verdict).toBe('unclear');
    expect(compareRhythm(web, day.slice(0, 3), [], DEFAULT_RULESET).verdict).toBe('insufficient');
    const few = compareRhythm(web.slice(0, 5), day, [], DEFAULT_RULESET);
    expect(few.verdict).toBe('insufficient');
    expect(few.quiet).toBeUndefined();
    // someone who posts around the clock has no quiet hours to compare with
    const always = Array.from({ length: 24 }, (_, i) => at(i, 1 + (i % 20)));
    expect(compareRhythm(always, day, [], DEFAULT_RULESET).note).toContain('o różnych porach doby');
  });
});

describe('signed statements that come with a profile', () => {
  const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const doc = profile('keybase', 'ewa_r');
  const base = { seeds: [makeIdentifier('username', 'ewa_r')], documents: [doc], hits: [hit(doc, 'username', 'ewa_r')], mentions: [{ documentId: doc.id, chain: 'bitcoin', address: BTC, segmentKind: 'contact', method: 'plain', obfuscation: [], raw: BTC, context: BTC }] };
  const proof = { documentId: doc.id, chain: 'bitcoin', address: BTC, message: 'Konto ewa_r podpisało oświadczenie o adresie', valid: true };

  it('verified here: 100%; vouched for by a service: at least 95% and said so', () => {
    const own = assess(facts({ ...base, proofs: [proof] })).links[0];
    expect(own).toMatchObject({ score: 100, proven: true });
    expect(own.receipt.map((r) => r.rule)).toEqual(['P1', 'C1']);

    const vouched = assess(facts({ ...base, proofs: [{ ...proof, attestedBy: 'Keybase' }] })).links[0];
    expect(vouched.score).toBe(95);
    expect(vouched.proven).toBeUndefined();
    expect(vouched.receipt.map((r) => r.rule)).toEqual(['P1', 'C3']);
    expect(vouched.receipt[1].detail).toContain('nie weryfikowało go samodzielnie');

    const failed = assess(facts({ ...base, proofs: [{ ...proof, valid: false, reason: 'podpis nie pochodzi od tego adresu' }] })).links[0];
    expect(failed.score).toBe(85);
    expect(failed.receipt.map((r) => r.rule)).toEqual(['P1', 'C0']);
  });
});

describe('an exchange vouching in public for the owner of an address', () => {
  it('adds no points, says who knows the owner, and puts the exchange first among what would settle it', () => {
    const ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const doc = profile('farcaster', 'ania');
    const base = { seeds: [makeIdentifier('username', 'ania')], documents: [doc], hits: [hit(doc, 'username', 'ania')], mentions: [{ documentId: doc.id, chain: 'ethereum', address: ETH, segmentKind: 'contact', method: 'plain', obfuscation: [], raw: ETH, context: ETH }] };
    const plain = assess(facts(base)).links[0];
    const vouched = assess(facts({ ...base, attestations: [
      { chain: 'ethereum', address: ETH, issuer: 'Coinbase', claim: 'verified_account', uid: '0xaaa', at: '2025-03-02T10:00:00.000Z', sourceUrl: 'https://base.easscan.org/attestation/view/0xaaa' },
      { chain: 'ethereum', address: ETH, issuer: 'Coinbase', claim: 'verified_country', value: 'PL', uid: '0xbbb', at: '2025-03-02T10:01:00.000Z' },
    ] })).links[0];
    expect(vouched.score).toBe(plain.score);
    expect(vouched.receipt.map((r) => r.rule)).toEqual(['P1', 'V1']);
    expect(vouched.receipt[1]).toMatchObject({ effect: 'info', points: null, evidence: ['https://base.easscan.org/attestation/view/0xaaa'] });
    expect(vouched.receipt[1].detail).toContain('kraj weryfikacji: PL');
    expect(vouched.receipt[1].detail).toContain('2025-03-02');
    expect(vouched.wouldConfirm[0]).toContain('Dane klienta z Coinbase');
    expect(plain.wouldConfirm[0]).not.toContain('Coinbase');
  });
});

describe('a match by name alone is worth what the name’s rarity makes it worth', () => {
  const named = (handle: string, name: string) => profile('forum', handle, { authorDisplayName: name });
  const byName = (d: DocFact, name: string) => ({ documentId: d.id, identifier: makeIdentifier('full_name', name), relation: 'profile_owner' });
  const run = (name: string, frequency?: { firstCount: number; lastCount: number; expected: number }) => {
    const seed = makeIdentifier('full_name', name);
    const doc = named('konto1', name);
    const [first, last] = name.split(' ');
    return assess(facts({
      seeds: [seed], documents: [doc], hits: [byName(doc, name)],
      ...(frequency ? { nameFrequency: { [seed.normalized]: { first, last, edition: '2026-01-20', ...frequency } } } : {}),
    })).clusters[0];
  };

  it('keeps the usual limit when nothing is known about the name', () => {
    expect(run('Cezary Baryka')).toMatchObject({ level: 'name_unique', identityCap: DEFAULT_RULESET.identityCaps.name_unique });
  });
  it('lowers the limit for a name thousands of people bear', () => {
    const c = run('Jan Kowalski', { firstCount: 462684, lastCount: 66589, expected: 1440 });
    expect(c.identityCap).toBe(15);
    expect(c.identityNote).toContain('około 1440 osób');
    expect(c.identityNote).toContain('2026-01-20');
    expect(run('Adam Zieliński', { firstCount: 300000, lastCount: 40000, expected: 560 }).identityCap).toBe(25);
  });
  it('raises the limit for a name hardly anyone bears — but not to certainty', () => {
    const c = run('Sławomir Mentzen', { firstCount: 180951, lastCount: 8, expected: 0.0674 });
    expect(c.identityCap).toBe(75);
    expect(c.identityNote).toContain('mniej niż jedna osoba');
    expect(c.identityNote).toContain('cudze nazwisko');
  });
  it('leaves a middling name at the usual limit and says how common it is', () => {
    const c = run('Izabela Łęcka', { firstCount: 90000, lastCount: 700, expected: 2.8 });
    expect(c.identityCap).toBe(DEFAULT_RULESET.identityCaps.name_unique);
    expect(c.identityNote).toContain('około 2,8 osoby');
  });
});

describe('flagged counterparties', () => {
  it('marks transfers with an address from the sanctions list, in either direction, without calling them a cash-out', async () => {
    const { analyzeActivity } = await import('../src');
    const { bundledLabel } = await import('@olcys/core');
    const tornado = '0x0330070FD38Ec3bB94F58FA55D40368271E9e54A'; // on the bundled OFAC list
    expect(bundledLabel('ethereum', tornado)).toMatchObject({ category: 'sanctioned' });
    const me = '0x1111111111111111111111111111111111111111';
    const r = analyzeActivity({
      addresses: [me],
      transfers: [
        { chain: 'ethereum', txHash: '0xa', at: '2025-03-01T10:00:00.000Z', from: me, to: tornado, asset: 'ETH', amount: 1 },
        { chain: 'ethereum', txHash: '0xb', at: '2025-03-05T10:00:00.000Z', from: tornado, to: me, asset: 'ETH', amount: 0.9 },
      ],
      labelsOf: (a) => (bundledLabel('ethereum', a) ? [bundledLabel('ethereum', a)!] : []),
    });
    const flag = r.indicators.find((i) => i.rule === 'Z1');
    expect(flag).toMatchObject({ type: 'sanctioned', cashOut: false, count: 2 });
    expect(r.offRamps).toEqual([]);
  });
});

describe('an address entered by the analyst', () => {
  const address = '0x52908400098527886E0F7030069857D2E4169EE7';
  const seeds = [makeIdentifier('crypto_address', address)];
  it('becomes the starting point of the case, with what institutions attest about it, and names nobody', () => {
    const a = assess(facts({
      seeds,
      attestations: [
        { chain: 'ethereum', address, issuer: 'Coinbase', claim: 'verified_country', value: 'PL', uid: '0x1', at: '2025-02-20T00:00:00.000Z', note: 'właściciel adresu przeszedł weryfikację tożsamości w Coinbase; kraj weryfikacji: PL' },
        { chain: 'ethereum', address, issuer: 'POAP', claim: 'event_attendance', value: 'Meetup, Warszawa', uid: 'POAP-1', note: 'portfel odebrał token obecności w Polsce' },
      ],
    }));
    expect(a.clusters).toEqual([expect.objectContaining({ level: 'entered', accounts: [] })]);
    const [link] = a.links;
    expect(link).toMatchObject({ status: 'attributed', score: 100, occurrences: [] });
    expect(link.receipt.map((r) => r.rule)).toEqual(['E1', 'V1', 'V1']);
    expect(link.receipt[0].detail).toContain('nie mówi, kto jest jego właścicielem');
    // only the issuer that checked identity documents is someone to ask
    expect(link.wouldConfirm[0]).toContain('Dane klienta z Coinbase');
    expect(link.wouldConfirm.join(' ')).not.toContain('POAP');
    expect(link.receipt[2].detail).toContain('nie pochodzi od podmiotu, który sprawdzał jej dokumenty');
  });
  it('is excluded like any other address when it is a contract', () => {
    const a = assess(facts({ seeds, accounts: [{ chain: 'ethereum', address, kind: 'contract', code: '0x6080604052', labels: [], txCount: 1, balances: [] }] }));
    expect(a.links[0]).toMatchObject({ status: 'excluded', score: 0 });
    expect(a.links[0].receipt[0].rule).toBe('X2');
  });
});

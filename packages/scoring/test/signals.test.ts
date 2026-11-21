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

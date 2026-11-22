import { describe, expect, it } from 'vitest';
import { foldDiacritics, polishNameFrequency, polishNameStatistics } from '../src/names-pl';

describe('Polish name frequency (PESEL statistics)', () => {
  it('loads the bundled statistics', () => {
    const s = polishNameStatistics();
    expect(s.edition).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.firstNames).toBeGreaterThan(50_000);
    expect(s.surnames).toBeGreaterThan(500_000);
    expect(s.men).toBeGreaterThan(15_000_000);
    expect(s.women).toBeGreaterThan(15_000_000);
  });

  it('a common name is borne by thousands', () => {
    const r = polishNameFrequency('Jan Kowalski')!;
    expect(r).toMatchObject({ first: 'Jan', last: 'Kowalski' });
    expect(r.firstCount).toBeGreaterThan(300_000);
    expect(r.lastCount).toBeGreaterThan(50_000);
    expect(r.expected).toBeGreaterThan(1000);
    expect(polishNameFrequency('Anna Nowak')!.expected).toBeGreaterThan(3000);
  });

  it('a rare surname leaves a handful of people or fewer', () => {
    const r = polishNameFrequency('Sławomir Mentzen')!;
    expect(r.lastCount).toBeGreaterThan(0);
    expect(r.lastCount).toBeLessThan(100);
    expect(r.expected).toBeLessThan(1);
    // the estimate is the product of the two counts over the men in the register
    expect(r.expected).toBeCloseTo((r.firstCount * r.lastCount) / polishNameStatistics().men, 3);
  });

  it('a name typed without diacritics counts every spelling that reads the same', () => {
    const plain = polishNameFrequency('Piotr Wisniewski')!;
    const exact = polishNameFrequency('Piotr Wiśniewski')!;
    expect(plain.lastCount).toBeGreaterThanOrEqual(exact.lastCount);
    expect(plain.expected).toBeGreaterThan(1000);
    expect(polishNameFrequency('Slawomir Mentzen')!.expected).toBeLessThan(1);
    expect(foldDiacritics('ŻÓŁĆ GĘŚLĄ JAŹŃ')).toBe('ZOLC GESLA JAZN');
  });

  it('uses the surname form of the gender the first name points to', () => {
    const woman = polishNameFrequency('Anna Kowalska')!;
    const man = polishNameFrequency('Jan Kowalski')!;
    expect(woman.lastCount).not.toBe(man.lastCount);
    expect(woman.expected).toBeGreaterThan(1000);
  });

  it('reads either order, second names, decoration and joined words', () => {
    const base = polishNameFrequency('Jan Kowalski')!;
    expect(polishNameFrequency('Kowalski Jan')).toEqual(base);
    expect(polishNameFrequency('KOWALSKI JAN')).toEqual(base);
    expect(polishNameFrequency('JanKowalski')).toEqual(base);
    expect(polishNameFrequency('🚀 Jan Kowalski | krypto ₿')).toEqual(base);
    expect(polishNameFrequency('Anna Maria Wesołowska')).toMatchObject({ first: 'Anna', last: 'Wesołowska' });
  });

  it('reads a double-barrelled surname as one surname', () => {
    const hyphen = polishNameFrequency('Katarzyna Nowak-Kowalska')!;
    expect(hyphen.last).toBe('Nowak-Kowalska');
    expect(hyphen.lastCount).toBeLessThan(1000);
    expect(hyphen.expected).toBeLessThan(polishNameFrequency('Katarzyna Nowak')!.expected / 100);
    // written with a space, and listed as a whole: not mistaken for its first half
    const spaced = polishNameFrequency('Jan Żmuda Trzebiatowski')!;
    expect(spaced.last).toBe('Żmuda Trzebiatowski');
    expect(spaced.expected).toBeLessThan(polishNameFrequency('Jan Żmuda')!.expected);
  });

  it('returns nothing for texts that are not a Polish first name with a listed surname', () => {
    for (const text of ['lisu', 'Crypto Whale', 'Satoshi Nakamoto', 'Bitcoin Jesus', 'DeFi Dad', 'piti420', '', 'Jan', 'Kowalski', 'Jan Xqzvwyk', 'kupię bitcoina za gotówkę w Warszawie dzisiaj wieczorem'])
      expect(polishNameFrequency(text), text).toBeUndefined();
  });
});

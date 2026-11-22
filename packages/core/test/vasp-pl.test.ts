import { describe, expect, it } from 'vitest';
import { findRegisteredVasp, registeredVasps, vaspCoreName } from '../src/vasp-pl';

describe('Polish register of virtual-currency businesses', () => {
  it('loads the bundled edition with its source and status', () => {
    const r = registeredVasps();
    expect(r.edition).toBe('2026-07-02');
    expect(r.sourcePage).toContain('gov.pl');
    expect(r.status).toContain('archiwalna');
    expect(r.count).toBe(r.entries.length);
    expect(r.count).toBeGreaterThan(1500);
    expect(r.active + r.struckOff).toBe(r.count);
    expect(r.companies + r.persons).toBe(r.count);
    // numbers are unique and every entry is complete
    expect(new Set(r.entries.map((e) => e.number)).size).toBe(r.count);
    for (const e of r.entries) {
      expect(e.number).toMatch(/^RDWW-\d+$/);
      expect(e.nip).toMatch(/^\d{10}$/);
      expect(e.entered).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.services.length).toBeGreaterThan(0);
      if (e.krs) expect(e.krs).toMatch(/^\d{10}$/);
    }
  });

  it('reduces a business name to the part that distinguishes it', () => {
    expect(vaspCoreName('Binance Poland sp. z o.o.')).toBe('BINANCE POLAND');
    expect(vaspCoreName('BINANCE POLAND SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ')).toBe('BINANCE POLAND');
    expect(vaspCoreName('"CRACOW LOCAL" SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ')).toBe('CRACOW LOCAL');
    expect(vaspCoreName('ROBINHOOD EUROPE, UAB')).toBe('ROBINHOOD EUROPE');
    expect(vaspCoreName('BB Trade Estonia OÜ')).toBe('BB TRADE ESTONIA');
  });

  it('finds an entry by its registered name, however the legal form is written', () => {
    const full = findRegisteredVasp('BINANCE POLAND SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ')!;
    expect(full).toMatchObject({ number: 'RDWW-465', matched: 'name', kind: 'company', struckOff: false });
    expect(full.nip).toMatch(/^\d{10}$/);
    expect(full.services).toContain('wymiana pomiędzy walutami wirtualnymi i środkami płatniczymi');
    expect(findRegisteredVasp('binance poland sp. z o.o.')).toEqual(full);
    expect(findRegisteredVasp('BB Trade Estonia OÜ')).toMatchObject({ number: 'RDWW-893', matched: 'name' });
  });

  it('finds the local company of a brand, also from an address label', () => {
    for (const label of ['Binance', 'Binance: Hot Wallet', 'Binance 14', 'binance deposit'])
      expect(findRegisteredVasp(label), label).toMatchObject({ number: 'RDWW-465', matched: 'brand' });
    expect(findRegisteredVasp('Wirex')).toMatchObject({ name: expect.stringContaining('WIREX EUROPE'), matched: 'brand' });
  });

  it('says when an entry was struck off or suspended', () => {
    expect(findRegisteredVasp('Cinkciarz.pl')).toMatchObject({ matched: 'name', struckOff: true });
    const r = registeredVasps();
    expect(r.entries.some((e) => e.suspendedFrom)).toBe(true);
  });

  it('finds a person running a business under their own name, in either order', () => {
    const person = registeredVasps().entries.find((e) => e.kind === 'person' && e.name.split(' ').length === 2)!;
    const [first, last] = person.name.split(' ');
    expect(findRegisteredVasp(`${first} ${last}`)).toMatchObject({ nip: person.nip, matched: 'name' });
    expect(findRegisteredVasp(`${last} ${first}`.toLowerCase())).toMatchObject({ nip: person.nip, matched: 'name' });
  });

  it('does not match a name that merely contains a brand, nor a generic word', () => {
    // "BITBYBIT TRADE" is registered; Bybit is not
    for (const name of ['Bybit', 'ByBit Deposit', 'Kraken', 'Coinbase 10', 'OKX', 'Gate', 'Crypto', 'Trust', 'Bit Deposit', 'Uniswap V3: Router', 'X', ''])
      expect(findRegisteredVasp(name), name).toBeUndefined();
  });
});

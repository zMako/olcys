import { describe, expect, it } from 'vitest';
import { parseAddress } from '@olcys/core';
import { HERO_ID, KNOWN_ENTITIES, generateWorld } from '../src';

describe('synthetic world', () => {
  it('is fully determined by its seed', () => {
    expect(JSON.stringify(generateWorld({ seed: 'a' }))).toBe(JSON.stringify(generateWorld({ seed: 'a' })));
    expect(JSON.stringify(generateWorld({ seed: 'a' }))).not.toBe(JSON.stringify(generateWorld({ seed: 'b' })));
  });

  it('contains only checksum-valid addresses on the right chain', () => {
    const world = generateWorld({ personas: 120 });
    expect(world.truth.length).toBeGreaterThan(100);
    for (const p of world.truth) expect(parseAddress(p.address), p.address).toMatchObject({ chain: p.chain, address: p.address });
    for (const w of world.personas.flatMap((p) => p.wallets)) expect(parseAddress(w.address)?.checksum).toBe('valid');
  });

  it('ships real institutional addresses that pass their checksums', () => {
    for (const e of KNOWN_ENTITIES) expect(parseAddress(e.address), e.name).toMatchObject({ chain: e.chain, checksum: 'valid' });
  });

  it('covers every expected outcome, including the scripted subject', () => {
    const world = generateWorld();
    const bands = new Set(world.truth.map((p) => p.expected));
    expect([...bands].sort()).toEqual(['excluded', 'medium', 'noise', 'not_attributable', 'probable', 'very_high']);
    const hero = world.truth.filter((p) => p.postedBy === HERO_ID);
    expect(new Set(hero.map((p) => p.site))).toEqual(new Set(['forum', 'code', 'ads']));
    expect(world.personas.filter((p) => p.fullName === 'Cezary Baryka')).toHaveLength(2);
  });
});

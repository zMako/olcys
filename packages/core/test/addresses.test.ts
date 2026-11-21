import { describe, expect, it } from 'vitest';
import { extractAddresses, findCryptoAmounts, findPlnAmounts, guessIdentifier, normalizeIdentifier, parseAddress } from '../src';

describe('address validation', () => {
  const valid: [string, string, string][] = [
    ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'bitcoin', 'p2pkh'],
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'bitcoin', 'p2pkh'],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bitcoin', 'p2sh'],
    ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'bitcoin', 'p2wpkh'],
    ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'bitcoin', 'p2wpkh'],
    ['bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', 'bitcoin', 'p2wsh'],
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'bitcoin', 'p2tr'],
    ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'ethereum', 'evm'],
    ['0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', 'ethereum', 'evm'],
    ['0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', 'ethereum', 'evm'],
    ['0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb', 'ethereum', 'evm'],
    ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'tron', 'tron'],
  ];
  it.each(valid)('accepts %s', (addr, chain, type) => {
    const p = parseAddress(addr);
    expect(p).not.toBeNull();
    expect(p!.chain).toBe(chain);
    expect(p!.type).toBe(type);
    expect(p!.checksum).toBe('valid');
  });

  const invalid = [
    '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3', // one character changed
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', // bad bech32 checksum
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', // taproot encoded with bech32, not bech32m
    'bc1Qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', // mixed case
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD', // EIP-55 checksum broken
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA', // too short
  ];
  it.each(invalid)('rejects %s', (addr) => {
    expect(parseAddress(addr)).toBeNull();
  });

  it('canonicalises unchecksummed EVM hex and flags the missing checksum', () => {
    const p = parseAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
    expect(p).toMatchObject({ address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', checksum: 'absent' });
  });

  it('lowercases bech32', () => {
    expect(parseAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')!.address).toBe(
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    );
  });
});

describe('extraction from text', () => {
  const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const ETH = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  const TRX = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  it('finds plain addresses with offsets and context', () => {
    const text = `Wsparcie: BTC ${BTC}, ETH: ${ETH}. Dzięki!`;
    const m = extractAddresses(text);
    expect(m.map((x) => x.address)).toEqual([BTC, ETH]);
    expect(text.slice(m[0].start, m[0].end)).toBe(BTC);
    expect(m[0].method).toBe('plain');
    expect(m[1].context).toContain('Dzięki');
  });

  it('finds addresses inside URLs and payment URIs', () => {
    const m = extractAddresses(`https://etherscan.io/address/${ETH}#code oraz bitcoin:${BTC}?amount=0.1`);
    expect(m.map((x) => x.address)).toEqual([ETH, BTC]);
  });

  it('ignores transaction hashes, typos and ordinary words', () => {
    const tx = '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060';
    const m = extractAddresses(`tx ${tx} oraz 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3. To jest Totalnie zwykłe zdanie o 3 kotach.`);
    expect(m).toEqual([]);
  });

  it('recovers an address hidden with zero-width characters', () => {
    const hidden = ETH.slice(0, 10) + '​' + ETH.slice(10, 25) + '‍' + ETH.slice(25);
    const m = extractAddresses(`mój adres ${hidden} pozdrawiam`);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ address: ETH, method: 'deobfuscated', obfuscation: ['zero-width'] });
    expect(m[0].raw).toBe(hidden);
  });

  it('recovers an address written with look-alike Cyrillic letters', () => {
    // Latin "a" and "c" replaced with Cyrillic "а" and "с"
    const hidden = BTC.replace('a', 'а').replace('c', 'с');
    expect(hidden).not.toBe(BTC);
    const m = extractAddresses(`BTC: ${hidden}`);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ address: BTC, method: 'deobfuscated', obfuscation: ['homoglyph'] });
  });

  it('recovers addresses split into chunks', () => {
    const chunked = (s: string, n: number, sep: string) => s.match(new RegExp(`.{1,${n}}`, 'g'))!.join(sep);
    const text = `BTC ${chunked(BTC, 4, ' ')} / TRX ${chunked(TRX, 6, '-')} / ETH ${chunked(ETH, 7, '\n')} koniec`;
    const m = extractAddresses(text);
    expect(m.map((x) => x.address)).toEqual([BTC, TRX, ETH]);
    expect(m.every((x) => x.method === 'joined' && x.obfuscation.includes('split'))).toBe(true);
    expect(text.slice(m[0].start, m[0].end)).toBe(chunked(BTC, 4, ' '));
  });

  it('does not join the head of a chunked transaction hash into an address', () => {
    const tx = '0x5c504ed4 32cb5113 8bcf09aa 5e8a410d d4a1e204 ef84bfed 1be16dfb a1b22060';
    expect(extractAddresses(tx)).toEqual([]);
  });

  it('reports each occurrence separately', () => {
    const m = extractAddresses(`${BTC}\n${BTC}`);
    expect(m).toHaveLength(2);
    expect(m[1].start).toBe(BTC.length + 1);
  });
});

describe('identifiers', () => {
  it('normalises', () => {
    expect(normalizeIdentifier('full_name', '  Cezary   BARYKA ')).toBe('cezary baryka');
    expect(normalizeIdentifier('full_name', 'Izabela Łęcka')).toBe('izabela lecka');
    expect(normalizeIdentifier('username', '@Szklane_Domy')).toBe('szklane_domy');
    expect(normalizeIdentifier('phone', '600 100 200')).toBe('+48600100200');
    expect(normalizeIdentifier('crypto_address', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')).toBe(
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    );
  });
  it('guesses the kind of pasted input', () => {
    expect(guessIdentifier('szklane_domy').kind).toBe('username');
    expect(guessIdentifier('Cezary Baryka').kind).toBe('full_name');
    expect(guessIdentifier('c.baryka@poczta.test').kind).toBe('email');
    expect(guessIdentifier('+48 600 100 200').kind).toBe('phone');
    expect(guessIdentifier('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').kind).toBe('crypto_address');
  });
});

describe('stated amounts', () => {
  it('reads prices in złoty', () => {
    expect(findPlnAmounts('Cena: 3 200 zł, do negocjacji').map((a) => a.value)).toEqual([3200]);
    expect(findPlnAmounts('1900 PLN albo 1.850,50 zł').map((a) => a.value)).toEqual([1900, 1850.5]);
    expect(findPlnAmounts('kurs do uzgodnienia')).toEqual([]);
    expect(findPlnAmounts('450 złamanych groszy')).toEqual([]);
  });
  it('reads crypto amounts', () => {
    expect(findCryptoAmounts('Dzięki, 0,01 ETH doszło, a 5000 USDT czeka')).toEqual([
      { value: 0.01, unit: 'ETH', raw: '0,01 ETH' }, { value: 5000, unit: 'USDT', raw: '5000 USDT' },
    ]);
    expect(findCryptoAmounts('BTC rośnie')).toEqual([]);
  });
});

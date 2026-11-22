import { describe, expect, it } from 'vitest';
import { ADDRESS_LISTS, reportedForFraud, sanctioned } from '../src/sanctions';

describe('bundled address lists', () => {
  it('finds sanctioned addresses on each chain, whatever the letter case of a hexadecimal address', () => {
    // An address from the Lazarus Group designation (the Ronin bridge theft), listed by OFAC under ETH.
    const hit = sanctioned('ethereum', '0x098B716B8Aaf21512996dC57EB0615e2383E2f96');
    expect(hit).toMatchObject({ list: 'OFAC SDN', retrieved: '2026-11-22' });
    expect(hit!.listedAs).toContain('ETH');
    expect(sanctioned('ethereum', '0x098b716b8aaf21512996dc57eb0615e2383e2f96')).toEqual(hit);
    expect(sanctioned('ethereum', ' 0x098B716B8AAF21512996DC57EB0615E2383E2F96 '.replace('0X', '0x'))).toEqual(hit);
    // Listed under two assets at once.
    expect(sanctioned('ethereum', '0x19Aa5Fe80D33a56D56c78e82eA5E50E5d80b4Dff')?.listedAs).toEqual(['ETH', 'USDT']);
    expect(sanctioned('tron', 'TA3941uFAvmVibSkQ6fMJXxmaSNovX86mz')?.listedAs).toEqual(['USDT']);
    // A Bitcoin address from the list.
    expect(sanctioned('bitcoin', '12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h')?.listedAs).toEqual(['XBT']);
    expect(Object.keys(ADDRESS_LISTS[0]).sort()).toEqual(['addresses', 'list', 'origin', 'retrieved', 'source']);
    expect(ADDRESS_LISTS[0].addresses).toBeGreaterThan(500);
  });

  it('does not match other addresses, other chains, or case-changed non-hexadecimal addresses', () => {
    expect(sanctioned('ethereum', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBeUndefined();
    expect(sanctioned('bitcoin', '0x098B716B8Aaf21512996dC57EB0615e2383E2f96')).toBeUndefined();
    expect(sanctioned('bitcoin', '12qtd5bfwrsdnsazy76uve1xycgntojh9h')).toBeUndefined();
    expect(sanctioned('monero', 'whatever')).toBeUndefined();
  });

  it('finds addresses reported for fraud, with what was reported', () => {
    const hit = reportedForFraud('ethereum', '0x09750AD360FDB7A2EE23669C4503C974D86D8694');
    expect(hit).toMatchObject({ list: 'MyEtherWallet darklist', date: '2020-11-17' });
    expect(hit!.comment).toMatch(/phishing/i);
    expect(reportedForFraud('ethereum', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBeUndefined();
    expect(reportedForFraud('bitcoin', '0x09750ad360fdb7a2ee23669c4503c974d86d8694')).toBeUndefined();
  });
});

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { AddressCodec, ParsedAddress } from './types';

/** EIP-55 mixed-case checksum encoding of a 40-char hex string. */
export function toEip55(hex40: string): string {
  const lower = hex40.toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

function parseEvm(s: string): ParsedAddress | null {
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(s)) return null;
  const hex = s.slice(2);
  const canonical = toEip55(hex);
  const singleCase = hex === hex.toLowerCase() || hex === hex.toUpperCase();
  if (singleCase) return { chain: 'ethereum', address: canonical, type: 'evm', checksum: 'absent' };
  // Mixed case claims to be checksummed — it must match exactly, otherwise it is a typo or junk.
  if ('0x' + hex !== canonical) return null;
  return { chain: 'ethereum', address: canonical, type: 'evm', checksum: 'valid' };
}

export const evmCodec: AddressCodec = {
  id: 'evm',
  chain: 'ethereum',
  parse: parseEvm,
  join: {
    canStart: (t) => /^0[xX][0-9a-fA-F]*$/.test(t),
    tokenOk: (t) => /^(0[xX])?[0-9a-fA-F]*$/.test(t),
    minLength: 42,
    maxLength: 42,
  },
};

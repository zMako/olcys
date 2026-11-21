import { decodeBase58Check } from './bitcoin';
import type { AddressCodec, ParsedAddress } from './types';

function parseTron(s: string): ParsedAddress | null {
  if (s.length !== 34) return null;
  const d = decodeBase58Check(s);
  if (!d || d.version !== 0x41 || d.payload.length !== 20) return null;
  return { chain: 'tron', address: s, type: 'tron', checksum: 'valid' };
}

export const tronCodec: AddressCodec = {
  id: 'tron',
  chain: 'tron',
  parse: parseTron,
  join: {
    canStart: (t) => t.startsWith('T'),
    tokenOk: (t) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(t),
    minLength: 34,
    maxLength: 34,
  },
};

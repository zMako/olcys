import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import type { AddressCodec, ParsedAddress } from './types';

const base58check = createBase58check(sha256);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BECH32_CHARS = /^[02-9ac-hj-np-z]+$/i;

export function encodeBase58Check(version: number, payload: Uint8Array): string {
  const data = new Uint8Array(payload.length + 1);
  data[0] = version;
  data.set(payload, 1);
  return base58check.encode(data);
}

export function decodeBase58Check(s: string): { version: number; payload: Uint8Array } | null {
  try {
    const data = base58check.decode(s);
    return { version: data[0], payload: data.slice(1) };
  } catch {
    return null;
  }
}

export function encodeSegwit(hrp: string, version: number, program: Uint8Array): string {
  const enc = version === 0 ? bech32 : bech32m;
  return enc.encode(hrp, [version, ...enc.toWords(program)]);
}

function parseLegacy(s: string): ParsedAddress | null {
  const d = decodeBase58Check(s);
  if (!d || d.payload.length !== 20) return null;
  if (d.version === 0x00) return { chain: 'bitcoin', address: s, type: 'p2pkh', checksum: 'valid' };
  if (d.version === 0x05) return { chain: 'bitcoin', address: s, type: 'p2sh', checksum: 'valid' };
  return null;
}

function parseSegwit(s: string): ParsedAddress | null {
  // BIP-173: mixed case is invalid.
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null;
  const lower = s.toLowerCase() as `${string}1${string}`;
  for (const [enc, name] of [[bech32, 'bech32'], [bech32m, 'bech32m']] as const) {
    try {
      const { prefix, words } = enc.decode(lower, 90);
      if (prefix !== 'bc' || words.length < 1) return null;
      const version = words[0];
      const program = enc.fromWords(words.slice(1));
      if (version > 16 || program.length < 2 || program.length > 40) return null;
      // BIP-350: v0 must use bech32, v1+ must use bech32m.
      if ((version === 0) !== (name === 'bech32')) return null;
      let type: string;
      if (version === 0) {
        if (program.length === 20) type = 'p2wpkh';
        else if (program.length === 32) type = 'p2wsh';
        else return null;
      } else if (version === 1 && program.length === 32) {
        type = 'p2tr';
      } else {
        type = `segwit_v${version}`;
      }
      return { chain: 'bitcoin', address: lower, type, checksum: 'valid' };
    } catch {
      // wrong checksum for this encoding — try the other one
    }
  }
  return null;
}

export const bitcoinLegacyCodec: AddressCodec = {
  id: 'bitcoin-base58',
  chain: 'bitcoin',
  parse: parseLegacy,
  join: {
    canStart: (t) => /^[13]/.test(t),
    tokenOk: (t) => BASE58.test(t),
    minLength: 26,
    maxLength: 35,
  },
};

export const bitcoinSegwitCodec: AddressCodec = {
  id: 'bitcoin-bech32',
  chain: 'bitcoin',
  parse: parseSegwit,
  join: {
    canStart: (t) => /^bc1/i.test(t),
    tokenOk: (t) => BECH32_CHARS.test(t) || /^bc1[02-9ac-hj-np-z]*$/i.test(t),
    minLength: 14,
    maxLength: 90,
  },
};

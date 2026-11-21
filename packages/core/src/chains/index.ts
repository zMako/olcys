import { bitcoinLegacyCodec, bitcoinSegwitCodec } from './bitcoin';
import { evmCodec } from './evm';
import { tronCodec } from './tron';
import type { AddressCodec, ParsedAddress } from './types';

export * from './types';
export { encodeBase58Check, decodeBase58Check, encodeSegwit } from './bitcoin';
export { toEip55 } from './evm';

/** Registry of supported address formats. New chains are added here. */
export const defaultCodecs: AddressCodec[] = [bitcoinSegwitCodec, bitcoinLegacyCodec, evmCodec, tronCodec];

/** Validates a single string as an address of any supported chain. */
export function parseAddress(candidate: string, codecs: AddressCodec[] = defaultCodecs): ParsedAddress | null {
  const s = candidate.trim();
  for (const codec of codecs) {
    const parsed = codec.parse(s);
    if (parsed) return parsed;
  }
  return null;
}

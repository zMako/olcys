import { md5 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

/** MD5 is used only to compare with hashes that sites themselves publish (avatar services), never for integrity. */
export function md5Hex(data: Uint8Array | string): string {
  return bytesToHex(md5(typeof data === 'string' ? utf8ToBytes(data) : data));
}

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Evidence chain: each snapshot's hash covers the previous one, so removing or
 * altering any stored record breaks every hash after it.
 */
export function chainHash(prev: string, s: { sha256: string; url: string; fetchedAt: string }): string {
  return sha256Hex(`${prev}|${s.sha256}|${s.url}|${s.fetchedAt}`);
}

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { toEip55 } from './chains';

const word = (hex: string) => hexToBytes(hex.replace(/^0x/, '').padStart(64, '0'));
const uint = (n: number | bigint) => word(BigInt(n).toString(16));
const keccakText = (s: string) => keccak_256(utf8ToBytes(s));

/**
 * The claim an address signs to say "I belong to this Farcaster account" (EIP-712 typed data, as the
 * protocol defines it). Farcaster stores the signature with the account, so anyone can check it.
 */
const DOMAIN = keccak_256(concatBytes(
  keccakText('EIP712Domain(string name,string version,bytes32 salt)'),
  keccakText('Farcaster Verify Ethereum Address'),
  keccakText('2.0.0'),
  word('f2d857f4a3edcb9b78b4d503bfe733db1e3f6cdc2b7971ee739626c97e86a558'),
));
const CLAIM_TYPE = keccakText('VerificationClaim(uint256 fid,address address,bytes32 blockHash,uint8 network)');

export interface FarcasterClaim {
  fid: number;
  /** The address that claims the account. */
  address: string;
  /** Hash of a recent Ethereum block, part of what was signed. */
  blockHash: string;
  /** 65-byte signature, hex or base64. */
  signature: string;
  /** 1 = main network. */
  network?: number;
}

const toBytes = (s: string): Uint8Array => (/^0x[0-9a-f]*$/i.test(s) ? hexToBytes(s.slice(2)) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/**
 * Checks mathematically that the address itself signed the claim naming this account: the public key is
 * recovered from the signature and must hash to the address. Only the holder of the address's key can produce it.
 */
export function verifyFarcasterClaim(c: FarcasterClaim): { valid: boolean; recovered?: string; reason?: string } {
  try {
    const sig = toBytes(c.signature);
    if (sig.length !== 65) return { valid: false, reason: 'podpis ma nieprawidłową długość' };
    const struct = keccak_256(concatBytes(CLAIM_TYPE, uint(c.fid), word(c.address), word(c.blockHash), uint(c.network ?? 1)));
    const digest = keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), DOMAIN, struct));
    const recovery = sig[64] >= 27 ? sig[64] - 27 : sig[64];
    const pub = secp256k1.recoverPublicKey(concatBytes(Uint8Array.of(recovery), sig.slice(0, 64)), digest, { prehash: false });
    const recovered = toEip55(bytesToHex(keccak_256(secp256k1.Point.fromBytes(pub).toBytes(false).slice(1)).slice(-20)));
    return recovered.toLowerCase() === c.address.toLowerCase() ? { valid: true, recovered } : { valid: false, recovered, reason: 'podpis nie pochodzi od tego adresu' };
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : 'nie udało się sprawdzić podpisu' };
  }
}

/** Signs a wallet claim with a private key. Used by tests and by the synthetic environment; real claims come from the network. */
export function signFarcasterClaim(c: Omit<FarcasterClaim, 'signature'>, privateKeyHex: string): string {
  const struct = keccak_256(concatBytes(CLAIM_TYPE, uint(c.fid), word(c.address), word(c.blockHash), uint(c.network ?? 1)));
  const digest = keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), DOMAIN, struct));
  const sig = secp256k1.sign(digest, hexToBytes(privateKeyHex), { prehash: false, format: 'recovered' });
  return `0x${bytesToHex(sig.slice(1))}${(27 + sig[0]).toString(16)}`;
}

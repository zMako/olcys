import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { encodeBase58Check, encodeSegwit, toEip55, type Chain } from '@olcys/core';

export type WalletKind = 'btc-segwit' | 'btc-legacy' | 'eth' | 'tron';

export interface Wallet {
  kind: WalletKind;
  chain: Chain;
  address: string;
  /**
   * Test key derived from the public world seed. It exists so synthetic personas can
   * sign ownership proofs. Never send real funds to these addresses.
   */
  privateKeyHex: string;
  label: string;
}

/** Derives a real, checksum-valid address from a deterministic test key. */
export function makeWallet(seed: string, kind: WalletKind, label: string): Wallet {
  const priv = sha256(utf8ToBytes(`olcys-wallet|${seed}|${kind}|${label}`));
  const privateKeyHex = bytesToHex(priv);
  if (kind === 'btc-segwit' || kind === 'btc-legacy') {
    const h160 = ripemd160(sha256(secp256k1.getPublicKey(priv, true)));
    const address = kind === 'btc-segwit' ? encodeSegwit('bc', 0, h160) : encodeBase58Check(0x00, h160);
    return { kind, chain: 'bitcoin', address, privateKeyHex, label };
  }
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  const account = keccak_256(pub).slice(-20);
  if (kind === 'eth') return { kind, chain: 'ethereum', address: toEip55(bytesToHex(account)), privateKeyHex, label };
  return { kind, chain: 'tron', address: encodeBase58Check(0x41, account), privateKeyHex, label };
}

/** A deterministic SSH public key line ("ssh-ed25519 AAAA… comment"), as code hosts list them at /<user>.keys. */
export function sshKey(seed: string, comment: string): string {
  const name = utf8ToBytes('ssh-ed25519');
  const key = sha256(utf8ToBytes(`olcys-ssh|${seed}`));
  const u32 = (n: number) => new Uint8Array([0, 0, 0, n]);
  const blob = new Uint8Array([...u32(name.length), ...name, ...u32(key.length), ...key]);
  return `ssh-ed25519 ${Buffer.from(blob).toString('base64')} ${comment}`;
}

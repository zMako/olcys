import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { encodeBase58Check, encodeSegwit, parseAddress, toEip55, type Chain } from './chains';

/** A message published together with a signature made by an address's private key. */
export interface SignedMessage {
  message: string;
  /** The address the author claims to have signed with. */
  address: string;
  signature: string;
  start: number;
  end: number;
}

export interface ProofCheck {
  valid: boolean;
  chain?: Chain;
  /** Canonical form of the claimed address. */
  address?: string;
  /** Why the proof failed, if it did. */
  reason?: string;
}

const ARMOR = /-----BEGIN BITCOIN SIGNED MESSAGE-----[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*-----BEGIN (?:BITCOIN )?SIGNATURE-----[ \t]*\r?\n\s*(\S+)\s*\r?\n\s*([A-Za-z0-9+/=]+)\s*\r?\n[ \t]*-----END BITCOIN SIGN(?:ED MESSAGE|ATURE)-----/g;
const LABELLED = /(?:Wiadomość|Message)\s*:[ \t]*(.+?)[ \t]*\r?\n\s*(?:Adres|Address)\s*:[ \t]*(\S+)[ \t]*\r?\n\s*(?:Podpis|Signature)\s*:[ \t]*(\S+)/gi;

/**
 * Finds signed messages in text: the armoured block wallets produce
 * ("-----BEGIN BITCOIN SIGNED MESSAGE-----") and the plain three-line form people type on forums
 * ("Wiadomość / Adres / Podpis").
 */
export function findSignedMessages(text: string): SignedMessage[] {
  const out: SignedMessage[] = [];
  for (const re of [ARMOR, LABELLED]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const [start, end] = [m.index, m.index + m[0].length];
      if (out.some((o) => start < o.end && end > o.start)) continue;
      // Blank lines around the message are layout, not part of what was signed.
      out.push({ message: m[1].trim(), address: m[2], signature: m[3], start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const varint = (n: number) => (n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8));
const BITCOIN_MAGIC = utf8ToBytes('Bitcoin Signed Message:\n');

function bitcoinDigest(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  return sha256(sha256(concatBytes(varint(BITCOIN_MAGIC.length), BITCOIN_MAGIC, varint(body.length), body)));
}

function ethereumDigest(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  return keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), body));
}

const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
const uncompress = (pub: Uint8Array) => secp256k1.Point.fromBytes(pub).toBytes(false);
const ethAddress = (pub: Uint8Array) => toEip55(bytesToHex(keccak_256(uncompress(pub).slice(1)).slice(-20)));

/**
 * Checks a signed message mathematically: recovers the public key from the signature
 * and tests whether it belongs to the claimed address. Only the holder of the private key can produce one.
 */
export function verifySignedMessage(m: Pick<SignedMessage, 'message' | 'address' | 'signature'>): ProofCheck {
  const parsed = parseAddress(m.address);
  if (!parsed) return { valid: false, reason: 'podany adres nie jest prawidłowym adresem' };
  const base = { chain: parsed.chain, address: parsed.address };
  try {
    if (parsed.chain === 'bitcoin') {
      const sig = base64.decode(m.signature);
      if (sig.length !== 65 || sig[0] < 27 || sig[0] > 42) return { ...base, valid: false, reason: 'podpis ma nieprawidłowy format' };
      const recovery = (sig[0] - 27) & 3;
      const pub = secp256k1.recoverPublicKey(concatBytes(Uint8Array.of(recovery), sig.slice(1)), bitcoinDigest(m.message), { prehash: false });
      const candidates = [
        encodeBase58Check(0x00, hash160(pub)),
        encodeBase58Check(0x00, hash160(uncompress(pub))),
        encodeSegwit('bc', 0, hash160(pub)),
      ];
      return candidates.includes(parsed.address) ? { ...base, valid: true } : { ...base, valid: false, reason: 'podpis nie pochodzi od klucza tego adresu' };
    }
    if (parsed.chain === 'ethereum') {
      const sig = hexToBytes(m.signature.replace(/^0x/i, ''));
      if (sig.length !== 65) return { ...base, valid: false, reason: 'podpis ma nieprawidłowy format' };
      const recovery = sig[64] >= 27 ? sig[64] - 27 : sig[64];
      const pub = secp256k1.recoverPublicKey(concatBytes(Uint8Array.of(recovery), sig.slice(0, 64)), ethereumDigest(m.message), { prehash: false });
      return ethAddress(pub) === parsed.address ? { ...base, valid: true } : { ...base, valid: false, reason: 'podpis nie pochodzi od klucza tego adresu' };
    }
    return { ...base, valid: false, reason: 'weryfikacja podpisów tej sieci nie jest obsługiwana' };
  } catch {
    return { ...base, valid: false, reason: 'podpisu nie da się odczytać' };
  }
}

/** Signs like a Bitcoin wallet does (used by the synthetic environment and tests). */
export function signBitcoinMessage(message: string, privateKeyHex: string, addressType: 'p2pkh' | 'p2wpkh' = 'p2pkh'): string {
  const sig = secp256k1.sign(bitcoinDigest(message), hexToBytes(privateKeyHex), { prehash: false, format: 'recovered' });
  const header = (addressType === 'p2wpkh' ? 39 : 31) + sig[0];
  return base64.encode(concatBytes(Uint8Array.of(header), sig.slice(1)));
}

/** Signs like an Ethereum wallet does with personal_sign (used by the synthetic environment and tests). */
export function signEthereumMessage(message: string, privateKeyHex: string): string {
  const sig = secp256k1.sign(ethereumDigest(message), hexToBytes(privateKeyHex), { prehash: false, format: 'recovered' });
  return '0x' + bytesToHex(concatBytes(sig.slice(1), Uint8Array.of(27 + sig[0])));
}

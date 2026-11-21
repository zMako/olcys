import { sha256 } from '@noble/hashes/sha2.js';
import { base64, base64nopad } from '@scure/base';
import { md5Hex, sha256Hex } from './hash';

/**
 * Something a profile shows that identifies its owner without naming them:
 *  - email_md5 / email_sha256: the hash of the account's e-mail address, visible in the address of its avatar
 *    (avatar services such as Gravatar address pictures by that hash);
 *  - ssh_key / pgp_key: the fingerprint of a public key the account uploaded.
 */
export type FingerprintKind = 'email_md5' | 'email_sha256' | 'ssh_key' | 'pgp_key';

export interface Fingerprint {
  kind: FingerprintKind;
  value: string;
  /** Where it was read from. */
  sourceUrl?: string;
}

/** Hashes of an e-mail address the way avatar services compute them: trimmed, lower-cased. */
export function emailHashes(email: string): { md5: string; sha256: string } {
  const e = email.trim().toLowerCase();
  return { md5: md5Hex(e), sha256: sha256Hex(e) };
}

/** Reads the e-mail hash out of an avatar address like "https://…/avatar/<hash>?s=80". */
export function avatarFingerprint(url: string | undefined): Fingerprint | undefined {
  const m = url?.match(/\/avatar\/([0-9a-f]{64}|[0-9a-f]{32})(?![0-9a-f])/i);
  if (!m) return undefined;
  const value = m[1].toLowerCase();
  return { kind: value.length === 32 ? 'email_md5' : 'email_sha256', value, sourceUrl: url };
}

/** Fingerprint of an SSH public key line ("ssh-ed25519 AAAA… comment"), in the form OpenSSH prints: "SHA256:…". */
export function sshKeyFingerprint(line: string): string | undefined {
  const m = line.trim().match(/^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-\S+)\s+([A-Za-z0-9+/]+={0,2})/);
  if (!m) return undefined;
  try {
    return `SHA256:${base64nopad.encode(sha256(base64.decode(m[1])))}`;
  } catch {
    return undefined;
  }
}

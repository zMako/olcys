import { parseAddress } from './chains';

/** What an analyst can start from, and what the engine can discover along the way. */
export type IdentifierKind =
  | 'full_name'
  | 'username'
  | 'email'
  | 'phone'
  | 'messenger_id'
  | 'profile_url'
  | 'crypto_address';

export interface Identifier {
  kind: IdentifierKind;
  value: string;
  /** Comparison key; two identifiers are the same thing iff kind and normalized match. */
  normalized: string;
}

export function foldDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L');
}

export function normalizeIdentifier(kind: IdentifierKind, value: string): string {
  const v = value.trim();
  switch (kind) {
    case 'full_name':
      return foldDiacritics(v).toLowerCase().replace(/\s+/g, ' ');
    case 'username':
    case 'messenger_id':
      return v.replace(/^@/, '').toLowerCase();
    case 'email':
      return v.toLowerCase();
    case 'phone': {
      const digits = v.replace(/[^\d+]/g, '').replace(/^00/, '+');
      if (digits.startsWith('+')) return digits;
      return digits.length === 9 ? `+48${digits}` : digits;
    }
    case 'profile_url':
      return v.replace(/#.*$/, '').replace(/\/+$/, '');
    case 'crypto_address':
      return parseAddress(v)?.address ?? v;
  }
}

export function makeIdentifier(kind: IdentifierKind, value: string): Identifier {
  return { kind, value: value.trim(), normalized: normalizeIdentifier(kind, value) };
}

export function identifierKey(id: Identifier): string {
  return `${id.kind}:${id.normalized}`;
}

/** Best guess of the kind when the analyst just pastes something. */
export function guessIdentifier(input: string): Identifier {
  const v = input.trim();
  if (parseAddress(v)) return makeIdentifier('crypto_address', v);
  if (/^https?:\/\//i.test(v)) return makeIdentifier('profile_url', v);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return makeIdentifier('email', v);
  if (/^\+?[\d\s-]{9,15}$/.test(v)) return makeIdentifier('phone', v);
  if (/\s/.test(v)) return makeIdentifier('full_name', v);
  return makeIdentifier('username', v);
}

/**
 * Other spellings of a nick that people use from site to site: the same letters with the
 * separators dropped or swapped ("szklane_domy" → "szklanedomy", "szklane-domy", "szklane.domy").
 */
export function usernameVariants(value: string): string[] {
  const base = normalizeIdentifier('username', value);
  const parts = base.split(/[_\-.]+/).filter(Boolean);
  if (parts.length < 2) return [];
  return [...new Set(['', '_', '-', '.'].map((sep) => parts.join(sep)))].filter((v) => v !== base);
}

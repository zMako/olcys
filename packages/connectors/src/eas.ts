import { parseAddress, type AddressAttestation, type ConnectorContext } from '@olcys/core';

/**
 * Public attestations about a wallet on the Ethereum Attestation Service (Base network), read from its index.
 *
 * Anyone can attest anything about any address, so an attestation is worth exactly as much as its attester.
 * The table below lists the attesters whose statements say something about WHO holds a wallet, and how each of
 * their attestation types is read. Attestations by anyone else prove nothing and are left out unless asked for.
 *
 * Claims used:
 *   verified_account            the issuer (an exchange) holds this customer's verified identity
 *   verified_country            as above, plus the country of verification (ISO code in `value`)
 *   verified_coinbase_one       a paying subscriber of the exchange (it holds payment data too)
 *   verified_business_account   a verified business customer; verified_business_country with the ISO code
 *   proof_of_personhood         a passing "unique human" score; `value` lists the identity stamps behind it
 *   identity_stamps             identity stamps without a passing score
 *   identity_check              an identity check (KYC) passed with the provider named in `value`
 *   linked_account              the owner proved control of an off-chain account: `value` is "platform" or
 *                               "platform:handle" (several separated by spaces)
 */
export const EAS_BASE = 'https://base.easscan.org/graphql';

type Data = Record<string, unknown>;
interface Reading {
  claim: string;
  value?: string;
}
type Reader = (data: Data) => Reading | undefined;

const iso2 = (v: unknown) => (typeof v === 'string' && /^[A-Z]{2}$/.test(v) ? v : undefined);
const flag = (claim: string, field: string): Reader => (d) => (d[field] === true ? { claim } : undefined);
const country = (claim: string, field: string): Reader => (d) => {
  const value = iso2(d[field]);
  return value ? { claim, value } : undefined;
};

/** Passport stamps that rest on an identity someone else holds (a document, a phone, an exchange or social account). */
const IDENTITY_STAMP = /^(Holonym|Binance|Coinbase|Biometrics|Civic|CleanHands|TrustedCitizen|Google|Linkedin|Discord|Github|Twitter|Facebook|Steam|Brightid|Idena|Outdid|ZkEmail|Phone)/i;
/** What the most telling stamps mean, for display. */
export const PASSPORT_STAMPS: Record<string, string> = {
  HolonymGovIdProvider: 'dokument tożsamości (Holonym)',
  HolonymPhone: 'numer telefonu (Holonym)',
  CleanHands: 'dokument tożsamości i listy sankcyjne (Holonym)',
  Biometrics: 'biometria twarzy',
  CivicUniquenessPass: 'weryfikacja unikalności (Civic)',
  BinanceBABT: 'zweryfikowane konto Binance',
  CoinbaseDualVerification: 'zweryfikowane konto Coinbase',
  Google: 'konto Google',
  Linkedin: 'konto LinkedIn',
  Discord: 'konto Discord',
  Github: 'konto GitHub',
  Steam: 'konto Steam',
};

/** "BinanceBABT2", "githubContributionActivityGte#30" → "BinanceBABT", "Github": one name per kind of identity. */
function stampName(provider: string): string | undefined {
  const base = provider.split('#')[0].replace(/\d+$/, '');
  if (!IDENTITY_STAMP.test(base)) return undefined;
  if (/^github/i.test(base)) return 'Github';
  return base;
}

const passport: Reader = (d) => {
  const stamps = Array.isArray(d.stamps) ? d.stamps : [];
  const names: string[] = [];
  for (const s of stamps) {
    const provider = Array.isArray(s) ? (s as { name?: string; value?: unknown }[]).find((f) => f?.name === 'provider')?.value : undefined;
    const name = typeof provider === 'string' ? stampName(provider) : undefined;
    if (name && !names.includes(name)) names.push(name);
  }
  const value = names.length ? names.join(', ') : undefined;
  if (d.passing_score === true) return { claim: 'proof_of_personhood', value };
  return value ? { claim: 'identity_stamps', value } : undefined;
};

const BONDEX_ACCOUNTS = new Set(['discord', 'farcaster', 'github', 'linkedin', 'twitter', 'telegram', 'google', 'binance', 'coinbase']);
const bondex: Reader = (d) => {
  const type = typeof d.verification_type === 'string' ? d.verification_type.toLowerCase() : '';
  if (type === 'didit') return { claim: 'identity_check', value: 'Didit' };
  if (BONDEX_ACCOUNTS.has(type)) return { claim: 'linked_account', value: type === 'twitter' ? 'x' : type };
  return undefined; // a résumé, a score or "wallet activity" says nothing about who the owner is
};

const link3: Reader = (d) => {
  const parts: string[] = [];
  if (typeof d.twitterHandle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(d.twitterHandle)) parts.push(`x:${d.twitterHandle}`);
  if (typeof d.cyberID === 'string' && /^[a-z0-9_.-]{1,40}$/i.test(d.cyberID)) parts.push(`link3:${d.cyberID}`);
  return parts.length ? { claim: 'linked_account', value: parts.join(' ') } : undefined;
};

/** Attester address (as the index spells it) → who that is, and how to read each of its attestation types. */
export const EAS_ATTESTERS: Record<string, { issuer: string; schemas: Record<string, Reader> }> = {
  // Coinbase Verifications: the exchange's published attesting address on Base.
  '0x357458739F90461b99789350868CD7CF330Dd7EE': {
    issuer: 'Coinbase',
    schemas: {
      '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9': flag('verified_account', 'verifiedAccount'),
      '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065': country('verified_country', 'verifiedCountry'),
      '0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4': flag('verified_coinbase_one', 'verifiedCoinbaseOne'),
      '0xf82663c0eac879bed1e09e3d4598752359a321f51b38ae669728f480abf3f474': flag('verified_business_account', 'verifiedBusinessAccount'),
      '0xf87445e61219642b989807bc418e5d5fa8e3adb49e230891055a997121f6c80b': country('verified_business_country', 'verifiedBusinessCountry'),
    },
  },
  // Human Passport (formerly Gitcoin Passport): the only issuer of the "Human Passport" schema on Base.
  '0xCc90105D4A2aa067ee768120AdA19886021dF422': {
    issuer: 'Human Passport',
    schemas: { '0x1f3dce6501d8aad23563c0cf4f0c32264aed9311cb050056ebf72774f89ba912': passport },
  },
  // Bondex: issuer of over 99% of the "BONDEX VERIFICATIONS" schema.
  '0x1aE9c5732aB62d7BE70d087F23Bcc1cca33ddac9': {
    issuer: 'Bondex',
    schemas: { '0xf3ff6dd4a9dab34450af4e60df1eb41ca1e60fd719ce8645bbbed68aa84b489f': bondex },
  },
  // Link3 (CyberConnect). The name is read from what it attests (a "cyberID" and a link3.to profile), not from a published list.
  '0x2A2EA826102c067ECE82Bc6E2B7cf38D7EbB1B82': {
    issuer: 'Link3 (CyberConnect)',
    schemas: { '0xcfcf329b79035809704e8d33780714ddf7815a06490a94d57fac562937edbcef': link3 },
  },
};

interface Row {
  id: string;
  attester: string;
  time: number;
  expirationTime?: number;
  schemaId: string;
  decodedDataJson: string;
  schema?: { schemaNames?: { name: string }[] };
}

/** Flattens the index's decoded data ([{ name, value: { value } }]) into { name: value }. */
export function decodeAttestationData(json: string): Data {
  const out: Data = {};
  try {
    for (const f of JSON.parse(json) as { name?: string; value?: { value?: unknown } }[]) if (f?.name) out[f.name] = f.value?.value;
  } catch {
    // an attestation we cannot decode simply has no readable data
  }
  return out;
}

/** Turns the index's rows into attestations: known attesters by the table, others (if asked for) marked by their address. */
export function readAttestationRows(rows: Row[], address: string, origin: string, opts: { unknown?: boolean; now?: number } = {}): AddressAttestation[] {
  const now = (opts.now ?? Date.now()) / 1000;
  const out: AddressAttestation[] = [];
  const seen = new Set<string>();
  for (const a of [...rows].sort((x, y) => y.time - x.time)) {
    if (a.expirationTime && a.expirationTime > 0 && a.expirationTime < now) continue;
    const known = EAS_ATTESTERS[a.attester] ?? Object.entries(EAS_ATTESTERS).find(([k]) => k.toLowerCase() === a.attester.toLowerCase())?.[1];
    let issuer: string;
    let reading: Reading | undefined;
    if (known) {
      issuer = known.issuer;
      reading = known.schemas[a.schemaId.toLowerCase()]?.(decodeAttestationData(a.decodedDataJson));
    } else {
      if (!opts.unknown) continue;
      // Not a name: whoever this is, we cannot say. The address is shown so that nobody mistakes it for an institution.
      issuer = `${a.attester.slice(0, 6)}…${a.attester.slice(-4)}`;
      reading = { claim: a.schema?.schemaNames?.[0]?.name?.trim() || `schema ${a.schemaId.slice(0, 10)}…` };
    }
    if (!reading) continue;
    // An attester re-issues the same statement over time; the newest one stands for all of them.
    const key = `${issuer}|${reading.claim}|${reading.value ?? ''}`;
    const sameKind = `${issuer}|${reading.claim}`;
    if (seen.has(key) || ((reading.claim === 'proof_of_personhood' || reading.claim === 'identity_stamps') && seen.has(sameKind))) continue;
    seen.add(key);
    seen.add(sameKind);
    out.push({ chain: 'ethereum', address, issuer, claim: reading.claim, value: reading.value, uid: a.id, at: new Date(a.time * 1000).toISOString(), sourceUrl: `${origin}/attestation/view/${a.id}` });
  }
  return out;
}

/**
 * Every unrevoked, unexpired attestation about one address from the attesters in the table — a superset of
 * Coinbase's "verified account" and "verified country". With `unknown: true`, attestations by anyone else are
 * returned as well, with the attester's shortened address in place of a name.
 */
export async function walletAttestations(endpoint: string, address: string, ctx: ConnectorContext, opts: { unknown?: boolean } = {}): Promise<AddressAttestation[]> {
  const parsed = parseAddress(address);
  if (!parsed || parsed.chain !== 'ethereum') return [];
  const attesters = opts.unknown ? '' : `, attester: { in: ${JSON.stringify(Object.keys(EAS_ATTESTERS))} }`;
  const query = `{ attestations(take: 100, orderBy: [{ time: desc }], where: { recipient: { equals: "${parsed.address}", mode: insensitive }, revoked: { equals: false }${attesters} }) { id attester time expirationTime schemaId decodedDataJson schema { schemaNames { name } } } }`;
  const res = await ctx.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  if (res.status !== 200) return [];
  let rows: Row[] = [];
  try {
    rows = (JSON.parse(res.body) as { data?: { attestations?: Row[] } }).data?.attestations ?? [];
  } catch {
    return [];
  }
  return readAttestationRows(rows, address, new URL(endpoint).origin, opts);
}

/** What an attestation means, in one Polish clause, for receipts and reports. */
export function describeAttestation(a: Pick<AddressAttestation, 'issuer' | 'claim' | 'value'>): string {
  const accounts = (a.value ?? '').split(' ').filter(Boolean).map((v) => (v.includes(':') ? `${v.split(':')[0]}: ${v.split(':').slice(1).join(':')}` : v)).join(', ');
  switch (a.claim) {
    case 'verified_account':
      return `właściciel adresu jest zweryfikowanym klientem: ${a.issuer}`;
    case 'verified_country':
      return `właściciel adresu przeszedł weryfikację tożsamości w ${a.issuer}; kraj weryfikacji: ${a.value ?? 'nieznany'}`;
    case 'verified_coinbase_one':
      return `właściciel adresu ma płatny abonament w ${a.issuer} (giełda zna także jego dane płatnicze)`;
    case 'verified_business_account':
      return `adres należy do zweryfikowanego klienta firmowego: ${a.issuer}`;
    case 'verified_business_country':
      return `adres należy do klienta firmowego ${a.issuer}; kraj weryfikacji firmy: ${a.value ?? 'nieznany'}`;
    case 'proof_of_personhood':
      return `${a.issuer} potwierdza, że za adresem stoi jedna, rzeczywista osoba${a.value ? ` (podstawa: ${a.value.split(', ').map((s) => PASSPORT_STAMPS[s] ?? s).join(', ')})` : ''}`;
    case 'identity_stamps':
      return `${a.issuer}: właściciel adresu potwierdził ${a.value ? a.value.split(', ').map((s) => PASSPORT_STAMPS[s] ?? s).join(', ') : 'inne tożsamości'}`;
    case 'identity_check':
      return `${a.issuer} poświadcza, że właściciel adresu przeszedł weryfikację tożsamości (KYC) u dostawcy ${a.value ?? 'zewnętrznego'}`;
    case 'linked_account':
      return `${a.issuer} poświadcza, że właściciel adresu kontroluje konto: ${accounts || 'w innym serwisie'}`;
    default:
      return `${a.issuer}: ${a.claim}${a.value ? ` (${a.value})` : ''}`;
  }
}

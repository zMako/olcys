import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseAddress } from '@olcys/core';
import { PoliteClient } from './polite';

/**
 * Coinbase lets its verified customers put a public attestation on the Base network: "the owner of this wallet is a
 * verified Coinbase customer", and separately "…verified in country XX". The attestations are issued by Coinbase's
 * own address through the Ethereum Attestation Service and can be read by anyone.
 *
 * For a tax authority each one is two facts at once: the wallet belongs to someone verified in Poland, and an
 * exchange that can be asked knows who.
 */
export const EAS_BASE = 'https://base.easscan.org/graphql';
export const COINBASE_ATTESTER = '0x357458739F90461b99789350868CD7CF330Dd7EE';
export const VERIFIED_COUNTRY_SCHEMA = '0x1801901fabd0e6189356b4fb52bb0ab855276d84f7ec140839fbd1f6801ca065';

export interface CountryAttestation {
  /** Attestation id: with it anyone can look the attestation up. */
  uid: string;
  wallet: string;
  country: string;
  at: string;
  txHash?: string;
}

export const attestationsDir = (root: string, country: string) => `${root}/coinbase-${country.toLowerCase()}`;

export function readAttestations(root: string, country = 'PL'): CountryAttestation[] {
  const file = `${attestationsDir(root, country)}/attestations.jsonl`;
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CountryAttestation) : [];
}

/** Downloads every unrevoked "verified country" attestation for one country. A few requests; the list is small. */
export async function ingestCountryAttestations(root: string, country = 'PL', opts: { endpoint?: string } = {}): Promise<{ attestations: number; wallets: number; first?: string; last?: string }> {
  const client = new PoliteClient(2);
  const out: CountryAttestation[] = [];
  const seen = new Set<string>();
  for (let skip = 0; ; skip += 500) {
    const query = `{ attestations(take: 500, skip: ${skip}, orderBy: { time: asc }, where: { attester: { equals: "${COINBASE_ATTESTER}" }, schemaId: { equals: "${VERIFIED_COUNTRY_SCHEMA}" }, revoked: { equals: false }, decodedDataJson: { contains: "\\"value\\":\\"${country}\\"" } }) { id recipient time txid } }`;
    const res = await client.raw(opts.endpoint ?? EAS_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
    const page = ((JSON.parse(res.body) as { data?: { attestations?: { id: string; recipient: string; time: number; txid?: string }[] } }).data?.attestations ?? []);
    for (const a of page) {
      const wallet = parseAddress(a.recipient)?.address;
      if (!wallet || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ uid: a.id, wallet, country, at: new Date(a.time * 1000).toISOString(), txHash: a.txid });
    }
    if (page.length < 500) break;
  }
  const dir = attestationsDir(root, country);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/attestations.jsonl`, out.map((a) => JSON.stringify(a)).join('\n') + '\n');
  return { attestations: out.length, wallets: new Set(out.map((a) => a.wallet)).size, first: out[0]?.at, last: out[out.length - 1]?.at };
}

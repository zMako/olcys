import reportedData from '../data/reported.json';
import sanctionedData from '../data/sanctioned.json';

/**
 * Two public lists of addresses, bundled with the tool so that the check works without any network access:
 *  - addresses on the U.S. Treasury's sanctions list (OFAC SDN);
 *  - Ethereum addresses reported for fraud and phishing (MyEtherWallet's darklist).
 * Both are dated snapshots; the date of retrieval travels with every hit.
 */
export interface ListHit {
  /** The list the address is on, e.g. "OFAC SDN". */
  list: string;
  source: string;
  /** Day the bundled snapshot was taken. */
  retrieved: string;
  /** Sanctions: the assets under which the address is listed, e.g. ["ETH", "USDT"]. */
  listedAs?: string[];
  /** Fraud reports: what the report said, and when. */
  comment?: string;
  date?: string;
}

const SANCTIONED = sanctionedData.addresses as Record<string, Record<string, string[]>>;
const REPORTED = reportedData.addresses as Record<string, { comment: string; date?: string }>;
// Hexadecimal addresses mean the same in any letter case; the others are case-sensitive.
const key = (chain: string, address: string) => (chain === 'ethereum' ? address.trim().toLowerCase() : address.trim());

/** Whether the address is on the bundled sanctions list. An Ethereum address is the same key on every network that shares its format. */
export function sanctioned(chain: string, address: string): ListHit | undefined {
  const listedAs = SANCTIONED[chain]?.[key(chain, address)];
  return listedAs ? { list: sanctionedData.list, source: sanctionedData.source, retrieved: sanctionedData.retrieved, listedAs } : undefined;
}

/** Whether the address was publicly reported for fraud or phishing. A report is someone's claim, not a finding. */
export function reportedForFraud(chain: string, address: string): ListHit | undefined {
  const hit = chain === 'ethereum' ? REPORTED[key(chain, address)] : undefined;
  return hit ? { list: reportedData.list, source: reportedData.source, retrieved: reportedData.retrieved, comment: hit.comment, date: hit.date } : undefined;
}

/** What is bundled, for the list of sources. */
export const ADDRESS_LISTS = [
  { list: sanctionedData.list, origin: sanctionedData.origin, source: sanctionedData.source, retrieved: sanctionedData.retrieved, addresses: Object.values(SANCTIONED).reduce((n, m) => n + Object.keys(m).length, 0) },
  { list: reportedData.list, origin: reportedData.origin, source: reportedData.source, retrieved: reportedData.retrieved, addresses: Object.keys(REPORTED).length },
];

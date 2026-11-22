import type { Chain } from './chains';
import type { ConnectorContext } from './connector';
import type { AddressLabel } from './labels';

/**
 * What kind of account an address is.
 *  - eoa:            ordinary address controlled by a private key;
 *  - delegated_eoa:  ordinary address that delegates execution to a contract (EIP-7702) — still a person's wallet;
 *  - smart_wallet:   contract that is itself a wallet (e.g. a Safe) — may belong to a person;
 *  - contract:       any other code: token, exchange router, protocol.
 */
export type AccountKind = 'eoa' | 'delegated_eoa' | 'smart_wallet' | 'contract';

/** Byte patterns of well-known wallet proxies. `a619486e` is the masterCopy() selector every Safe proxy carries. */
const SMART_WALLET_MARKERS = ['a619486e'];

/**
 * Reads the kind of account from its bytecode.
 * "bytecode != 0x means smart contract" is no longer exact: since EIP-7702 a private
 * address may carry a 23-byte delegation marker (0xef0100 + address), and contract wallets are personal wallets.
 */
export function classifyCode(code: string | null | undefined): { kind: AccountKind; delegate?: string } {
  const c = (code ?? '').toLowerCase();
  if (c === '' || c === '0x') return { kind: 'eoa' };
  if (/^0xef0100[0-9a-f]{40}$/.test(c)) return { kind: 'delegated_eoa', delegate: '0x' + c.slice(8) };
  if (c.length <= 2 + 2 * 600 && SMART_WALLET_MARKERS.some((m) => c.includes(m))) return { kind: 'smart_wallet' };
  return { kind: 'contract' };
}

export interface AccountInfo {
  chain: Chain;
  address: string;
  kind: AccountKind;
  /** Bytecode as returned by the explorer ('0x' when there is none). */
  code: string;
  delegate?: string;
  labels: AddressLabel[];
  txCount: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  balances: { asset: string; amount: number }[];
  /** Evidence: the stored explorer response this was read from. */
  snapshotId?: string;
  sourceUrl?: string;
}

/** One movement of value. A swap is two transfers with the same txHash. */
export interface Transfer {
  chain: Chain;
  txHash: string;
  at: string;
  from: string;
  to: string;
  asset: string;
  amount: number;
  /** A network built on top of the chain where the transfer happened, e.g. "Base". Empty for the main network. */
  network?: string;
  /** Bitcoin: the other addresses that funded the same transaction as `from`. */
  coInputs?: string[];
  snapshotId?: string;
}

/**
 * Something an institution attests about an address in public — for instance an exchange stating on chain that
 * the address belongs to one of its verified customers. It does not say who the owner is; it says who knows.
 */
export interface AddressAttestation {
  chain: Chain;
  address: string;
  /** Who attests, e.g. "Coinbase". */
  issuer: string;
  /** What is attested: "verified_account" or "verified_country". */
  claim: string;
  /** For a country attestation, the ISO code. */
  value?: string;
  /** Attestation id, by which anyone can look it up. */
  uid: string;
  at?: string;
  sourceUrl?: string;
  /** What the attestation says, as a clause in plain words, written by the source that knows its meaning. */
  note?: string;
}

/** Claims issued by a party that checked the owner's identity documents: such an issuer can name the owner on request. */
const IDENTITY_CLAIMS = new Set(['verified_account', 'verified_country', 'verified_coinbase_one', 'verified_business_account', 'verified_business_country', 'identity_check']);
export const knowsIdentity = (a: Pick<AddressAttestation, 'claim'>): boolean => IDENTITY_CLAIMS.has(a.claim);

/** A contract and the address that created it. */
export interface Deployment {
  chain: Chain;
  contract: string;
  creator: string;
  txHash?: string;
  at?: string;
  sourceUrl?: string;
  snapshotId?: string;
}

/** A Web3 source (block explorer / node API). Adding a chain data provider = implementing this. */
export interface ChainConnector {
  id: string;
  descriptor: { name: string; chains: Chain[]; hosts: string[]; synthetic: boolean };
  supports(chain: Chain): boolean;
  getAccount(chain: Chain, address: string, ctx: ConnectorContext): Promise<AccountInfo>;
  getTransfers(chain: Chain, address: string, ctx: ConnectorContext): Promise<Transfer[]>;
  /** Which of these addresses carry a public label. Cheap (many addresses per request): it decides which counterparties deserve a full lookup. */
  getLabelled?(chain: Chain, addresses: string[], ctx: ConnectorContext): Promise<string[]>;
  /** Which address created a contract. Optional: needs an indexer, a plain node cannot answer it. */
  getCreator?(chain: Chain, contract: string, ctx: ConnectorContext): Promise<Deployment | undefined>;
  /** Contracts an address created. */
  getDeployed?(chain: Chain, address: string, ctx: ConnectorContext): Promise<Deployment[]>;
  /** Public attestations by institutions about the address (e.g. an exchange's "verified customer"). */
  getAttestations?(chain: Chain, address: string, ctx: ConnectorContext): Promise<AddressAttestation[]>;
}

/** Official average exchange rate, as published by the central bank. */
export interface RateQuote {
  currency: string;
  mid: number;
  /** Day the table was published. */
  effectiveDate: string;
  /** Table number, e.g. "238/A/NBP/2024". */
  table: string;
  source: string;
  url: string;
  snapshotId?: string;
}

/** Market price of a crypto asset on a day. */
export interface PriceQuote {
  asset: string;
  usd: number;
  date: string;
  source: string;
  url: string;
  snapshotId?: string;
}

interface ReferenceDescriptor {
  name: string;
  hosts: string[];
  synthetic: boolean;
}

/** Source of official fiat exchange rates (NBP table A). */
export interface RatesConnector {
  id: string;
  descriptor: ReferenceDescriptor;
  /** Average USD/PLN rate from the last table published before `date` (YYYY-MM-DD). */
  usdPlnBefore(date: string, ctx: ConnectorContext): Promise<RateQuote | undefined>;
}

/** Source of historical market prices of crypto assets. */
export interface PriceConnector {
  id: string;
  descriptor: ReferenceDescriptor;
  usdPrice(asset: string, date: string, ctx: ConnectorContext): Promise<PriceQuote | undefined>;
}

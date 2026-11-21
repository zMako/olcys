import type { AccountInfo, Identifier, NameRecord } from '@olcys/core';
import type { AmountMatch } from './amounts';
import type { ProfileHistory } from './history';
import type { WalletMember } from './indicators';

/** Everything a run established, in the shape the scoring needs. Scoring is a pure function of this and the ruleset. */
export interface RunFacts {
  seeds: Identifier[];
  documents: DocFact[];
  hits: HitFact[];
  mentions: MentionFact[];
  /** Signed messages found in documents, each with the result of verifying it. */
  proofs?: ProofFact[];
  accounts: AccountInfo[];
  /** Wallets found on chain: a published address and the addresses spent together with it. */
  wallets?: { chain: string; root: string; members: WalletMember[] }[];
  /** On-chain names of found addresses; `verified` means the address itself claimed the name. */
  names?: (NameRecord & { verified: boolean })[];
  /** Publicly stated amounts that correspond to transfers on the person's addresses. */
  amountMatches?: AmountMatch[];
  /** Readable source names by origin, e.g. { bitrozmowy: 'BitRozmowy' }. */
  sources?: Record<string, string>;
}

export interface DocFact {
  id: string;
  origin: string;
  connectorId: string;
  url: string;
  docType: string;
  title?: string;
  authorHandle?: string;
  authorDisplayName?: string;
  authorProfileUrl?: string;
  relation: string;
  container?: { kind: string; id?: string; title?: string; section?: string; url?: string; stats?: Record<string, number> };
  /** Leads the document itself lists (links, e-mail, phone, name). */
  discovered: Identifier[];
  publishedAt?: string;
  fetchedAt: string;
  snapshotSha256: string;
}

export interface HitFact {
  documentId: string;
  identifier: Identifier;
  relation: string;
}

export interface ProofFact {
  documentId: string;
  chain: string;
  address: string;
  message: string;
  valid: boolean;
  reason?: string;
}

export interface MentionFact {
  documentId: string;
  chain: string;
  address: string;
  segmentKind: string;
  quotedAuthor?: string;
  method: string;
  obfuscation: string[];
  raw: string;
  context: string;
  /** Set when the address was read from a picture rather than from the page text. */
  imageUrl?: string;
  imageSnapshotId?: string;
}

export type BandId = 'very_high' | 'probable' | 'medium' | 'noise' | 'excluded' | 'not_attributable';

/** Where an address stood, in the terms of the KAS method. */
export type Placement = 'own_profile' | 'sale' | 'discussion' | 'mass_comment' | 'quoted';

/**
 * How firmly a group of accounts is tied to what the analyst entered.
 *  - entered:        an account matches the entered nick / e-mail / phone / URL exactly;
 *  - publisher:      the analyst entered an address and this account published it;
 *  - handle_variant: matched by a nick that differs only in spelling (separators), with nothing else to tie it;
 *  - name_unique:    matched by name only, and it is the only account with that name;
 *  - name_ambiguous: matched by name only, and several unrelated accounts carry that name;
 *  - third_party:    someone else who merely appears in the material.
 */
export type ClusterLevel = 'entered' | 'publisher' | 'handle_variant' | 'name_unique' | 'name_ambiguous' | 'third_party';

export interface ClusterAccount {
  origin: string;
  /** Readable name of the service. */
  source: string;
  handle: string;
  profileUrl?: string;
  displayName?: string;
}

export interface Cluster {
  id: string;
  level: ClusterLevel;
  /** Upper limit this identity puts on every score in the cluster. */
  identityCap: number;
  identityNote: string;
  accounts: ClusterAccount[];
  /** Why the accounts are treated as one person. */
  joins: { rule: string; detail: string }[];
  /** Contact details and names the accounts list about themselves. */
  identifiers: Identifier[];
}

export interface Occurrence {
  documentId: string;
  url: string;
  origin: string;
  /** Readable name of the service. */
  source: string;
  docType: string;
  title?: string;
  authorHandle?: string;
  segmentKind: string;
  quotedAuthor?: string;
  placement: Placement;
  placementNote?: string;
  method: string;
  obfuscation: string[];
  raw: string;
  context: string;
  publishedAt?: string;
  fetchedAt: string;
  snapshotSha256: string;
  /** The photo the address was read from, if it was not in the page text. */
  image?: { url: string; snapshotId: string };
  /** Set when the occurrence comes from a stored past version of the page. */
  archivedAt?: string;
}

/** An argument against a link, so the analyst sees its weak points before relying on it. */
export interface Challenge {
  weight: 'duże' | 'średnie' | 'małe';
  text: string;
}

export interface ReceiptLine {
  rule: string;
  title: string;
  detail: string;
  effect: 'base' | 'bonus' | 'cap' | 'exclusion' | 'info';
  /** Points added (bonus) or the value set (base, cap, exclusion). Null for information-only lines. */
  points: number | null;
  /** Score after this line. */
  total: number;
  /** URLs of the sources this line rests on. */
  evidence: string[];
}

export interface Link {
  clusterId: string;
  chain: string;
  address: string;
  status: 'attributed' | 'excluded' | 'not_attributable';
  score: number;
  band: BandId;
  bandLabel: string;
  receipt: ReceiptLine[];
  occurrences: Occurrence[];
  /** Accounts outside the cluster that also published the address. */
  otherPublishers: ClusterAccount[];
  /** True when a signed message naming the account proves control of the address. */
  proven?: boolean;
  /** What could undermine the link, strongest first, and what would settle it. */
  challenges: Challenge[];
  wouldConfirm: string[];
  account?: Pick<AccountInfo, 'kind' | 'labels' | 'txCount' | 'firstSeenAt' | 'lastSeenAt' | 'balances' | 'delegate'>;
}

export interface Assessment {
  ruleset: { id: string; version: string; name: string };
  clusters: Cluster[];
  links: Link[];
  thirdPartyAccounts: number;
  /** How the subject's profiles changed over time, from archived versions. */
  histories: ProfileHistory[];
}

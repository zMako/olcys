import type { Fingerprint } from './fingerprints';
import type { Identifier } from './identifiers';

/** A piece of a document. The kind tells later rules where exactly an address stood. */
export type SegmentKind = 'title' | 'body' | 'bio' | 'readme' | 'signature' | 'contact' | 'quote' | 'link' | 'image' | 'archived' | 'price';

export interface Segment {
  kind: SegmentKind;
  text: string;
  /** For quotes: whose words these are (an address here does not belong to the document's author). */
  quotedAuthor?: string;
}

export type DocType = 'profile' | 'post' | 'ad' | 'repo' | 'page';

/** How the document relates to the identifier that led to it. */
export type Relation =
  /** The document is the account's own profile page. */
  | 'profile_owner'
  /** The document was written by the account. */
  | 'author'
  /** The document merely contains the identifier; its author may be someone else. */
  | 'mention';

/** A resource exactly as it was fetched. Stored in the evidence vault before any parsing. */
export interface FetchedResource {
  snapshotId: string;
  url: string;
  status: number;
  contentType: string;
  body: string;
  sha256: string;
  fetchedAt: string;
}

/** One attributable unit of content: a profile, a single post, an ad. */
export interface SourceItem {
  snapshotId: string;
  /** Link an analyst can open, including the fragment of the exact post. */
  url: string;
  /** Stable id within the source, e.g. "post:1042". */
  resourceId: string;
  docType: DocType;
  title?: string;
  author?: { handle?: string; displayName?: string; profileUrl?: string };
  publishedAt?: string;
  /** Where the item lives (thread, board, repository) — raw facts for later categorisation. */
  container?: { kind: string; id?: string; title?: string; section?: string; url?: string; stats?: Record<string, number> };
  relation: Relation;
  segments: Segment[];
  /** Pictures on the item (photos of goods, avatars). The engine reads codes in them. */
  images?: { url: string }[];
  /** New leads found on the item. The engine follows them only from the subject's own content. */
  discovered: Identifier[];
  /** Hashes and key fingerprints the profile shows (avatar e-mail hash, public keys). They identify the owner without naming them. */
  fingerprints?: Fingerprint[];
}

/** Extras for a request. Headers are sent but never stored, so access tokens do not end up in the evidence vault. */
export interface FetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Request body for POST (e.g. a JSON-RPC call to a blockchain node). Stored with the snapshot. */
  body?: string;
}

export interface ConnectorContext {
  /** The only way out to the network: enforces the allowlist and stores a snapshot of every response. */
  fetch(url: string, init?: FetchInit): Promise<FetchedResource>;
  log(message: string): void;
}

export interface ConnectorDescriptor {
  name: string;
  kind: 'forum' | 'code_hosting' | 'marketplace' | 'messenger' | 'social' | 'web_archive' | 'search';
  /**
   * Independence group. Two findings confirm each other only if their origins differ;
   * repeats within one service do not count (KAS synergy rule).
   */
  origin: string;
  /** host[:port] values this connector needs; all must be on the egress allowlist. */
  hosts: string[];
  /** True for the built-in test environment. */
  synthetic: boolean;
}

/** A Web2 source. Adding a source = implementing this interface and registering it. */
export interface SourceConnector {
  id: string;
  descriptor: ConnectorDescriptor;
  supports(identifier: Identifier): boolean;
  search(identifier: Identifier, ctx: ConnectorContext): AsyncGenerator<SourceItem>;
  /**
   * Nicks on this source that contain the given nick without being it ("szklanedomy" → "szklanedomy-labs").
   * They are candidates only: the engine reads them, and identity rules decide whether anything confirms them.
   */
  enumerate?(identifier: Identifier, ctx: ConnectorContext): Promise<string[]>;
}

/** A stored past version of a page in a web archive. */
export interface Capture {
  /** Archive's own timestamp id, e.g. "20240920101500". */
  timestamp: string;
  /** When the page was captured (ISO-8601). */
  at: string;
  /** Where the archived copy can be fetched. */
  url: string;
}

/** A web archive: tells which past versions of a page exist. */
export interface ArchiveConnector {
  id: string;
  descriptor: { name: string; hosts: string[]; synthetic: boolean };
  captures(url: string, ctx: ConnectorContext): Promise<Capture[]>;
}

/** A human-readable name bound to an address on chain (e.g. ENS), with the records its owner attached to it. */
export interface NameRecord {
  name: string;
  chain: string;
  address: string;
  /** Text records set by whoever controls the name, e.g. { "com.github": "login", "email": "…" }. */
  records: Record<string, string>;
  sourceUrl?: string;
  snapshotId?: string;
}

/** An on-chain name service. */
export interface NameService {
  id: string;
  descriptor: { name: string; hosts: string[]; synthetic: boolean };
  /** The address a name points to, with the name's records. */
  resolve(name: string, ctx: ConnectorContext): Promise<NameRecord | undefined>;
  /** The primary name of an address, confirmed by resolving it back, with its records. */
  reverse(chain: string, address: string, ctx: ConnectorContext): Promise<NameRecord | undefined>;
}

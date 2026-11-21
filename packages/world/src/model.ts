import type { Chain, LabelCategory } from '@olcys/core';
import type { EntityKind } from './data';
import type { Wallet } from './wallet';

export type Site = 'forum' | 'code' | 'ads';

export type Archetype = 'open_dev' | 'p2p_trader' | 'forum_talker' | 'giveaway_hunter' | 'careful' | 'fp_poster' | 'quoter' | 'hero' | 'namesake';

export interface Persona {
  id: string;
  fullName: string;
  city: string;
  email: string;
  phone: string;
  archetype: Archetype;
  handles: Partial<Record<Site, string>>;
  wallets: Wallet[];
}

export interface ForumUser {
  handle: string;
  personaId: string;
  /** Shown only if the user chose to publish their real name. */
  displayName?: string;
  location?: string;
  joinedAt: string;
  /** Signature over time; the last entry is current. Lets the time machine show address swaps. */
  signatureHistory: { from: string; text: string }[];
  website?: { site: Site; path: string };
}

export interface ForumPost {
  id: number;
  author: string;
  at: string;
  text: string;
  quote?: { author: string; text: string };
}

export interface ForumThread {
  id: number;
  board: string;
  title: string;
  posts: ForumPost[];
}

export interface CodeUser {
  handle: string;
  personaId: string;
  name?: string;
  bio: string;
  location?: string;
  email?: string;
  links: { label: string; site: Site; path: string }[];
  /** Profile README lines. `href` entries render as links whose address is only in the URL. */
  readme: { text: string; href?: string }[];
}

export interface CodeRepo {
  owner: string;
  name: string;
  description: string;
  readme: string;
  updatedAt: string;
}

export interface AdsSeller {
  handle: string;
  personaId: string;
  phone: string;
  email?: string;
  city: string;
  since: string;
}

export interface Ad {
  id: number;
  seller: string;
  title: string;
  body: string;
  price: string;
  city: string;
  at: string;
  /** What the QR code on the item's photo says, if the photo carries one. */
  qr?: string;
}

/** Bands from the KAS cheat sheet, plus two outcomes that must not be attributed at all. */
export type ExpectedBand = 'very_high' | 'probable' | 'medium' | 'noise' | 'excluded' | 'not_attributable';

/** Ground truth: one place where an address was published in the world. */
export interface Placement {
  address: string;
  chain: Chain;
  site: Site;
  path: string;
  resourceId: string;
  where: 'profile' | 'signature' | 'repo' | 'discussion' | 'giveaway' | 'ad' | 'quote';
  /** Who published it. */
  postedBy: string;
  /** Who really controls it; null for institutions and contracts. */
  ownerPersonaId: string | null;
  entity?: { name: string; kind: EntityKind };
  obfuscated: boolean;
  /** The address is not in the page text at all: it is only in a QR code on a photo. */
  viaImage?: boolean;
  /** Nothing on the web links this publication to the subject; only the blockchain does (same wallet). */
  viaWallet?: boolean;
  /** The address is no longer on the live page; it can only be found in archived versions. */
  archivedOnly?: boolean;
  /** What a correct tool should conclude about "postedBy owns this address". */
  expected: ExpectedBand;
}

export interface World {
  seed: string;
  /** Fixed "current time" of the world, so content dates never drift. */
  now: string;
  personas: Persona[];
  forum: { users: ForumUser[]; threads: ForumThread[] };
  code: { users: CodeUser[]; repos: CodeRepo[] };
  ads: { sellers: AdsSeller[]; ads: Ad[] };
  truth: Placement[];
  chain: WorldChain;
  /** Ground truth: signed messages posted on the forum and whether each is genuine. */
  proofs: { personaId: string; address: string; postId: number; valid: boolean; namesAccount: boolean }[];
  /** Ground truth: publicly stated amounts that correspond to a payment on one of the subject's addresses. */
  matches: { personaId: string; address: string; path: string; stated: string }[];
  /** Past captures of forum profiles kept by the web archive, by profile path. */
  archive: Record<string, string[]>;
}

/** A labelled address in the synthetic explorer: a fictional service or a real public institution. */
export interface ChainEntity {
  address: string;
  chain: Chain;
  name: string;
  category: LabelCategory;
  /** False for real mainnet addresses that are only described, never simulated. */
  synthetic: boolean;
}

export interface LedgerTx {
  hash: string;
  chain: Chain;
  at: string;
  legs: { from: string; to: string; asset: string; amount: number }[];
}

export interface WorldChain {
  entities: ChainEntity[];
  txs: LedgerTx[];
  /** Bytecode per address; absent means a plain address ('0x'). */
  codes: Record<string, string>;
  /** Ground truth: what a correct on-chain analysis should flag for an address. */
  expected: { address: string; personaId: string; indicators: string[] }[];
  /** Ground truth: addresses that belong to one wallet although only the first was ever published. */
  wallets: { root: string; members: string[] }[];
  /** On-chain names (like ENS): the address a name points to and the records its owner attached. */
  names: { name: string; address: string; personaId: string; records: Record<string, string> }[];
}

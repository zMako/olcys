import type { AddressLabel } from '@olcys/core';

/** What happened during a run, step by step. Stored in order; the interface replays it. */
export type RunEvent =
  | { type: 'run.started'; seeds: { kind: string; value: string }[] }
  /** An identifier was queued for searching: entered by the analyst or found on a document. */
  | { type: 'lead'; kind: string; value: string; depth: number; origin: 'seed' | 'discovered' | 'variant' | 'similar' | 'wallet' | 'name'; fromDocumentId?: string }
  | { type: 'search'; connectorId: string; source: string; kind: string; value: string }
  | {
      type: 'document'; documentId: string; connectorId: string; origin: string; source: string; docType: string; url: string; title?: string;
      handle?: string; displayName?: string; profileUrl?: string; relation: string; via: { kind: string; value: string }; section?: string;
    }
  /** An identifier led to a document that was already captured. */
  | { type: 'hit'; documentId: string; relation: string; via: { kind: string; value: string } }
  | { type: 'address'; documentId: string; chain: string; address: string; addressType: string; segmentKind: string; method: string; obfuscation: string[]; quotedAuthor?: string; imageUrl?: string; name?: string }
  /** A signed message was found and checked. */
  | { type: 'proof'; documentId: string; chain: string; address: string; valid: boolean }
  /** A stored past version of one of the subject's profiles was fetched. */
  | { type: 'archive'; documentId: string; origin: string; handle?: string; url: string; at: string }
  /** A profile showed different addresses over time. */
  | { type: 'history'; origin: string; handle: string; versions: number; changes: { kind: string; from?: string; to?: string; detail: string }[] }
  /** The explorer's answer about a found address. */
  | { type: 'account'; chain: string; address: string; kind: string; labels: AddressLabel[]; txCount: number }
  | { type: 'identities'; clusters: { id: string; level: string; identityCap: number; accounts: { origin: string; handle: string }[] }[] }
  | { type: 'link'; clusterId: string; chain: string; address: string; status: string; score: number; band: string; bandLabel: string; rule: string; reason: string; label?: string; proven?: boolean; lastRule?: string }
  | { type: 'ranked' }
  /** A hidden address of the person's wallet is being searched on the web. */
  | { type: 'trail'; chain: string; root: string; address: string; rule?: string }
  /** A publicly stated amount corresponds to a transfer on one of the person's addresses. */
  | { type: 'match'; documentId: string; chain: string; address: string; walletRoot: string; kind: string; statedRaw: string; unique: boolean; detail: string }
  /** More addresses were found to belong to the same wallet as a published one. */
  | { type: 'wallet'; chain: string; address: string; members: number; rule?: string }
  /** An address has claimed a name on chain; its records were written by whoever controls the name. */
  | { type: 'name'; chain: string; address: string; name: string; records: Record<string, string> }
  | { type: 'activity'; chain: string; address: string; transfers: number }
  | {
      type: 'indicator'; chain: string; address: string; indicatorType: string; rule: string; title: string; summary: string; cashOut: boolean; inferred?: boolean;
      totals: { asset: string; amount: number }[]; counterparties: { address: string; name?: string; category?: string }[];
    }
  | { type: 'estimate'; totalPln: number; years: { year: number; probablePln: number; possiblePln: number; totalPln: number }[] }
  /** An institution publicly vouches for the owner of an address. */
  | { type: 'attestation'; chain: string; address: string; issuer: string; claim: string; value?: string }
  /** The explorer says which address created a contract. */
  | { type: 'deployment'; chain: string; contract: string; creator: string; txHash?: string; at?: string }
  /** The person's posts were read: how many, how many were set aside as written by apps, and which look like statements about their own crypto. */
  | { type: 'reading'; posts: number; generated: number; read: number; statements: number }
  | { type: 'statement'; documentId: string; relevance: number; text: string; url?: string; at?: string }
  /** What changed since the previous analysis of the same case. */
  | {
      type: 'diff'; baseRunId: string; changed: boolean; summary: string;
      added: { chain: string; address: string }[]; rescored: { chain: string; address: string }[]; accounts: { origin: string; handle: string }[];
    }
  /** What the engine is doing during a long stretch that produces no finding yet (reading a busy wallet, pricing transfers). */
  | { type: 'progress'; phase: number; text: string }
  | { type: 'run.finished'; status: string; error?: string; counts: { documents: number; mentions: number; snapshots: number; denied: number } };

export type StoredRunEvent = RunEvent & { seq: number; at: string };

import { parseHtml, textOf } from '@olcys/connectors';
import {
  bundledLabel, extractAddresses, findCryptoAmounts, findPlnAmounts, findSignedMessages, identifierKey, makeIdentifier, usernameVariants, verifySignedMessage,
  type ArchiveConnector, type FetchInit, type NameRecord, type NameService, type SourceItem, type AccountInfo, type AddressLabel, type Chain, type ChainConnector, type Identifier, type PriceConnector, type PriceQuote,
  type RateQuote, type RatesConnector, type SourceConnector, type Transfer,
} from '@olcys/core';
import type { MentionView, Store } from '@olcys/db';
import {
  DEFAULT_RULESET, analyzeActivity, assess, buildEstimate, matchAmounts, valueTransfer, warsawDay,
  type ActivitySummary, type Assessment, type CandidateTransfer, type Estimate, type Indicator, type OffRamp, type Ruleset, type ValuedTransfer, type WalletMember,
} from '@olcys/scoring';
import { readImage } from '@olcys/vision';
import { EgressDeniedError, createEgress } from './egress';
import type { RunEvent } from './events';

export const ENGINE_VERSION = '0.7.0';

/** Search parameters of a run. Stored with the run so it can be repeated exactly. */
export interface RunParams {
  /** How many hops of discovered leads to follow from the seed identifiers. */
  maxDepth: number;
  /** Look up every address found in the subject's own content across all sources. */
  pivotOnAddresses: boolean;
  /** Hard cap on identifiers searched in one run. */
  maxIdentifiers: number;
  /** How many attributed addresses get a full on-chain analysis. */
  maxChainAddresses: number;
  /** How many counterparties per address are looked up for labels. */
  maxCounterparties: number;
  /** How many unlabelled recipients per wallet are followed one step further (to find exchange deposit addresses). */
  maxHops: number;
  /** How many pictures are read for codes in one run. */
  maxImages: number;
  /** For how many of the subject's profiles past versions are fetched, and how many versions of each. */
  maxArchivedProfiles: number;
  maxCapturesPerProfile: number;
  /** How many times the run goes from the blockchain back to the web with what it learned there. */
  maxRounds: number;
  /** How many hidden wallet addresses are searched on the web. */
  maxWalletSearches: number;
  /** How many of the subject's addresses are asked for their on-chain name. */
  maxNameLookups: number;
}

export const DEFAULT_PARAMS: RunParams = { maxDepth: 3, pivotOnAddresses: true, maxIdentifiers: 160, maxChainAddresses: 25, maxCounterparties: 40, maxHops: 8,
  maxImages: 40, maxArchivedProfiles: 6, maxCapturesPerProfile: 5, maxRounds: 3, maxWalletSearches: 30, maxNameLookups: 20,
};

export interface EngineDeps {
  store: Store;
  connectors: SourceConnector[];
  /** Block explorers. Without one, the run still scores links but skips on-chain facts. */
  chain?: ChainConnector[];
  /** Official exchange rates and market prices. Without both, the PLN estimate is skipped. */
  rates?: RatesConnector;
  prices?: PriceConnector;
  /** Web archive, for past versions of the subject's profiles. */
  archive?: ArchiveConnector;
  /** On-chain name service (ENS): names in text become addresses, and an address's own name gives new leads. */
  names?: NameService;
  /** Approved hosts. Connectors whose hosts are missing here cannot fetch anything. */
  allowlist: string[];
  ruleset?: Ruleset;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export interface AddressFinding {
  chain: string;
  address: string;
  addressType: string;
  checksum: string;
  /** Distinct independence groups (services) the address was seen in. */
  origins: string[];
  occurrences: MentionView[];
}

export interface AddressActivity {
  chain: string;
  /** The address found in open sources. */
  address: string;
  /** That address plus the addresses tied to it on chain. */
  wallet: WalletMember[];
  activity: ActivitySummary;
  indicators: Indicator[];
  offRamps: OffRamp[];
}

export interface RunSummary {
  runId: string;
  caseId: string;
  status: 'completed' | 'failed';
  error?: string;
  params: RunParams;
  identifiers: { kind: string; value: string; origin: string; depth: number }[];
  counts: { documents: number; mentions: number; snapshots: number; denied: number };
  /** Every address found, with every place it was seen (source facts). */
  addresses: AddressFinding[];
  /** Who the accounts belong to and how each address scores (computed results). */
  assessment?: Assessment & { id: string; createdAt: string };
  chain: { accounts: AccountInfo[]; activity: AddressActivity[] };
  /** Value in złoty of crypto sent to cash-out services (conclusion to verify). */
  estimate?: Estimate;
  /** On-chain names of found addresses (source facts). */
  names: (NameRecord & { verified: boolean })[];
}

/**
 * One analysis run. It works in rounds, going from the web to the blockchain and back:
 *  1. search every source for the entered identifiers and follow the leads found;
 *  2. extract and validate crypto addresses from text, pictures, signed messages and archived pages;
 *  3. ask the explorer what each address is, and score every person-to-address link;
 *  4. expand each attributed address into its wallet and analyse where the money went;
 *  5. search the wallet's hidden addresses back on the web — accounts that published them are the same
 *     person's, although nothing on the web connects them — read those accounts, and repeat from 3;
 *  6. match publicly stated amounts to transfers, score once more, and estimate the value in złoty.
 */
export async function runAnalysis(deps: EngineDeps, caseId: string, overrides: Partial<RunParams> = {}, trigger = 'manual'): Promise<RunSummary> {
  return (await beginRun(deps, caseId, overrides, trigger)).done;
}

interface WalletData {
  chain: Chain;
  root: string;
  wallet: WalletMember[];
  members: Set<string>;
  transfers: Transfer[];
  hops: Map<string, Transfer[]>;
}

/**
 * Starts a run and returns its id at once; `done` resolves when the run has finished.
 * Lets a caller follow the run's events while it is still working.
 */
export async function beginRun(
  deps: EngineDeps,
  caseId: string,
  overrides: Partial<RunParams> = {},
  trigger = 'manual',
): Promise<{ runId: string; done: Promise<RunSummary> }> {
  const { store, connectors } = deps;
  const chainConnectors = deps.chain ?? [];
  const ruleset = deps.ruleset ?? DEFAULT_RULESET;
  const log = deps.log ?? (() => {});
  const params: RunParams = { ...DEFAULT_PARAMS, ...overrides };
  const seeds = await store.caseIdentifiers(caseId);
  if (!seeds.length) throw new Error(`Case ${caseId} has no identifiers`);

  const run = await store.createRun(
    caseId,
    ENGINE_VERSION,
    {
      ...params,
      connectors: [
        ...connectors.map((c) => ({ id: c.id, name: c.descriptor.name, origin: c.descriptor.origin, hosts: c.descriptor.hosts, synthetic: c.descriptor.synthetic })),
        ...[...chainConnectors, ...(deps.rates ? [deps.rates] : []), ...(deps.prices ? [deps.prices] : []), ...(deps.archive ? [deps.archive] : []), ...(deps.names ? [deps.names] : [])].map((c) => ({
          id: c.id, name: c.descriptor.name, hosts: c.descriptor.hosts, synthetic: c.descriptor.synthetic,
        })),
      ],
      allowlist: deps.allowlist,
      ruleset: { id: ruleset.id, version: ruleset.version },
    },
    trigger,
  );
  let seq = 0;
  const emit = (event: RunEvent) => {
    const { type, ...payload } = event;
    return store.addEvent(run.id, ++seq, type, payload);
  };
  const egress = createEgress({ store, runId: run.id, allowlist: deps.allowlist, fetchImpl: deps.fetchImpl });
  const ctxFor = (id: string) => ({ fetch: (url: string, init?: FetchInit) => egress.text(id, url, init), log: (m: string) => log(`[${id}] ${m}`) });
  const accountKey = (origin: string, handle: string) => `${origin}:${handle.toLowerCase()}`;

  // ------------------------------------------------------------------ state shared by the stages
  // Identity leads are exhausted before address look-ups, so the subject's own pages are always
  // captured as theirs first and never as a page that merely mentions one of their addresses.
  const leadQueue: { id: Identifier; depth: number }[] = [];
  const addressQueue: { id: Identifier; depth: number }[] = [];
  const seen = new Set<string>();
  const ownProfiles: { connector: SourceConnector; via: Identifier; item: SourceItem; archived: boolean }[] = [];
  const ownAccounts = new Set<string>();
  let imagesRead = 0;
  let documentsCaptured = 0;
  const known = new Map<string, AccountInfo>(); // explorer answers
  const lookedUp = new Set<string>();
  const wallets = new Map<string, WalletData>(); // by published address
  const walletOf = new Map<string, string>(); // any member address → the published address it was reached from
  const searchedMembers = new Set<string>();
  const announced = new Map<string, string>();
  let announcedClusters = '';
  const announcedHistories = new Set<string>();
  const priceCache = new Map<string, Promise<PriceQuote | undefined>>();
  const rateCache = new Map<string, Promise<RateQuote | undefined>>();

  const resolved = new Map<string, Promise<NameRecord | undefined>>();
  const ownAddresses = new Set<string>(); // addresses the subject's own content shows
  const reversed = new Set<string>();
  const NAME = /(?<![\w.@-])((?:[a-z0-9][a-z0-9-]*\.)+eth)(?![\w-])/gi;

  type Origin = 'seed' | 'discovered' | 'variant' | 'wallet' | 'name';
  const enqueue = async (id: Identifier, depth: number, origin: Origin, documentId?: string) => {
    const key = identifierKey(id);
    if (seen.has(key) || depth > params.maxDepth || seen.size >= params.maxIdentifiers) return;
    seen.add(key);
    (origin !== 'seed' && id.kind === 'crypto_address' ? addressQueue : leadQueue).push({ id, depth });
    await store.addRunIdentifier(run.id, id, origin, depth, documentId);
    await emit({ type: 'lead', kind: id.kind, value: id.value, depth, origin, fromDocumentId: documentId });
  };

  // ------------------------------------------------------------------ 1 + 2: sources and extraction
  const crawl = async () => {
    while (leadQueue.length || addressQueue.length) {
      const { id, depth } = (leadQueue.length ? leadQueue : addressQueue).shift()!;
      for (const connector of connectors) {
        if (!connector.supports(id)) continue;
        log(`[${connector.id}] ${id.kind}: ${id.value}`);
        await emit({ type: 'search', connectorId: connector.id, source: connector.descriptor.name, kind: id.kind, value: id.value });
        try {
          for await (const item of connector.search(id, ctxFor(connector.id))) {
            const doc = await store.saveDocument(run.id, connector.id, connector.descriptor.origin, id, item);
            await store.addHit(run.id, doc.id, id, item.relation);
            const via = { kind: id.kind, value: id.value };
            if (!doc.created) {
              await emit({ type: 'hit', documentId: doc.id, relation: item.relation, via });
            } else {
              documentsCaptured++;
              await emit({
                type: 'document', documentId: doc.id, connectorId: connector.id, origin: connector.descriptor.origin, source: connector.descriptor.name,
                docType: item.docType, url: item.url, title: item.title, handle: item.author?.handle, displayName: item.author?.displayName,
                profileUrl: item.author?.profileUrl, relation: item.relation, via, section: item.container?.section,
              });
              await readDocument(connector, item, doc.id, depth);
            }
            const own = item.relation !== 'mention';
            // A profile reached as the subject's own counts as theirs even if the page was first seen as a mere mention.
            if (own && item.docType === 'profile' && item.author?.handle && !ownAccounts.has(accountKey(connector.descriptor.origin, item.author.handle))) {
              ownAccounts.add(accountKey(connector.descriptor.origin, item.author.handle));
              ownProfiles.push({ connector, via: id, item, archived: false });
            }
            // Leads are followed only from the subject's own content, never from pages that merely mention them.
            if (own && doc.created) for (const lead of item.discovered) await enqueue(lead, depth + 1, 'discovered', doc.id);
          }
        } catch (err) {
          if (err instanceof EgressDeniedError) log(`[${connector.id}] ${err.message}`);
          else throw err;
        }
      }
    }
  };

  /** Everything read from one newly captured document: addresses, stated amounts, signed messages, pictures. */
  const readDocument = async (connector: SourceConnector, item: SourceItem, documentId: string, depth: number) => {
    const own = item.relation !== 'mention';
    for (let i = 0; i < item.segments.length; i++) {
      const segment = item.segments[i];
      for (const mention of extractAddresses(segment.text)) {
        await store.saveMention(run.id, documentId, i, segment, mention);
        await emit({
          type: 'address', documentId, chain: mention.chain, address: mention.address, addressType: mention.addressType,
          segmentKind: segment.kind, method: mention.method, obfuscation: mention.obfuscation, quotedAuthor: segment.quotedAuthor,
        });
        if (own && segment.kind !== 'quote') ownAddresses.add(mention.address);
        // An address the subject published is itself a lead: who else shows it, and where?
        if (params.pivotOnAddresses && own && segment.kind !== 'quote') {
          await enqueue(makeIdentifier('crypto_address', mention.address), depth + 1, 'discovered', documentId);
        }
      }
      // A name instead of an address ("pay to someone.eth"): ask the chain which address it points to.
      const names = deps.names;
      if (names && segment.kind !== 'quote') {
        for (const m of segment.text.matchAll(NAME)) {
          const name = m[1].toLowerCase();
          if (!resolved.has(name)) resolved.set(name, names.resolve(name, ctxFor(names.id)).catch(() => undefined));
          const record = await resolved.get(name);
          const parsed = record && extractAddresses(record.address)[0];
          if (!record || !parsed) continue;
          await store.saveNameRecord(run.id, { ...record, verified: false });
          const at = m.index ?? 0;
          const mention = { ...parsed, method: 'ens' as const, raw: m[1], start: at, end: at + m[1].length, context: segment.text.slice(Math.max(0, at - 90), at + m[1].length + 90).replace(/\s+/g, ' ').trim() };
          await store.saveMention(run.id, documentId, i, segment, mention);
          await emit({ type: 'address', documentId, chain: mention.chain, address: mention.address, addressType: mention.addressType, segmentKind: segment.kind, method: 'ens', obfuscation: [], name });
          if (own) ownAddresses.add(mention.address);
          if (params.pivotOnAddresses && own) await enqueue(makeIdentifier('crypto_address', mention.address), depth + 1, 'discovered', documentId);
        }
      }
      // Amounts stated in public: an ad's asking price, a crypto amount mentioned in a post.
      if (segment.kind === 'price') {
        for (const v of findPlnAmounts(segment.text)) await store.saveStatedAmount(run.id, documentId, { ...v, kind: 'price' });
      } else if (item.docType === 'post' && segment.kind === 'body') {
        for (const v of findCryptoAmounts(segment.text)) await store.saveStatedAmount(run.id, documentId, { ...v, kind: 'text' });
      }
      // A signed message is mathematical proof of who held the key: verify every one found.
      if (segment.kind !== 'quote') {
        for (const signed of findSignedMessages(segment.text)) {
          const check = verifySignedMessage(signed);
          if (!check.chain || !check.address) continue;
          await store.saveProof(run.id, documentId, { chain: check.chain, address: check.address, message: signed.message, signature: signed.signature, valid: check.valid, reason: check.reason });
          await emit({ type: 'proof', documentId, chain: check.chain, address: check.address, valid: check.valid });
        }
      }
    }

    // Pictures: an address is often only in a QR code on a photo, where text search cannot see it.
    for (const image of (item.images ?? []).slice(0, 3)) {
      if (imagesRead >= params.maxImages) break;
      imagesRead++;
      try {
        const picture = await egress.bytes(connector.id, image.url);
        for (const reading of readImage(picture.bytes, picture.contentType)) {
          const segment = { kind: 'image' as const, text: reading.text };
          for (const found of extractAddresses(reading.text)) {
            const mention = { ...found, method: 'qr' as const, context: `Kod QR na zdjęciu: ${reading.text}` };
            await store.saveMention(run.id, documentId, item.segments.length, segment, mention, { url: picture.url, snapshotId: picture.snapshotId });
            await emit({
              type: 'address', documentId, chain: mention.chain, address: mention.address, addressType: mention.addressType,
              segmentKind: 'image', method: 'qr', obfuscation: [], imageUrl: picture.url,
            });
            if (params.pivotOnAddresses && own) await enqueue(makeIdentifier('crypto_address', mention.address), depth + 1, 'discovered', documentId);
          }
        }
      } catch (err) {
        log(`[${connector.id}] ${image.url}: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  // ------------------------------------------------------------------ 2b: past versions of the subject's profiles
  const archiveStage = async () => {
    const archive = deps.archive;
    if (!archive) return;
    for (const p of ownProfiles) {
      if (p.archived || ownProfiles.filter((x) => x.archived).length >= params.maxArchivedProfiles) continue;
      p.archived = true;
      try {
        const all = await archive.captures(p.item.url, ctxFor(archive.id));
        const max = params.maxCapturesPerProfile;
        const picked = all.length <= max ? all : Array.from({ length: max }, (_, i) => all[Math.round((i * (all.length - 1)) / (max - 1))]);
        for (const capture of picked) {
          const page = await egress.text(archive.id, capture.url);
          if (page.status !== 200) continue;
          const text = textOf(parseHtml(page.body)('body'));
          const item: SourceItem = {
            snapshotId: page.snapshotId, url: capture.url, resourceId: `archive:${capture.timestamp}:${p.item.resourceId}`, docType: 'profile',
            title: p.item.title, author: p.item.author, publishedAt: capture.at, relation: 'profile_owner',
            container: { kind: 'archive', id: capture.timestamp, url: p.item.url, title: archive.descriptor.name },
            segments: [{ kind: 'archived', text }], discovered: [],
          };
          const doc = await store.saveDocument(run.id, p.connector.id, p.connector.descriptor.origin, p.via, item);
          if (!doc.created) continue;
          documentsCaptured++;
          await emit({ type: 'archive', documentId: doc.id, origin: p.connector.descriptor.origin, handle: p.item.author?.handle, url: p.item.url, at: capture.at });
          for (const mention of extractAddresses(text)) {
            await store.saveMention(run.id, doc.id, 0, item.segments[0], mention);
            await emit({
              type: 'address', documentId: doc.id, chain: mention.chain, address: mention.address, addressType: mention.addressType,
              segmentKind: 'archived', method: mention.method, obfuscation: mention.obfuscation,
            });
          }
        }
      } catch (err) {
        log(`[${archive.id}] ${p.item.url}: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  // ------------------------------------------------------------------ 3: what is each address, and whose?
  const lookup = async (chain: Chain, address: string): Promise<AccountInfo | undefined> => {
    const key = `${chain}:${address}`;
    if (known.has(key)) return known.get(key);
    const connector = chainConnectors.find((c) => c.supports(chain));
    if (!connector) return undefined;
    try {
      const info = await connector.getAccount(chain, address, ctxFor(connector.id));
      await store.saveChainAccount(run.id, connector.id, info);
      known.set(key, info);
      return info;
    } catch (err) {
      log(`[${connector.id}] ${address}: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  };
  const lookupFound = async () => {
    for (const m of await store.mentions(run.id)) {
      const key = `${m.chain}:${m.address}`;
      if (lookedUp.has(key)) continue;
      lookedUp.add(key);
      const info = await lookup(m.chain as Chain, m.address);
      if (info) await emit({ type: 'account', chain: m.chain, address: m.address, kind: info.kind, labels: info.labels, txCount: info.txCount });
    }
    // The name an address claimed for itself, and what its owner wrote on it: leads that start on the chain.
    const names = deps.names;
    if (!names) return;
    for (const address of ownAddresses) {
      if (reversed.has(address) || reversed.size >= params.maxNameLookups) continue;
      reversed.add(address);
      const parsed = extractAddresses(address)[0];
      if (!parsed || parsed.chain !== 'ethereum') continue;
      const record = await names.reverse(parsed.chain, address, ctxFor(names.id)).catch(() => undefined);
      if (!record) continue;
      await store.saveNameRecord(run.id, { ...record, verified: true });
      await emit({ type: 'name', chain: record.chain, address, name: record.name, records: record.records });
      for (const [key, value] of Object.entries(record.records)) {
        if (['com.github', 'com.twitter', 'org.telegram'].includes(key)) await enqueue(makeIdentifier('username', value.replace(/^@/, '')), 1, 'name');
        else if (key === 'email') await enqueue(makeIdentifier('email', value), 1, 'name');
        else if (key === 'url' && /^https?:\/\//i.test(value)) await enqueue(makeIdentifier('profile_url', value), 1, 'name');
      }
    }
  };
  /** Reads sources and looks addresses up until neither produces anything new. */
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await crawl();
      await archiveStage();
      await lookupFound();
      if (!leadQueue.length && !addressQueue.length) break;
    }
  };
  const score = async () => assess(await store.runFacts(run.id), ruleset);
  const firmClusters = (a: Assessment) => a.clusters.filter((c) => c.level === 'entered' || c.level === 'publisher');

  /** Tells the interface what changed in who the person is and how each address scores. */
  const announce = async (a: Assessment) => {
    let changed = false;
    const clusters = a.clusters.map((c) => ({ id: c.id, level: c.level, identityCap: c.identityCap, accounts: c.accounts.map((x) => ({ origin: x.origin, handle: x.handle })) }));
    if (JSON.stringify(clusters) !== announcedClusters) {
      announcedClusters = JSON.stringify(clusters);
      await emit({ type: 'identities', clusters });
      changed = true;
    }
    for (const l of a.links) {
      const key = `${l.clusterId}|${l.chain}|${l.address}`;
      const state = `${l.status}|${l.score}|${l.proven ?? false}`;
      if (announced.get(key) === state) continue;
      announced.set(key, state);
      const last = l.receipt[l.receipt.length - 1];
      await emit({
        type: 'link', clusterId: l.clusterId, chain: l.chain, address: l.address, status: l.status, score: l.score, band: l.band, bandLabel: l.bandLabel,
        rule: l.receipt[0]?.rule ?? '', reason: l.receipt[0]?.title ?? '', label: l.account?.labels[0]?.name, proven: l.proven,
        lastRule: last?.rule,
      });
      changed = true;
    }
    for (const h of a.histories) {
      const key = `${h.origin}:${h.handle}`;
      if (!h.changes.length || announcedHistories.has(key)) continue;
      announcedHistories.add(key);
      await emit({ type: 'history', origin: h.origin, handle: h.handle, versions: h.versions.length, changes: h.changes.map((c) => ({ kind: c.kind, from: c.from, to: c.to, detail: c.detail })) });
    }
    if (changed) await emit({ type: 'ranked' });
  };

  // ------------------------------------------------------------------ 4: wallets and where the money went
  const labelsOf = (chain: Chain) => (address: string): AddressLabel[] => {
    const bundled = bundledLabel(chain, address);
    return [...(bundled ? [bundled] : []), ...(known.get(`${chain}:${address}`)?.labels ?? [])];
  };
  /** Other addresses of the same person: money moved between them is neither income nor spending. */
  const relatedTo = (a: Assessment, w: WalletData): string[] => {
    const mates = new Set(a.links.filter((l) => w.members.has(l.address) && l.status === 'attributed').map((l) => l.clusterId));
    return a.links.filter((l) => l.status === 'attributed' && mates.has(l.clusterId) && !w.members.has(l.address)).map((l) => l.address);
  };

  const analyseWallets = async (a: Assessment) => {
    const attributed = new Map<string, { chain: Chain; address: string }>();
    for (const l of a.links) if (l.status === 'attributed') attributed.set(`${l.chain}:${l.address}`, { chain: l.chain as Chain, address: l.address });
    for (const { chain, address } of attributed.values()) {
      const connector = chainConnectors.find((c) => c.supports(chain));
      if (!connector || walletOf.has(address) || wallets.size >= params.maxChainAddresses) continue;
      const ctx = ctxFor(connector.id);
      const labelled = labelsOf(chain);
      try {
        // Wallet expansion (W1): addresses that fund one transaction together are controlled by one party.
        const wallet: WalletMember[] = [{ address }];
        const members = new Set([address]);
        const transfers: Transfer[] = [];
        for (let i = 0; i < wallet.length; i++) {
          const own = await connector.getTransfers(chain, wallet[i].address, ctx);
          await store.saveTransfers(run.id, address, own);
          transfers.push(...own);
          for (const t of own) {
            if (t.from !== wallet[i].address || !t.coInputs?.length || t.coInputs.length >= ruleset.wallet.maxInputs) continue;
            for (const co of t.coInputs) {
              if (members.has(co) || members.size >= ruleset.wallet.maxAddresses) continue;
              await lookup(chain, co);
              if (labelled(co).length) continue; // a service's address is never part of a person's wallet
              members.add(co);
              wallet.push({ address: co, via: { txHash: t.txHash, with: wallet[i].address } });
            }
          }
        }
        for (const m of members) walletOf.set(m, address);
        if (wallet.length > 1) await emit({ type: 'wallet', chain, address, members: wallet.length });

        // Who did the wallet pay, and who paid it? Recipients first: leaving crypto is about where the money went.
        const outgoing = transfers.filter((t) => members.has(t.from) && !members.has(t.to));
        const parties = [...new Set([...outgoing.map((t) => t.to), ...transfers.filter((t) => members.has(t.to) && !members.has(t.from)).map((t) => t.from)])];
        for (const p of parties.slice(0, params.maxCounterparties)) await lookup(chain, p);

        // One step further for unlabelled recipients: did the money go on to an exchange?
        const hops = new Map<string, Transfer[]>();
        const byValue = new Map<string, number>();
        for (const t of outgoing) if (!labelled(t.to).length) byValue.set(t.to, (byValue.get(t.to) ?? 0) + t.amount);
        for (const [x] of [...byValue].sort((p, q) => q[1] - p[1]).slice(0, params.maxHops)) {
          const next = await connector.getTransfers(chain, x, ctx);
          hops.set(x, next);
          for (const to of new Set(next.filter((t) => t.from === x).map((t) => t.to))) await lookup(chain, to);
        }

        const data: WalletData = { chain, root: address, wallet, members, transfers, hops };
        wallets.set(address, data);
        let result = analyzeActivity({ addresses: [...members], related: relatedTo(a, data), transfers, labelsOf: labelled, hops, ruleset });

        // Deposit reuse (D2): an exchange gives each customer their own deposit address, so another address
        // paying into the same one belongs to the same customer.
        let siblings = 0;
        for (const off of result.offRamps) {
          if (!hops.has(off.depositAddress)) hops.set(off.depositAddress, await connector.getTransfers(chain, off.depositAddress, ctx));
          const paidIn = hops.get(off.depositAddress)!.filter((t) => t.to === off.depositAddress && !members.has(t.from));
          const senders = [...new Set(paidIn.map((t) => t.from))];
          if (!senders.length || senders.length > ruleset.depositReuse.maxOtherSenders) continue; // too many payers: not one customer's address
          for (const sender of senders) {
            if (members.size >= ruleset.wallet.maxAddresses) break;
            const info = await lookup(chain, sender);
            if (labelled(sender).length || info?.kind === 'contract') continue;
            members.add(sender);
            wallet.push({ address: sender, via: { txHash: paidIn.find((t) => t.from === sender)!.txHash, with: off.depositAddress }, rule: 'D2' });
            const own = await connector.getTransfers(chain, sender, ctx);
            await store.saveTransfers(run.id, address, own);
            transfers.push(...own);
            siblings++;
          }
        }
        if (siblings) {
          for (const m of members) walletOf.set(m, address);
          await emit({ type: 'wallet', chain, address, members: wallet.length, rule: 'D2' });
          result = analyzeActivity({ addresses: [...members], related: relatedTo(a, data), transfers, labelsOf: labelled, hops, ruleset });
        }
        await store.saveActivity(run.id, chain, address, { ...result, wallet });
        await emit({ type: 'activity', chain, address, transfers: result.activity.transfers });
        for (const i of result.indicators) {
          await emit({
            type: 'indicator', chain, address, indicatorType: i.type, rule: i.rule, title: i.title, summary: i.summary, cashOut: i.cashOut,
            inferred: i.inferred, totals: i.totals, counterparties: i.counterparties,
          });
        }
      } catch (err) {
        log(`[${connector.id}] ${address}: ${err instanceof Error ? err.message : err}`);
      }
    }
  };

  /** Recomputes every wallet's picture with the final knowledge of which addresses are the person's own. */
  const finalActivities = async (a: Assessment): Promise<AddressActivity[]> => {
    const out: AddressActivity[] = [];
    for (const w of wallets.values()) {
      const result = analyzeActivity({ addresses: [...w.members], related: relatedTo(a, w), transfers: w.transfers, labelsOf: labelsOf(w.chain), hops: w.hops, ruleset });
      await store.saveActivity(run.id, w.chain, w.root, { ...result, wallet: w.wallet });
      out.push({ chain: w.chain, address: w.root, wallet: w.wallet, ...result });
    }
    return out;
  };

  // ------------------------------------------------------------------ 5: from the blockchain back to the web
  /**
   * The wallet's hidden addresses are searched on the web. Whoever published one is tied to the wallet by the
   * blockchain itself, even if nothing on the web connects them to the person; such accounts are then read in full.
   * Returns true when this brought in anything new.
   */
  const closeLoop = async (): Promise<boolean> => {
    const before = documentsCaptured;
    for (const w of wallets.values()) {
      for (const m of w.wallet.slice(1)) {
        if (searchedMembers.has(m.address) || searchedMembers.size >= params.maxWalletSearches) continue;
        searchedMembers.add(m.address);
        await emit({ type: 'trail', chain: w.chain, root: w.root, address: m.address, rule: m.rule });
        await enqueue(makeIdentifier('crypto_address', m.address), 1, 'wallet');
      }
    }
    await crawl();
    for (const c of firmClusters(await score())) {
      for (const acc of c.accounts) {
        if (ownAccounts.has(accountKey(acc.origin, acc.handle)) || !acc.profileUrl) continue;
        await enqueue(makeIdentifier('profile_url', acc.profileUrl), 1, 'wallet');
      }
    }
    await settle();
    return documentsCaptured > before;
  };

  // ------------------------------------------------------------------ 6: stated amounts, and value in złoty
  const once = <T,>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
    if (!cache.has(key)) cache.set(key, load().catch(() => undefined as T));
    return cache.get(key)!;
  };
  const stable = new Set(ruleset.indicators.stablecoins);
  const priceOn = async (asset: string, day: string): Promise<PriceQuote | undefined> => {
    if (stable.has(asset)) return { asset, usd: 1, date: day, source: 'przyjęto 1 USD (stablecoin)', url: '' };
    const prices = deps.prices;
    return prices ? once(priceCache, `${asset}:${day}`, () => prices.usdPrice(asset, day, ctxFor(prices.id))) : undefined;
  };
  const rateBefore = async (day: string): Promise<RateQuote | undefined> => {
    const rates = deps.rates;
    return rates ? once(rateCache, day, () => rates.usdPlnBefore(day, ctxFor(rates.id))) : undefined;
  };

  /** Matches amounts the person stated in public (ad prices, amounts in posts) to transfers on their addresses. */
  const matchStated = async (a: Assessment): Promise<boolean> => {
    const firm = firmClusters(a);
    const accounts = new Set(firm.flatMap((c) => c.accounts.map((x) => accountKey(x.origin, x.handle))));
    const ids = new Set(firm.map((c) => c.id));
    const stated = (await store.statedAmounts(run.id)).filter((s) => s.authorHandle && accounts.has(accountKey(s.origin, s.authorHandle)));
    const roots = new Set(a.links.filter((l) => l.status === 'attributed' && ids.has(l.clusterId)).map((l) => walletOf.get(l.address) ?? l.address));
    if (!stated.length || !roots.size) return false;

    const DAY = 86_400_000;
    const windows = stated.filter((s) => s.unit === 'PLN' && s.at).map((s) => [Date.parse(s.at!) - DAY, Date.parse(s.at!) + ruleset.amountMatch.adWindowDays * DAY]);
    const candidates: CandidateTransfer[] = [];
    const used = new Set<string>();
    for (const w of wallets.values()) {
      if (!roots.has(w.root)) continue;
      for (const t of w.transfers) {
        const [mine, theirs] = [w.members.has(t.from), w.members.has(t.to)];
        const key = `${t.txHash}|${t.from}|${t.to}|${t.asset}`;
        if (mine === theirs || used.has(key)) continue;
        used.add(key);
        const c: CandidateTransfer = { ...t, address: theirs ? t.to : t.from, walletRoot: w.root, direction: theirs ? 'in' : 'out' };
        const when = Date.parse(t.at);
        if (theirs && windows.some(([from, to]) => when >= from && when <= to)) {
          const day = warsawDay(t.at);
          const [price, rate] = [await priceOn(t.asset, day), await rateBefore(day)];
          if (price && rate) {
            c.valuePln = Math.round(t.amount * price.usd * rate.mid * 100) / 100;
            c.rate = { mid: rate.mid, table: rate.table };
          }
        }
        candidates.push(c);
      }
    }
    const matches = matchAmounts(stated, candidates, ruleset);
    await store.saveAmountMatches(run.id, matches);
    for (const m of matches) {
      await emit({ type: 'match', documentId: m.documentId, chain: m.chain, address: m.address, walletRoot: m.walletRoot, kind: m.kind, statedRaw: m.statedRaw, unique: m.unique, detail: m.detail });
    }
    return matches.length > 0;
  };

  /** Value in złoty of what went to cash-out services. */
  const estimateStage = async (a: Assessment, analysed: AddressActivity[]) => {
    if (!deps.rates || !deps.prices) return;
    const firm = new Set(firmClusters(a).map((c) => c.id));
    const best = new Map<string, number>(); // published address of a wallet → its best score on a firmly tied account
    for (const l of a.links) {
      if (l.status !== 'attributed' || !firm.has(l.clusterId)) continue;
      const root = walletOf.get(l.address) ?? l.address;
      best.set(root, Math.max(best.get(root) ?? 0, l.score));
    }
    const valued: ValuedTransfer[] = [];
    const included: Estimate['addresses'] = [];
    const leftOut: Estimate['leftOut'] = [];
    for (const w of analysed) {
      const top = best.get(w.address);
      if (top === undefined || top < ruleset.estimate.minScore) {
        const any = a.links.find((l) => l.address === w.address && l.status === 'attributed');
        leftOut.push({
          chain: w.chain, address: w.address, score: any?.score ?? 0,
          reason: top === undefined ? 'konto dopasowane tylko po imieniu i nazwisku lub po podobnym nicku' : `wynik poniżej ${ruleset.estimate.minScore}%`,
        });
        continue;
      }
      included.push({ chain: w.chain, address: w.address, score: top, walletSize: w.wallet.length });
      for (const ind of w.indicators) {
        if (!ind.certainty) continue;
        for (const t of ind.transfers) {
          const day = warsawDay(t.at);
          const party = ind.counterparties.find((c) => c.address === t.to);
          valued.push(valueTransfer(t, { channel: ind.type, channelTitle: ind.title, certainty: ind.certainty, counterparty: party?.name }, await priceOn(t.asset, day), await rateBefore(day)));
        }
      }
    }
    const estimate = buildEstimate(valued, { minScore: ruleset.estimate.minScore, addresses: included, leftOut });
    await store.saveEstimate(run.id, estimate);
    await emit({
      type: 'estimate', totalPln: estimate.totalPln,
      years: estimate.years.map((y) => ({ year: y.year, probablePln: y.probablePln, possiblePln: y.possiblePln, totalPln: y.totalPln })),
    });
  };

  // ------------------------------------------------------------------ the run
  const execute = async (): Promise<RunSummary> => {
    let status: 'completed' | 'failed' = 'completed';
    let error: string | undefined;
    try {
      await emit({ type: 'run.started', seeds: seeds.map((x) => ({ kind: x.kind, value: x.value })) });
      for (const seed of seeds) await enqueue(seed, 0, 'seed');
      // People keep a nick across sites but change its spelling; try the same letters with other separators.
      for (const seed of seeds) {
        if (seed.kind === 'username') for (const v of usernameVariants(seed.value)) await enqueue(makeIdentifier('username', v), 0, 'variant');
      }
      await settle();
      let assessment = await score();
      await announce(assessment);

      // Web → chain → web, until the chain reveals nothing new.
      for (let round = 0; round < params.maxRounds; round++) {
        await analyseWallets(assessment);
        if (!(await closeLoop())) break;
        assessment = await score();
        await announce(assessment);
      }
      await analyseWallets(assessment);
      let analysed = await finalActivities(assessment);

      if (await matchStated(assessment)) {
        assessment = await score();
        await announce(assessment);
        analysed = await finalActivities(assessment);
      }
      await store.saveAssessment(run.id, ruleset, assessment);
      await estimateStage(assessment, analysed);
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
    }

    const counts = await store.counts(run.id);
    await emit({ type: 'run.finished', status, error, counts });
    await store.finishRun(run.id, status, counts, error);
    return { ...(await summarizeRun(store, run.id)), status, error };
  };

  return { runId: run.id, done: execute() };
}

/** Scores a stored run again, e.g. with changed rules. The earlier assessment is kept. */
export async function reassessRun(store: Store, runId: string, ruleset: Ruleset = DEFAULT_RULESET): Promise<RunSummary> {
  await store.saveAssessment(runId, ruleset, assess(await store.runFacts(runId), ruleset));
  return summarizeRun(store, runId);
}

/** Rebuilds the summary of any stored run. */
export async function summarizeRun(store: Store, runId: string): Promise<RunSummary> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const byAddress = new Map<string, AddressFinding>();
  for (const m of await store.mentions(runId)) {
    const key = `${m.chain}:${m.address}`;
    let f = byAddress.get(key);
    if (!f) byAddress.set(key, (f = { chain: m.chain, address: m.address, addressType: m.address_type, checksum: m.checksum, origins: [], occurrences: [] }));
    if (!f.origins.includes(m.origin)) f.origins.push(m.origin);
    if (m.checksum === 'valid') f.checksum = 'valid';
    f.occurrences.push(m);
  }
  const a = await store.latestAssessment<Ruleset, Assessment['clusters'], Assessment['links'][number], Assessment['histories']>(runId);
  const thirdParties = new Set<string>();
  if (a) {
    const subjectAccounts = new Set(a.clusters.flatMap((c) => c.accounts.map((x) => `${x.origin}:${x.handle.toLowerCase()}`)));
    for (const f of byAddress.values()) {
      for (const o of f.occurrences) {
        const k = o.author_handle ? `${o.origin}:${o.author_handle.toLowerCase()}` : undefined;
        if (k && !subjectAccounts.has(k)) thirdParties.add(k);
      }
    }
  }
  return {
    runId,
    caseId: run.case_id,
    status: run.status as RunSummary['status'],
    error: run.error ?? undefined,
    params: run.params as RunParams,
    identifiers: (await store.runIdentifiers(runId)).map((i) => ({ kind: i.kind, value: i.value, origin: i.origin, depth: i.depth })),
    counts: await store.counts(runId),
    addresses: [...byAddress.values()],
    assessment: a && {
      id: a.id,
      createdAt: String(a.createdAt),
      ruleset: { id: a.ruleset.id, version: a.ruleset.version, name: a.ruleset.name },
      clusters: a.clusters,
      histories: a.histories ?? [],
      links: a.links,
      thirdPartyAccounts: thirdParties.size,
    },
    chain: { accounts: await store.chainAccounts(runId), activity: await store.activities<AddressActivity>(runId) },
    estimate: await store.estimate<Estimate>(runId),
    names: await store.nameRecords<NameRecord & { verified: boolean }>(runId),
  };
}

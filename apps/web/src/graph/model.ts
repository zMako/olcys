import type { StoredRunEvent } from '@olcys/engine';
import { CATEGORY, CHAIN_CODE, DOC, KIND, LEAD, SEGMENT, amounts, shortAddress, sourceName } from '../pl';

export type NodeType = 'seed' | 'account' | 'address' | 'service' | 'estimate';

export interface GNode {
  id: string;
  type: NodeType;
  col: 0 | 1 | 2 | 3;
  title: string;
  sub?: string;
  firstSeq: number;
  // account
  origin?: string;
  handle?: string;
  profileUrl?: string;
  clusterId?: string;
  clusterLevel?: string;
  thirdParty?: boolean;
  // address
  chain?: string;
  address?: string;
  accountKind?: string;
  label?: string;
  link?: { clusterId: string; status: string; score: number; band: string; rule: string; reason: string };
  /** A signed message proves control of the address. */
  proven?: boolean;
  /** Not present in the previous analysis of this case. */
  fresh?: boolean;
  /** Nothing on the web ties this account to the person; it was found through the person's wallet. */
  viaWallet?: boolean;
  /** Found because its nick contains the entered one; only a hard identifier makes it the person's. */
  viaSimilar?: boolean;
  /** The profile showed a different address in the past. */
  changed?: boolean;
  /** Number of addresses in the same wallet, once known. */
  walletSize?: number;
  // service
  category?: string;
  cashOut?: boolean;
  /** Every address of this service the money went to (an exchange can have several). */
  addresses?: string[];
  // estimate
  years?: { year: number; probablePln: number; possiblePln: number; totalPln: number }[];
  totalPln?: number;
}

export interface GEdge {
  id: string;
  from: string;
  to: string;
  kind: 'match' | 'lead' | 'published' | 'flow' | 'wallet';
  label: string;
  /** Lead that rests on a name only. */
  weak?: boolean;
  /** Every occurrence behind this edge is a quote of someone else. */
  quoteOnly?: boolean;
  thirdParty?: boolean;
  cashOut?: boolean;
  firstSeq: number;
}

export interface ClusterInfo {
  id: string;
  level: string;
  identityCap: number;
  accounts: { origin: string; handle: string }[];
}

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  clusters: ClusterInfo[];
  ranked: boolean;
  /** Publicly stated amounts that correspond to transfers. */
  matches: { address: string; detail: string; unique: boolean }[];
  /** Profiles that showed different addresses over time. */
  histories: { origin: string; handle: string; changes: { kind: string; from?: string; to?: string; detail: string }[] }[];
  finished: boolean;
  /** Nodes changed by the most recent event. */
  touched: string[];
}

const accountId = (origin: string, handle: string) => `acc:${origin}:${handle.toLowerCase()}`;
export const addressId = (chain: string, address: string) => `addr:${chain}:${address}`;
const leadKey = (kind: string, value: string) => `${kind}:${value.trim().toLowerCase()}`;

/** Builds the evidence graph from the first `count` events of a run. Pure, so any moment of a run can be shown. */
export function buildGraph(events: StoredRunEvent[], count = events.length): Graph {
  const nodes = new Map<string, GNode>();
  const edges = new Map<string, GEdge>();
  const leadSource = new Map<string, string>(); // lead → node that listed it
  const docAccount = new Map<string, string>();
  const docInfo = new Map<string, { docType: string; relation: string }>();
  const placements = new Map<string, Set<string>>(); // edge → where the address stood
  const quotes = new Map<string, { quote: number; other: number }>();
  let clusters: ClusterInfo[] = [];
  let ranked = false;
  const histories: Graph['histories'] = [];
  const variants = new Set<string>(); // other spellings of the entered nick
  const similars = new Set<string>(); // nicks that merely contain the entered one
  const matches: Graph['matches'] = [];
  const trailRoot = new Map<string, { root: string; label: string }>(); // hidden address → node of the published address it is tied to
  let finished = false;
  let touched: string[] = [];

  const edge = (e: GEdge) => {
    if (!edges.has(e.id)) edges.set(e.id, e);
    return edges.get(e.id)!;
  };
  const enteredAddress = new Map<string, string>(); // address as entered → its seed node
  const leadEdge = (via: { kind: string; value: string }, target: string | undefined, seq: number) => {
    const src = leadSource.get(leadKey(via.kind, via.value));
    if (!src || !target || src === target) return;
    const fromSeed = nodes.get(src)?.type === 'seed';
    const variant = variants.has(leadKey(via.kind, via.value));
    const similar = similars.has(leadKey(via.kind, via.value));
    // Two profiles that link to each other are one connection, not two.
    const back = edges.get(`${target}>${src}:${via.kind}`);
    if (back) {
      if (via.kind === 'profile_url') back.label = 'odnośniki';
      return;
    }
    edge({
      id: `${src}>${target}:${via.kind}`, from: src, to: target, kind: fromSeed ? 'match' : 'lead',
      label: similar ? 'nick z dopiskiem' : variant ? 'podobny nick' : fromSeed ? (KIND[via.kind] ?? via.kind) : (LEAD[via.kind] ?? via.kind), weak: via.kind === 'full_name' || variant || similar, firstSeq: seq,
    });
  };

  for (const e of events.slice(0, count)) {
    touched = [];
    switch (e.type) {
      case 'lead': {
        const key = leadKey(e.kind, e.value);
        if (e.origin === 'seed') {
          const id = `seed:${key}`;
          nodes.set(id, { id, type: 'seed', col: 0, title: e.kind === 'crypto_address' ? shortAddress(e.value) : e.value, sub: KIND[e.kind] ?? e.kind, firstSeq: e.seq });
          if (e.kind === 'crypto_address') enteredAddress.set(e.value.trim().toLowerCase(), id);
          leadSource.set(key, id);
          touched = [id];
        } else if (e.origin === 'variant') {
          // Another spelling of the entered nick is tried from the same starting point.
          const seed = [...nodes.values()].find((n) => n.type === 'seed');
          if (seed) leadSource.set(key, seed.id);
          variants.add(key);
        } else if (e.origin === 'similar') {
          const seed = [...nodes.values()].find((n) => n.type === 'seed');
          if (seed) leadSource.set(key, seed.id);
          similars.add(key);
        } else if (e.origin === 'wallet') {
          // searched because the blockchain pointed here; the edge is drawn when an account turns up
        } else if (e.kind !== 'crypto_address' && e.fromDocumentId && docAccount.has(e.fromDocumentId) && !leadSource.has(key)) {
          leadSource.set(key, docAccount.get(e.fromDocumentId)!);
        }
        break;
      }
      case 'document': {
        docInfo.set(e.documentId, { docType: e.docType, relation: e.relation });
        if (!e.handle) break;
        const id = accountId(e.origin, e.handle);
        const existing = nodes.get(id);
        if (!existing) {
          nodes.set(id, {
            id, type: 'account', col: 1, title: e.handle, sub: sourceName(e.source), firstSeq: e.seq, origin: e.origin, handle: e.handle,
            profileUrl: e.profileUrl, thirdParty: e.relation === 'mention',
          });
        } else if (e.relation !== 'mention') {
          existing.thirdParty = false;
        }
        docAccount.set(e.documentId, id);
        if (e.relation !== 'mention' && similars.has(leadKey(e.via.kind, e.via.value))) nodes.get(id)!.viaSimilar = true;
        if (e.relation !== 'mention') leadEdge(e.via, id, e.seq);
        touched = [id];
        break;
      }
      case 'hit':
        if (e.relation !== 'mention') leadEdge(e.via, docAccount.get(e.documentId), e.seq);
        break;
      case 'diff':
        for (const a of e.added) {
          const n = nodes.get(addressId(a.chain, a.address));
          if (n) n.fresh = true;
        }
        for (const a of e.accounts) {
          const n = nodes.get(accountId(a.origin, a.handle));
          if (n) n.fresh = true;
        }
        touched = [...e.added.map((a) => addressId(a.chain, a.address)), ...e.rescored.map((a) => addressId(a.chain, a.address))];
        break;
      case 'trail': {
        const root = addressId(e.chain, e.root);
        trailRoot.set(e.address, { root, label: e.rule === 'D2' ? 'ten sam klient giełdy' : e.rule === 'K3' ? 'kontrakt z tego adresu' : 'ten sam portfel' });
        touched = [root];
        break;
      }
      case 'match': {
        matches.push({ address: e.address, detail: e.detail, unique: e.unique });
        const n = nodes.get(addressId(e.chain, e.walletRoot)) ?? nodes.get(addressId(e.chain, e.address));
        if (n) touched = [n.id];
        break;
      }
      case 'archive':
        if (e.handle) {
          docAccount.set(e.documentId, accountId(e.origin, e.handle));
          docInfo.set(e.documentId, { docType: 'archive', relation: 'profile_owner' });
        }
        break;
      case 'proof': {
        const n = nodes.get(addressId(e.chain, e.address));
        if (n) touched = [n.id];
        break;
      }
      case 'history': {
        histories.push({ origin: e.origin, handle: e.handle, changes: e.changes });
        const n = nodes.get(accountId(e.origin, e.handle));
        if (n) {
          n.changed = true;
          touched = [n.id];
        }
        break;
      }
      case 'address': {
        const id = addressId(e.chain, e.address);
        if (!nodes.has(id)) nodes.set(id, { id, type: 'address', col: 2, title: `${e.address.slice(0, 8)}…${e.address.slice(-5)}`, firstSeq: e.seq, chain: e.chain, address: e.address });
        const acc = docAccount.get(e.documentId);
        if (acc) {
          const eid = `${acc}>${id}`;
          const info = docInfo.get(e.documentId);
          const where =
            e.method === 'qr' ? 'kod QR na zdjęciu'
            : info?.docType === 'archive' ? 'archiwum'
            : e.segmentKind === 'quote' || e.segmentKind === 'signature' ? SEGMENT[e.segmentKind]
            : (DOC[info?.docType ?? ''] ?? 'treść');
          placements.set(eid, (placements.get(eid) ?? new Set()).add(e.method === 'deployer' ? 'twórca kontraktu' : e.method === 'plain' || e.method === 'qr' ? where : `${where}, adres ukryty`));
          const q = quotes.get(eid) ?? { quote: 0, other: 0 };
          if (e.segmentKind === 'quote') q.quote++;
          else q.other++;
          quotes.set(eid, q);
          const ed = edge({ id: eid, from: acc, to: id, kind: 'published', label: '', firstSeq: e.seq });
          ed.label = [...placements.get(eid)!].join(', ');
          ed.quoteOnly = q.other === 0;
          // The account advertises a hidden address of the person's wallet: the blockchain ties the two together.
          const tie = trailRoot.get(e.address);
          if (tie && e.segmentKind !== 'quote' && nodes.has(tie.root)) {
            edge({ id: `${acc}>wallet>${tie.root}`, from: acc, to: tie.root, kind: 'wallet', label: tie.label, firstSeq: e.seq });
            nodes.get(acc)!.viaWallet = true;
          }
        }
        touched = [id];
        break;
      }
      case 'account': {
        const n = nodes.get(addressId(e.chain, e.address));
        if (n) {
          n.accountKind = e.kind;
          n.label = e.labels[0]?.name;
          touched = [n.id];
        }
        break;
      }
      case 'identities': {
        clusters = e.clusters;
        const member = new Map<string, ClusterInfo>();
        for (const c of clusters) for (const a of c.accounts) member.set(accountId(a.origin, a.handle), c);
        for (const n of nodes.values()) {
          if (n.type !== 'account') continue;
          const c = member.get(n.id);
          n.clusterId = c?.id;
          n.clusterLevel = c?.level;
          n.thirdParty = !c;
          if (c) touched.push(n.id);
        }
        break;
      }
      case 'link': {
        // An address the analyst entered has no page it was found on: its node appears with its score, tied to what was entered.
        const entered = enteredAddress.get(e.address.toLowerCase());
        if (entered && !nodes.has(addressId(e.chain, e.address))) {
          const id = addressId(e.chain, e.address);
          nodes.set(id, { id, type: 'address', col: 2, title: `${e.address.slice(0, 8)}…${e.address.slice(-5)}`, firstSeq: e.seq, chain: e.chain, address: e.address });
          edge({ id: `${entered}>${id}:entered`, from: entered, to: id, kind: 'match', label: 'wprowadzony adres', firstSeq: e.seq });
        }
        const n = nodes.get(addressId(e.chain, e.address));
        // A later scoring replaces an earlier one; a link on a firmer identity wins over one on a weaker identity.
        if (n && (!n.link || e.clusterId <= n.link.clusterId)) {
          n.link = { clusterId: e.clusterId, status: e.status, score: e.score, band: e.band, rule: e.rule, reason: e.reason };
          n.label ??= e.label;
          n.proven = e.proven;
          touched = [n.id];
        }
        break;
      }
      case 'ranked':
        ranked = true;
        break;
      case 'wallet': {
        const n = nodes.get(addressId(e.chain, e.address));
        if (n) {
          n.walletSize = e.members;
          touched = [n.id];
        }
        break;
      }
      case 'indicator': {
        const from = addressId(e.chain, e.address);
        e.counterparties.forEach((c, i) => {
          // "BałtykEx: adres depozytowy" → name on the first line, kind of service and role on the second.
          const [head, ...rest] = (c.name ?? shortAddress(c.address)).split(': ');
          const kind = CATEGORY[c.category ?? 'other'] ?? 'usługa';
          const role = rest.join(': ');
          // One node per service, whatever the chain: flows from different addresses to the same exchange meet in one place.
          const id = c.name ? `svc:${head}:${kind}` : `svc:${c.address}`;
          const n = nodes.get(id) ?? {
            id, type: 'service' as const, col: 3 as const, title: head, sub: role && role.toLowerCase() !== kind && kind.length + role.length <= 26 ? `${kind}, ${role}` : kind,
            firstSeq: e.seq, address: c.address, chain: e.chain, category: c.category, addresses: [] as string[],
          };
          if (!n.addresses!.includes(c.address)) n.addresses!.push(c.address);
          n.cashOut = n.cashOut || e.cashOut;
          nodes.set(id, n);
          edge({ id: `${from}>${id}:${e.indicatorType}`, from, to: id, kind: 'flow', label: i === 0 ? amounts(e.totals) : '', cashOut: e.cashOut, firstSeq: e.seq });
          touched.push(id);
        });
        break;
      }
      case 'estimate':
        if (e.years.length) {
          nodes.set('estimate', { id: 'estimate', type: 'estimate', col: 3, title: 'Do wyjaśnienia', firstSeq: e.seq, years: e.years, totalPln: e.totalPln });
          touched = ['estimate'];
        }
        break;
      case 'run.finished':
        finished = true;
        break;
      default:
        break;
    }
  }

  for (const ed of edges.values()) if (ed.kind === 'published') ed.thirdParty = nodes.get(ed.from)?.thirdParty;
  // Mark chain codes on address titles' sub line once known.
  for (const n of nodes.values()) if (n.type === 'address') n.sub = CHAIN_CODE[n.chain ?? ''] ?? n.chain;

  return { nodes: [...nodes.values()], edges: [...edges.values()], clusters, ranked, histories, matches, finished, touched };
}

// ------------------------------------------------------------------ layout

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  boxes: Map<string, Box>;
  /** Outlines around accounts that belong to one person. */
  groups: { id: string; level: string; identityCap: number; box: Box }[];
  /** Vertical position of the "other accounts" caption, if any. */
  othersY?: number;
  columns: { x: number; w: number; title: string }[];
}

export const COLUMNS = [
  { x: 12, w: 140, title: 'Co wpisano' },
  { x: 226, w: 200, title: 'Konta w sieci' },
  { x: 556, w: 250, title: 'Adresy kryptowalut' },
  { x: 948, w: 224, title: 'Dokąd trafiły środki' },
];
const TOP = 58;
const GAP = 10;
const STATUS_RANK: Record<string, number> = { attributed: 0, not_attributable: 1, excluded: 2 };

export function layoutGraph(g: Graph): Layout {
  const boxes = new Map<string, Box>();
  const col = (c: number) => g.nodes.filter((n) => n.col === c);
  const clusterIndex = (n: GNode) => (n.clusterId ? g.clusters.findIndex((c) => c.id === n.clusterId) : n.thirdParty ? 1000 : 500);

  let y = TOP;
  for (const n of col(0).sort((a, b) => a.firstSeq - b.firstSeq)) {
    boxes.set(n.id, { x: COLUMNS[0].x, y, w: COLUMNS[0].w, h: 48 });
    y += 48 + GAP;
  }
  let height = y;

  // Accounts: one person's accounts together, other people's below.
  const accounts = col(1).sort((a, b) => clusterIndex(a) - clusterIndex(b) || a.firstSeq - b.firstSeq);
  const groups: Layout['groups'] = [];
  let othersY: number | undefined;
  y = TOP;
  let previous: number | undefined;
  for (const n of accounts) {
    const ci = clusterIndex(n);
    if (previous !== undefined && ci !== previous) y += n.thirdParty ? 40 : 34;
    if (n.thirdParty && othersY === undefined && g.clusters.length) othersY = y - 10;
    const h = n.thirdParty ? 30 : 48;
    boxes.set(n.id, { x: COLUMNS[1].x, y, w: COLUMNS[1].w, h });
    const c = n.clusterId ? g.clusters.find((x) => x.id === n.clusterId) : undefined;
    if (c) {
      const grp = groups.find((x) => x.id === c.id);
      if (grp) grp.box.h = y + h + 8 - grp.box.y;
      else groups.push({ id: c.id, level: c.level, identityCap: c.identityCap, box: { x: COLUMNS[1].x - 8, y: y - 8, w: COLUMNS[1].w + 16, h: h + 16 } });
    }
    y += h + (n.thirdParty ? 4 : GAP);
    previous = ci;
  }
  height = Math.max(height, y);

  // Addresses: by order of discovery until scored, then strongest first and rejected last.
  const addresses = col(2).sort((a, b) =>
    g.ranked
      ? (STATUS_RANK[a.link?.status ?? ''] ?? 3) - (STATUS_RANK[b.link?.status ?? ''] ?? 3) || (b.link?.score ?? 0) - (a.link?.score ?? 0) || a.firstSeq - b.firstSeq
      : a.firstSeq - b.firstSeq,
  );
  y = TOP;
  addresses.forEach((n, i) => {
    if (g.ranked && i > 0 && n.link?.status !== 'attributed' && addresses[i - 1].link?.status === 'attributed') y += 12;
    boxes.set(n.id, { x: COLUMNS[2].x, y, w: COLUMNS[2].w, h: 52 });
    y += 52 + 7;
  });
  height = Math.max(height, y);

  // Services: next to the address that paid them.
  const sourceY = (n: GNode) => Math.min(...g.edges.filter((e) => e.to === n.id).map((e) => boxes.get(e.from)?.y ?? 0));
  y = TOP;
  for (const n of col(3).filter((x) => x.type === 'service').sort((a, b) => sourceY(a) - sourceY(b) || a.firstSeq - b.firstSeq)) {
    boxes.set(n.id, { x: COLUMNS[3].x, y, w: COLUMNS[3].w, h: 48 });
    y += 48 + 8;
  }
  // The estimate closes the column like the total under a column of figures.
  const estimate = g.nodes.find((n) => n.type === 'estimate');
  if (estimate) {
    y += 14;
    const h = 44 + (estimate.years?.length ?? 0) * 24 + 30;
    boxes.set(estimate.id, { x: COLUMNS[3].x, y, w: COLUMNS[3].w, h });
    y += h + GAP;
  }
  height = Math.max(height, y);

  return { width: 1180, height: height + 12, boxes, groups, othersY, columns: COLUMNS };
}

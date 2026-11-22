import { makeIdentifier, parseAddress, type Attestation, type ConnectorContext, type Identifier, type Segment, type SourceConnector, type SourceItem } from '@olcys/core';

/**
 * Lens: a social network whose accounts are objects on a public chain. Every account has an owner address,
 * recorded on that chain — so a Lens name leads straight to an address, without anyone having to publish it.
 */
export const LENS_API = 'https://api.lens.xyz/graphql';

type Json = Record<string, any>;

export interface LensAccount {
  /** Name within the Lens namespace, e.g. "stani" for "lens/stani". */
  localName: string;
  /** The account object on Lens Chain (a contract, not a wallet). */
  account: string;
  /** The address that owns the account, as the chain records it. */
  owner: string;
  createdAt?: string;
  name?: string;
  bio?: string;
  location?: string;
  website?: string;
  /** Handle on X, if the person filled it in. */
  x?: string;
}

const clean = (s: unknown) => (typeof s === 'string' && s.trim()) || undefined;

/** Reads one account from the API's answer (`account`, or one item of `accounts`). */
export function parseLensAccount(json: Json | null | undefined): LensAccount | undefined {
  const [account, owner] = [parseAddress(String(json?.address ?? ''))?.address, parseAddress(String(json?.owner ?? ''))?.address];
  const localName = clean(json?.username?.localName)?.toLowerCase();
  if (!account || !owner || !localName) return undefined;
  const attrs = new Map<string, string>();
  for (const a of (json?.metadata?.attributes ?? []) as Json[]) if (typeof a.key === 'string' && typeof a.value === 'string' && a.value.trim()) attrs.set(a.key.toLowerCase(), a.value.trim());
  const at = Date.parse(String(json?.createdAt ?? ''));
  return {
    localName, account, owner, createdAt: Number.isNaN(at) ? undefined : new Date(at).toISOString(),
    name: clean(json?.metadata?.name), bio: clean(json?.metadata?.bio), location: attrs.get('location'), website: attrs.get('website'),
    x: (attrs.get('x') ?? attrs.get('twitter'))?.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, '') || undefined,
  };
}

const FIELDS = 'address owner createdAt username { value localName } metadata { name bio attributes { key value } }';
const BY_NAME = `query ($name: String!) { account(request: { username: { localName: $name } }) { ${FIELDS} } }`;
const SEARCH = `query ($name: String!) { accounts(request: { filter: { searchBy: { localNameQuery: $name } }, pageSize: TEN }) { items { ${FIELDS} } } }`;

/** A Lens account as a document, with the owner address as a statement the network vouches for. */
export function lensAccountItem(a: LensAccount, snapshotId: string): SourceItem {
  const url = `https://hey.xyz/u/${a.localName}`;
  const segments: Segment[] = [];
  if (a.bio) segments.push({ kind: 'bio', text: a.bio });
  segments.push({ kind: 'contact', text: `Adres właściciela konta (zapisany w łańcuchu Lens): ${a.owner}` });
  if (a.website) segments.push({ kind: 'link', text: a.website });
  const discovered: Identifier[] = [];
  if (a.website && /^https?:\/\//i.test(a.website)) discovered.push(makeIdentifier('profile_url', a.website));
  if (a.x && /^[a-z0-9_]{1,15}$/i.test(a.x)) discovered.push(makeIdentifier('profile_url', `https://x.com/${a.x}`));
  // Nobody signed anything for us to check: the chain itself records who owns the account, and the Lens API
  // reports that record. The link is therefore vouched for by the service, not verified here.
  const attestations: Attestation[] = [{
    chain: 'ethereum', address: a.owner,
    message: `Konto lens/${a.localName} w sieci Lens należy do adresu ${a.owner}: właściciel konta jest zapisany w łańcuchu Lens`,
    signature: `zapis własności w kontrakcie konta ${a.account} (Lens Chain); bez podpisu do samodzielnego sprawdzenia`,
    valid: true, attestedBy: 'sieć Lens',
  }];
  return {
    snapshotId, url, resourceId: `account:${a.account}`, docType: 'profile', title: `lens/${a.localName}`,
    author: { handle: a.localName, displayName: a.name, profileUrl: url },
    publishedAt: a.createdAt, container: { kind: 'profile', section: a.location }, relation: 'profile_owner', segments, discovered, attestations,
  };
}

/**
 * Lens, live, for one name: the profile and the address that owns the account. The owner address is the key
 * that controls the account; whether it is also the wallet the person keeps funds in is for the flow analysis to show.
 */
export function createLensConnector(opts: { api?: string } = {}): SourceConnector {
  const api = opts.api ?? LENS_API;
  const ask = async (ctx: ConnectorContext, query: string, name: string): Promise<{ data?: Json; snapshotId: string }> => {
    const res = await ctx.fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { name } }) });
    return { data: res.status === 200 ? (JSON.parse(res.body) as { data?: Json }).data : undefined, snapshotId: res.snapshotId };
  };
  const nameOf = (id: Identifier): string | undefined => {
    if (id.kind === 'username') return id.normalized.replace(/^lens\//, '').replace(/\.lens$/, '');
    if (id.kind !== 'profile_url') return undefined;
    try {
      const u = new URL(id.value);
      const [first, second] = u.pathname.split('/').filter(Boolean);
      return /^(www\.)?hey\.xyz$/i.test(u.hostname) && first === 'u' && second ? second.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  };
  const valid = (name: string | undefined): name is string => !!name && /^[a-z0-9][a-z0-9_-]{2,30}$/.test(name);

  return {
    id: 'lens',
    descriptor: { name: 'Lens', kind: 'social', origin: 'lens', hosts: [new URL(api).host], synthetic: false },
    supports: (id) => valid(nameOf(id)),
    async *search(id, ctx): AsyncGenerator<SourceItem> {
      const name = nameOf(id);
      if (!valid(name)) return;
      const { data, snapshotId } = await ask(ctx, BY_NAME, name);
      const account = parseLensAccount(data?.account);
      if (account) yield lensAccountItem(account, snapshotId);
    },
    /** Lens names that contain the given nick (the network's own name search), other than the nick itself. */
    async enumerate(id, ctx) {
      if (id.kind !== 'username' || !/^[a-z0-9][a-z0-9_-]{4,30}$/.test(id.normalized)) return [];
      const { data } = await ask(ctx, SEARCH, id.normalized);
      return ((data?.accounts?.items ?? []) as Json[])
        .map((x) => parseLensAccount(x)?.localName)
        .filter((n): n is string => !!n && n !== id.normalized && n.includes(id.normalized));
    },
  };
}

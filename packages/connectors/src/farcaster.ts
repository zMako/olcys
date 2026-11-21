import { makeIdentifier, verifyFarcasterClaim, type Attestation, type Identifier, type Relation, type Segment, type SourceConnector, type SourceItem } from '@olcys/core';
import { FARCASTER_API, FARCASTER_NODE, parseFarcasterCasts, parseFarcasterClaims, parseFarcasterUser, type FarcasterProfile } from './farcaster-data';

export interface FarcasterOptions {
  api?: string;
  node?: string;
  /** How many of the account's most recent posts are read. */
  maxCasts?: number;
}

const PLATFORM_URL: Record<string, (u: string) => string> = { x: (u) => `https://x.com/${u}`, twitter: (u) => `https://x.com/${u}`, github: (u) => `https://github.com/${u}` };

/** A Farcaster profile as a document: description, attached wallets, website and connected accounts as leads. */
export function farcasterProfileItem(p: FarcasterProfile, snapshotId: string, relation: Relation, moreWallets: string[] = []): SourceItem {
  const profileUrl = `https://farcaster.xyz/${p.username ?? `~/profiles/${p.fid}`}`;
  const wallets = [...new Set([...p.wallets, ...moreWallets])];
  const segments: Segment[] = [];
  if (p.bio) segments.push({ kind: 'bio', text: p.bio });
  if (wallets.length) segments.push({ kind: 'contact', text: `Portfele dołączone do konta: ${wallets.join(', ')}` });
  if (p.url) segments.push({ kind: 'link', text: p.url });
  const discovered: Identifier[] = [];
  if (p.url && /^https?:\/\//i.test(p.url)) discovered.push(makeIdentifier('profile_url', p.url));
  for (const c of p.connected) {
    const url = PLATFORM_URL[c.platform.toLowerCase()]?.(c.username);
    if (url) discovered.push(makeIdentifier('profile_url', url));
  }
  return {
    snapshotId, url: profileUrl, resourceId: `fid:${p.fid}`, docType: 'profile', title: p.username ?? String(p.fid),
    author: { handle: p.username ?? String(p.fid), displayName: p.displayName, profileUrl },
    container: { kind: 'profile', section: p.location }, relation, segments, discovered,
  };
}

/**
 * Farcaster, live. For an account name it returns the profile, the wallets the account attached to itself,
 * and its recent posts. Every wallet comes with the claim its own key signed; the claim is checked here,
 * mathematically, so the link between account and address does not rest on anyone's word.
 */
export function createFarcasterConnector(opts: FarcasterOptions = {}): SourceConnector {
  const api = (opts.api ?? FARCASTER_API).replace(/\/+$/, '');
  const node = (opts.node ?? FARCASTER_NODE).replace(/\/+$/, '');
  const nameOf = (id: Identifier): string | undefined => {
    if (id.kind === 'username') return id.normalized;
    if (id.kind !== 'profile_url') return undefined;
    try {
      const u = new URL(id.value);
      const first = u.pathname.split('/').filter(Boolean)[0];
      return /^(www\.)?(farcaster\.xyz|warpcast\.com)$/i.test(u.hostname) && first && !first.startsWith('~') ? first.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    id: 'farcaster',
    descriptor: { name: 'Farcaster', kind: 'social', origin: 'farcaster', hosts: [new URL(api).host, new URL(node).host], synthetic: false },
    supports: (id) => !!nameOf(id),
    async *search(id, ctx): AsyncGenerator<SourceItem> {
      const name = nameOf(id);
      if (!name || !/^[a-z0-9][a-z0-9-]{0,15}(\.eth)?$/.test(name)) return;
      const res = await ctx.fetch(`${api}/v2/user-by-username?username=${encodeURIComponent(name)}`);
      if (res.status !== 200) return;
      const p = parseFarcasterUser(JSON.parse(res.body));
      if (!p?.username) return;
      // The wallet claims, with their signatures, come from the protocol node.
      const claimsRes = await ctx.fetch(`${node}/v1/verificationsByFid?fid=${p.fid}`);
      const claims = claimsRes.status === 200 ? parseFarcasterClaims(JSON.parse(claimsRes.body)) : [];
      const attestations: Attestation[] = claims.map((c) => {
        const message = `Oświadczenie w sieci Farcaster: adres ${c.address} należy do konta ${p.username} (nr ${p.fid}); złożone ${c.at.slice(0, 10)}`;
        // A contract wallet has no key of its own to sign with; its claim is checked on chain by the network, not here.
        if (c.type !== 0) return { chain: 'ethereum', address: c.address, message, signature: c.signature, valid: true, attestedBy: 'sieć Farcaster' };
        const check = verifyFarcasterClaim({ fid: p.fid, address: c.address, blockHash: c.blockHash, signature: c.signature });
        return { chain: 'ethereum', address: c.address, message, signature: c.signature, valid: check.valid, reason: check.reason };
      });
      const profile = farcasterProfileItem(p, res.snapshotId, 'profile_owner', claims.map((c) => c.address));
      profile.attestations = attestations;
      const author = profile.author!;
      const profileUrl = profile.url;
      yield profile;

      // Recent posts: where a person says what they bought, sold and when — and the hours they are awake.
      const castsRes = await ctx.fetch(`${node}/v1/castsByFid?fid=${p.fid}&pageSize=${opts.maxCasts ?? 60}&reverse=true`);
      if (castsRes.status !== 200) return;
      for (const c of parseFarcasterCasts(JSON.parse(castsRes.body))) {
        yield {
          snapshotId: castsRes.snapshotId, url: `${profileUrl}/${c.hash.slice(0, 10)}`, resourceId: `cast:${c.hash}`, docType: 'post', title: c.text.replace(/\s+/g, ' ').slice(0, 70),
          author, publishedAt: c.at, container: { kind: 'feed', title: c.channel }, relation: 'author', segments: [{ kind: 'body', text: c.text }], discovered: [],
        };
      }
    },
  };
}

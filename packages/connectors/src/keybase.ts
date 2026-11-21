import { makeIdentifier, parseAddress, type Attestation, type ConnectorContext, type Identifier, type Segment, type SourceConnector, type SourceItem } from '@olcys/core';

interface KbUser {
  basics: { username: string };
  profile?: { full_name?: string | null; location?: string | null; bio?: string | null } | null;
  proofs_summary?: { all?: { proof_type: string; nametag: string; state: number; service_url: string; proof_url: string }[] };
  cryptocurrency_addresses?: Record<string, { address: string; sig_id: string }[]>;
}

/**
 * Keybase: a public directory where a person proves, with their own key, which accounts on other services
 * are theirs — and can sign their crypto addresses the same way. One lookup therefore ties a nick on one
 * service to accounts on others and to addresses. Keybase checks the signatures; this tool relays its verdict
 * and says so in the score.
 */
export function createKeybaseConnector(opts: { api?: string } = {}): SourceConnector {
  const api = (opts.api ?? 'https://keybase.io/_/api/1.0').replace(/\/+$/, '');
  const fields = 'basics,profile,proofs_summary,cryptocurrency_addresses';
  const lookup = async (ctx: ConnectorContext, query: string): Promise<{ users: KbUser[]; snapshotId: string }> => {
    const res = await ctx.fetch(`${api}/user/lookup.json?${query}&fields=${fields}`);
    if (res.status !== 200) return { users: [], snapshotId: res.snapshotId };
    const body = JSON.parse(res.body) as { them?: (KbUser | null)[] };
    return { users: (body.them ?? []).filter((u): u is KbUser => !!u?.basics?.username), snapshotId: res.snapshotId };
  };
  const nameOf = (id: Identifier): string | undefined => {
    if (id.kind !== 'profile_url') return undefined;
    try {
      const u = new URL(id.value);
      return /^(www\.)?keybase\.io$/i.test(u.hostname) ? u.pathname.split('/').filter(Boolean)[0]?.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  };
  const item = (u: KbUser, snapshotId: string): SourceItem => {
    const username = u.basics.username;
    const url = `https://keybase.io/${username}`;
    const addresses = (u.cryptocurrency_addresses?.bitcoin ?? []).map((a) => parseAddress(a.address)?.address).filter((a): a is string => !!a);
    const segments: Segment[] = [];
    if (u.profile?.bio) segments.push({ kind: 'bio', text: u.profile.bio });
    if (addresses.length) segments.push({ kind: 'contact', text: `Adresy podpisane kluczem konta: ${addresses.join(', ')}` });
    const discovered: Identifier[] = [];
    for (const p of u.proofs_summary?.all ?? []) if (p.state === 1 && /^https?:\/\//i.test(p.service_url)) discovered.push(makeIdentifier('profile_url', p.service_url));
    if (u.profile?.full_name) discovered.push(makeIdentifier('full_name', u.profile.full_name));
    const attestations: Attestation[] = (u.cryptocurrency_addresses?.bitcoin ?? []).flatMap((a) => {
      const address = parseAddress(a.address)?.address;
      return address ? [{ chain: 'bitcoin', address, message: `Konto ${username} w serwisie Keybase podpisało swoim kluczem oświadczenie, że adres ${address} jest jego`, signature: a.sig_id, valid: true, attestedBy: 'Keybase' }] : [];
    });
    return {
      snapshotId, url, resourceId: `user:${username}`, docType: 'profile', title: username,
      author: { handle: username, displayName: u.profile?.full_name ?? undefined, profileUrl: url },
      container: { kind: 'profile', section: u.profile?.location ?? undefined }, relation: 'profile_owner', segments, discovered, attestations,
    };
  };

  return {
    id: 'keybase',
    descriptor: { name: 'Keybase', kind: 'social', origin: 'keybase', hosts: [new URL(api).host], synthetic: false },
    supports: (id) => id.kind === 'username' || !!nameOf(id),
    async *search(id, ctx): AsyncGenerator<SourceItem> {
      const nick = id.kind === 'username' ? id.normalized : nameOf(id);
      if (!nick || !/^[a-z0-9_-]{2,40}$/i.test(nick)) return;
      const seen = new Set<string>();
      // The nick on Keybase itself, and Keybase accounts that proved this nick on another service.
      const queries = id.kind === 'username' ? [`usernames=${nick}`, `github=${nick}`, `twitter=${nick}`] : [`usernames=${nick}`];
      for (const q of queries) {
        const { users, snapshotId } = await lookup(ctx, q);
        for (const u of users) {
          if (seen.has(u.basics.username)) continue;
          seen.add(u.basics.username);
          yield item(u, snapshotId);
        }
      }
    },
  };
}

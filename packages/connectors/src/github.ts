import { makeIdentifier, normalizeIdentifier, sshKeyFingerprint, type ConnectorContext, type FetchedResource, type Fingerprint, type Identifier, type Relation, type Segment, type SourceConnector, type SourceItem } from '@olcys/core';

export interface GithubOptions {
  /** Personal access token. Without one the public API allows 60 requests an hour per IP address and no code search. */
  token?: string;
  api?: string;
  /** How many of the account's own repositories are read. */
  maxRepos?: number;
}

interface GhUser {
  login: string; type: string; name: string | null; bio: string | null; blog: string | null; email: string | null; location: string | null;
  twitter_username: string | null; html_url: string; created_at: string;
}
interface GhRepo {
  full_name: string; html_url: string; description: string | null; fork: boolean; stargazers_count: number; pushed_at: string;
}

/**
 * GitHub through its public REST API: the account's profile, profile README, and the README and
 * funding file of its own repositories — the places where developers publish donation addresses.
 */
export function createGithubConnector(opts: GithubOptions = {}): SourceConnector {
  const api = (opts.api ?? 'https://api.github.com').replace(/\/+$/, '');
  const headers = (accept: string) => ({ accept, 'x-github-api-version': '2022-11-28', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) });
  const get = async (ctx: ConnectorContext, path: string, accept = 'application/vnd.github+json'): Promise<FetchedResource | undefined> => {
    const res = await ctx.fetch(api + path, { headers: headers(accept) });
    if (res.status === 403 || res.status === 429) ctx.log('GitHub odmówił odpowiedzi: wyczerpany limit zapytań. Ustaw GITHUB_TOKEN.');
    return res.status === 200 ? res : undefined;
  };
  const raw = (ctx: ConnectorContext, path: string) => get(ctx, path, 'application/vnd.github.raw+json');
  const loginOf = (id: Identifier): string | undefined => {
    if (id.kind !== 'profile_url') return undefined;
    try {
      const u = new URL(id.value);
      const first = u.pathname.split('/').filter(Boolean)[0];
      return /^(www\.)?github\.com$/i.test(u.hostname) && first ? first : undefined;
    } catch {
      return undefined;
    }
  };

  async function* profile(ctx: ConnectorContext, login: string, relation: Relation, accept?: (u: GhUser) => boolean): AsyncGenerator<SourceItem> {
    const res = await get(ctx, `/users/${encodeURIComponent(login)}`);
    if (!res) return;
    const u = JSON.parse(res.body) as GhUser;
    if (accept && !accept(u)) return;
    const readme = await raw(ctx, `/repos/${u.login}/${u.login}/readme`);
    const segments: Segment[] = [];
    if (u.bio) segments.push({ kind: 'bio', text: u.bio });
    const contact = [u.email, u.blog, u.twitter_username && `@${u.twitter_username}`].filter(Boolean).join('\n');
    if (contact) segments.push({ kind: 'contact', text: contact });
    if (readme) segments.push({ kind: 'readme', text: readme.body });
    const discovered: Identifier[] = [];
    if (u.email) discovered.push(makeIdentifier('email', u.email));
    if (u.name) discovered.push(makeIdentifier('full_name', u.name));
    if (u.blog && /^https?:\/\//i.test(u.blog)) discovered.push(makeIdentifier('profile_url', u.blog));
    if (u.twitter_username) discovered.push(makeIdentifier('username', u.twitter_username));
    // Public SSH keys of the account: the same key on another account means the same owner.
    const fingerprints: Fingerprint[] = [];
    if (relation !== 'mention') {
      const keys = await get(ctx, `/users/${u.login}/keys`);
      const list: unknown = keys ? JSON.parse(keys.body) : [];
      for (const k of Array.isArray(list) ? (list as { key?: string }[]) : []) {
        const value = k.key ? sshKeyFingerprint(k.key) : undefined;
        if (value) fingerprints.push({ kind: 'ssh_key', value, sourceUrl: `${u.html_url}.keys` });
      }
    }
    yield {
      snapshotId: res.snapshotId, url: u.html_url, resourceId: `user:${u.login}`, docType: 'profile', title: u.login,
      author: { handle: u.login, displayName: u.name ?? undefined, profileUrl: u.html_url }, publishedAt: u.created_at,
      container: { kind: 'profile', section: u.location ?? undefined }, relation, segments, discovered, fingerprints,
    };
    if (relation === 'mention') return;

    const list = await get(ctx, `/users/${u.login}/repos?per_page=100&type=owner&sort=pushed`);
    if (!list) return;
    const repos = (JSON.parse(list.body) as GhRepo[]).filter((r) => !r.fork).sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, opts.maxRepos ?? 6);
    for (const r of repos) {
      const [text, funding] = [await raw(ctx, `/repos/${r.full_name}/readme`), await raw(ctx, `/repos/${r.full_name}/contents/.github/FUNDING.yml`)];
      if (!text && !funding) continue;
      yield {
        snapshotId: (text ?? funding)!.snapshotId, url: r.html_url, resourceId: `repo:${r.full_name}`, docType: 'repo', title: r.full_name,
        author: { handle: u.login, profileUrl: u.html_url }, publishedAt: r.pushed_at,
        container: { kind: 'repository', id: r.full_name, title: r.description ?? undefined }, relation: 'author',
        segments: [...(text ? [{ kind: 'readme' as const, text: text.body }] : []), ...(funding ? [{ kind: 'readme' as const, text: funding.body }] : [])],
        discovered: [],
      };
    }
  }

  return {
    id: 'github',
    descriptor: { name: 'GitHub', kind: 'code_hosting', origin: 'github', hosts: [new URL(api).host], synthetic: false },
    supports: (id) => ['username', 'full_name', 'email'].includes(id.kind) || (id.kind === 'crypto_address' && !!opts.token) || !!loginOf(id),
    async *search(id, ctx) {
      const login = id.kind === 'username' ? id.normalized : loginOf(id);
      if (login) {
        if (/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login)) yield* profile(ctx, login, 'profile_owner');
        return;
      }
      if (id.kind === 'full_name' || id.kind === 'email') {
        const field = id.kind === 'email' ? 'email' : 'name';
        const found = await get(ctx, `/search/users?q=${encodeURIComponent(`${id.value} in:${field}`)}&per_page=5`);
        if (!found) return;
        for (const item of (JSON.parse(found.body) as { items: { login: string }[] }).items) {
          yield* profile(ctx, item.login, 'profile_owner', (u) =>
            id.kind === 'email' ? u.email?.toLowerCase() === id.normalized : !!u.name && normalizeIdentifier('full_name', u.name) === id.normalized,
          );
        }
        return;
      }
      // Who else has this exact address in their code or documentation? (needs a token)
      const found = await get(ctx, `/search/code?q=${encodeURIComponent(`"${id.value}"`)}&per_page=5`);
      if (!found) return;
      for (const hit of (JSON.parse(found.body) as { items: { path: string; html_url: string; repository: { full_name: string; owner: { login: string; html_url: string } } }[] }).items) {
        const file = await raw(ctx, `/repos/${hit.repository.full_name}/contents/${hit.path.split('/').map(encodeURIComponent).join('/')}`);
        if (!file) continue;
        yield {
          snapshotId: file.snapshotId, url: hit.html_url, resourceId: `code:${hit.repository.full_name}:${hit.path}`, docType: 'repo',
          title: `${hit.repository.full_name}/${hit.path}`, author: { handle: hit.repository.owner.login, profileUrl: hit.repository.owner.html_url },
          container: { kind: 'repository', id: hit.repository.full_name }, relation: 'mention', segments: [{ kind: 'readme', text: file.body }], discovered: [],
        };
      }
    },
    /** Logins that contain the given nick (GitHub's own user search), other than the nick itself. */
    async enumerate(id, ctx) {
      if (id.kind !== 'username' || !/^[a-z\d][a-z\d-]{4,38}$/i.test(id.normalized)) return [];
      const found = await get(ctx, `/search/users?q=${encodeURIComponent(`${id.normalized} in:login type:user`)}&per_page=10`);
      if (!found) return [];
      return (JSON.parse(found.body) as { items?: { login: string }[] }).items?.map((x) => x.login).filter((l) => l.toLowerCase() !== id.normalized) ?? [];
    },
  };
}

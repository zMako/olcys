import { sha256Hex, type FetchInit, type FetchedResource } from '@olcys/core';
import type { Store } from '@olcys/db';

export class EgressDeniedError extends Error {
  constructor(readonly url: string, readonly host: string) {
    super(`Egress denied: ${host} is not on the allowlist (${url})`);
  }
}

export interface EgressOptions {
  store: Store;
  runId: string;
  /** host or host:port entries the engine may contact. Everything else is refused and logged. */
  allowlist: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** A fetched binary resource (an image), stored in the evidence vault like any page. */
export interface FetchedBytes {
  snapshotId: string;
  url: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
}

const USER_AGENT = 'OLCyS/0.1 (OSINT research tool)';

/**
 * The single network exit of the engine.
 *  - refuses hosts that are not explicitly approved,
 *  - follows redirects only to approved hosts,
 *  - stores every response in the evidence vault before anyone parses it,
 *  - logs every attempt.
 */
export function createEgress(opts: EgressOptions) {
  const allowed = new Set(opts.allowlist.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const doFetch = opts.fetchImpl ?? fetch;
  const textCache = new Map<string, FetchedResource>();
  const byteCache = new Map<string, FetchedBytes>();

  const check = async (connectorId: string, url: string): Promise<URL> => {
    const u = new URL(url);
    const ok = /^https?:$/.test(u.protocol) && (allowed.has(u.host.toLowerCase()) || allowed.has(u.hostname.toLowerCase()));
    if (!ok) {
      await opts.store.logEgress({ runId: opts.runId, connectorId, url, host: u.host, allowed: false, note: 'host not on allowlist' });
      throw new EgressDeniedError(url, u.host);
    }
    return u;
  };

  const request = async (connectorId: string, url: string, accept: string, init: FetchInit = {}): Promise<{ response: Response; url: string }> => {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      await check(connectorId, current);
      const response = await doFetch(current, {
        method: init.method ?? 'GET',
        body: init.body,
        redirect: 'manual',
        // Extra headers (such as an access token) are sent, but never written to the evidence vault.
        headers: { 'user-agent': USER_AGENT, accept, ...init.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await opts.store.logEgress({ runId: opts.runId, connectorId, url: current, host: new URL(current).host, allowed: true, status: response.status, note: `redirect to ${location}` });
        current = new URL(location, current).toString();
        continue;
      }
      return { response, url: current };
    }
    throw new Error(`Too many redirects: ${url}`);
  };

  const store = async (connectorId: string, url: string, response: Response, body: string | Uint8Array, requestBody?: string) => {
    const fetchedAt = new Date().toISOString();
    const snap = await opts.store.saveSnapshot({
      runId: opts.runId, connectorId, url, status: response.status,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream', body, fetchedAt, requestBody,
    });
    await opts.store.logEgress({ runId: opts.runId, connectorId, url, host: new URL(url).host, allowed: true, status: response.status });
    return { snap, fetchedAt };
  };

  return {
    /** Fetches a page or an API answer as text. */
    async text(connectorId: string, url: string, init?: FetchInit): Promise<FetchedResource> {
      const key = init?.body ? `${url}#${sha256Hex(init.body)}` : url;
      const cached = textCache.get(key);
      if (cached) return cached;
      const { response, url: final } = await request(connectorId, url, '*/*', init);
      const body = (await response.text()).slice(0, opts.maxBytes ?? 5_000_000);
      const { snap, fetchedAt } = await store(connectorId, final, response, body, init?.body);
      const resource: FetchedResource = { snapshotId: snap.id, url: final, status: response.status, contentType: snap.content_type, body, sha256: snap.sha256, fetchedAt };
      textCache.set(key, resource);
      return resource;
    },
    /** Fetches a binary resource such as a photo. */
    async bytes(connectorId: string, url: string): Promise<FetchedBytes> {
      const cached = byteCache.get(url);
      if (cached) return cached;
      const { response, url: final } = await request(connectorId, url, 'image/*,*/*;q=0.5');
      const bytes = new Uint8Array(await response.arrayBuffer()).slice(0, opts.maxBytes ?? 5_000_000);
      const { snap } = await store(connectorId, final, response, bytes);
      const resource: FetchedBytes = { snapshotId: snap.id, url: final, status: response.status, contentType: snap.content_type, bytes, sha256: snap.sha256 };
      byteCache.set(url, resource);
      return resource;
    },
  };
}

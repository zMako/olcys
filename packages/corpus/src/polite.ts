/** Raised when a service refuses us outright. The run stops instead of asking again. */
export class BlockedError extends Error {}
/** Raised when one request keeps failing although the service is otherwise answering. The caller skips that item. */
export class GaveUpError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const USER_AGENT = 'OLCyS/0.1 (OSINT research tool)';

/**
 * A client that behaves: a fixed number of requests per second to one service, however many callers wait;
 * patient retries when the service says "slow down"; and a full stop when it says "no".
 */
export class PoliteClient {
  private next = 0;
  requests = 0;

  constructor(private readonly perSecond: number, private readonly attempts = 5) {}

  private async turn(): Promise<void> {
    const gap = 1000 / this.perSecond;
    const at = Math.max(Date.now(), this.next);
    this.next = at + gap;
    if (at > Date.now()) await sleep(at - Date.now());
  }

  /** GET returning parsed JSON, or undefined for "not found". */
  async json<T>(url: string): Promise<T | undefined> {
    let wait = 4000;
    for (let i = 0; i < this.attempts; i++) {
      await this.turn();
      this.requests++;
      let res: Response;
      try {
        res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      } catch {
        await sleep(wait);
        wait *= 2;
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      if (res.status === 404 || res.status === 400) return undefined;
      if (res.status === 401 || res.status === 403) throw new BlockedError(`${res.status} for ${url}`);
      // 429 or a server error: wait as long as asked, then longer each time
      const asked = Number(res.headers.get('retry-after'));
      // An hourly quota does not clear in seconds: when told "too many", wait at least a minute.
      await sleep(Number.isFinite(asked) && asked > 0 ? asked * 1000 : res.status === 429 ? Math.max(wait, 60_000) : wait);
      wait *= 2;
    }
    throw new GaveUpError(`gave up on ${url}`);
  }
}

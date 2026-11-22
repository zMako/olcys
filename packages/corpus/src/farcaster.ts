import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { FARCASTER_API, FARCASTER_NODE, parseFarcasterCasts, parseFarcasterUser, type FarcasterCast, type FarcasterProfile } from '@olcys/connectors';
import { isPolishText, mentionsPoland, polishSignals, type PolishSignals } from './polish';
import { BlockedError, GaveUpError, PoliteClient } from './polite';

/** A Farcaster account as kept in the corpus: its profile, its wallets, and why it counts as Polish. */
export interface FarcasterRecord extends FarcasterProfile {
  polish: PolishSignals;
  /** How the account was reached: a Polish channel, or the follow list of a Polish account. */
  via: string;
  /** Wallets of the account that carry Coinbase's public "verified in Poland" attestation. */
  attested?: string[];
  fetchedAt: string;
}

export interface FarcasterIngestOptions {
  /** Upper limit of requests in this run. The run can be continued later; nothing is fetched twice. */
  maxRequests?: number;
  /** Requests per second to each of the two services. */
  perSecond?: number;
  /** Follow lists are limited by the service to 500 requests an hour; this keeps the run under that. */
  followPerHour?: number;
  /** How many pages (50 accounts each) of an account's follow list are read. */
  maxFollowPages?: number;
  log?(message: string): void;
}

export interface FarcasterIngestResult {
  channels: string[];
  evaluated: number;
  polish: number;
  withWallet: number;
  wallets: number;
  castsOf: number;
  casts: number;
  requests: number;
  stopped?: string;
}

const readSet = (file: string) => new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

export function readFarcasterRecords(dir: string): FarcasterRecord[] {
  const file = `${dir}/profiles.jsonl`;
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as FarcasterRecord) : [];
}

const POLISH_FROM = 0.5;

/**
 * Builds the Polish part of Farcaster without reading all 3.4 million accounts:
 *   1. the public list of channels is searched for Polish ones (language, country, cities);
 *   2. everyone who follows those channels is looked at — location, description, website decide who is Polish;
 *   3. the follow lists of the Polish accounts are read, and the Polish accounts among them join; this repeats;
 *   4. the recent posts of every Polish account are stored, for reading.
 * Every step is resumable and bounded by a request budget, at a few requests per second.
 */
export async function ingestFarcaster(dir: string, opts: FarcasterIngestOptions = {}): Promise<FarcasterIngestResult> {
  mkdirSync(dir, { recursive: true });
  const log = opts.log ?? (() => {});
  const api = new PoliteClient(opts.perSecond ?? 4);
  const node = new PoliteClient(opts.perSecond ?? 4);
  const follows = new PoliteClient((opts.followPerHour ?? 440) / 3600, 4);
  const budget = opts.maxRequests ?? 20_000;
  const spent = () => api.requests + node.requests + follows.requests;

  const records = new Map(readFarcasterRecords(dir).map((r) => [r.fid, r]));
  const seen = readSet(`${dir}/seen.txt`); // every fid ever looked at, Polish or not
  const expanded = readSet(`${dir}/expanded.txt`); // fids whose follow list was read
  const casted = readSet(`${dir}/casted.txt`);
  for (const fid of records.keys()) seen.add(String(fid));
  const markSeen = (fid: number) => {
    if (seen.has(String(fid))) return false;
    seen.add(String(fid));
    appendFileSync(`${dir}/seen.txt`, `${fid}\n`);
    return true;
  };
  const isPolish = (r: FarcasterRecord) => r.polish.score >= POLISH_FROM;

  /** Fetches one account in full (profile and wallets) and files it. */
  const evaluate = async (fid: number, via: string): Promise<FarcasterRecord | undefined> => {
    if (records.has(fid)) return records.get(fid);
    const profile = parseFarcasterUser(await api.json(`${FARCASTER_API}/v2/user-by-fid?fid=${fid}`));
    if (!profile) return undefined;
    const record: FarcasterRecord = { ...profile, polish: polishSignals({ location: profile.location, bio: profile.bio, name: profile.displayName, url: profile.url }), via, fetchedAt: new Date().toISOString() };
    records.set(fid, record);
    appendFileSync(`${dir}/profiles.jsonl`, JSON.stringify(record) + '\n');
    return record;
  };

  /** Recent posts of every Polish account that has none stored yet. */
  const readPosts = async () => {
    for (const r of [...records.values()].filter(isPolish)) {
      if (spent() >= budget || casted.has(String(r.fid))) continue;
      const casts: FarcasterCast[] = parseFarcasterCasts(await node.json(`${FARCASTER_NODE}/v1/castsByFid?fid=${r.fid}&pageSize=100&reverse=true`));
      if (casts.length) appendFileSync(`${dir}/casts.jsonl`, casts.map((c) => JSON.stringify({ fid: r.fid, ...c })).join('\n') + '\n');
      casted.add(String(r.fid));
      appendFileSync(`${dir}/casted.txt`, `${r.fid}\n`);
    }
  };

  let stopped: string | undefined;
  let quotaSpent = false;
  let channels: string[] = [];
  try {
    // 1. Polish channels
    const cache = `${dir}/all-channels.json`;
    if (!existsSync(cache)) writeFileSync(cache, JSON.stringify(await api.json(`${FARCASTER_API}/v2/all-channels`)));
    const all = (JSON.parse(readFileSync(cache, 'utf8')) as { result: { channels: { id: string; name?: string; description?: string; followerCount?: number }[] } }).result.channels;
    channels = all.filter((c) => mentionsPoland(`${c.id.replace(/-/g, ' ')} ${c.name ?? ''} ${c.description ?? ''}`) || isPolishText(c.description ?? '')).map((c) => c.id);
    log(`Kanały polskie: ${channels.join(', ')}`);

    // 2. their followers
    const seeds = new Map<number, string>();
    for (const id of channels) {
      const done = `${dir}/channel-${id}.json`;
      let fids: number[] = existsSync(done) ? (JSON.parse(readFileSync(done, 'utf8')) as number[]) : [];
      if (!existsSync(done)) {
        let cursor: string | undefined;
        do {
          const page = await api.json<{ result: { users: { fid: number }[] }; next?: { cursor?: string } }>(`${FARCASTER_API}/v1/channel-followers?channelId=${encodeURIComponent(id)}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
          fids.push(...(page?.result.users ?? []).map((u) => u.fid));
          cursor = page?.next?.cursor;
        } while (cursor);
        fids = [...new Set(fids)];
        writeFileSync(done, JSON.stringify(fids));
      }
      for (const fid of fids) if (!seeds.has(fid)) seeds.set(fid, `kanał ${id}`);
    }
    log(`Obserwujący polskie kanały: ${seeds.size}`);
    for (const [fid, via] of seeds) {
      if (spent() >= budget) break;
      if (markSeen(fid)) await evaluate(fid, via);
    }

    // posts of the accounts known so far: they do not have to wait for the slow step below
    await readPosts();

    // 3. follow lists of Polish accounts, round after round (slow: the service allows 500 list pages an hour)
    for (let round = 1; spent() < budget; round++) {
      const frontier = [...records.values()].filter((r) => isPolish(r) && !expanded.has(String(r.fid)) && r.following > 0).sort((a, b) => b.polish.score - a.polish.score || a.following - b.following);
      if (!frontier.length) break;
      log(`Runda ${round}: ${frontier.length} polskich kont do rozwinięcia, ${[...records.values()].filter(isPolish).length} polskich łącznie`);
      for (const r of frontier) {
        if (spent() >= budget) break;
        let cursor: string | undefined;
        for (let page = 0; page < (opts.maxFollowPages ?? 20) && spent() < budget; page++) {
          let res: { result: { users: Record<string, unknown>[] }; next?: { cursor?: string } } | undefined;
          try {
            res = await follows.json(`${FARCASTER_API}/v2/following?fid=${r.fid}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
          } catch (err) {
            // The hourly allowance for follow lists is used up. This account is left for the next run, unfinished, and the step ends here.
            if (!(err instanceof GaveUpError)) throw err;
            quotaSpent = true;
            break;
          }
          for (const raw of res?.result.users ?? []) {
            const p = parseFarcasterUser(raw);
            if (!p || !markSeen(p.fid)) continue;
            // The follow list already carries location and description: only accounts that look Polish cost another request.
            if (polishSignals({ location: p.location, bio: p.bio, name: p.displayName, url: p.url }).score >= POLISH_FROM) await evaluate(p.fid, `obserwowany przez ${r.username ?? r.fid}`);
          }
          cursor = res?.next?.cursor;
          if (!cursor) break;
        }
        if (quotaSpent) break;
        expanded.add(String(r.fid));
        appendFileSync(`${dir}/expanded.txt`, `${r.fid}\n`);
      }
      if (quotaSpent) break;
    }

    await readPosts();
  } catch (err) {
    if (!(err instanceof BlockedError) && !(err instanceof GaveUpError)) throw err;
    stopped = err.message; // the service said no, or stopped answering: stop here, keep what we have
  }
  if (!stopped && spent() >= budget) stopped = 'wyczerpany limit zapytań tego przebiegu';
  if (!stopped && quotaSpent) stopped = 'wyczerpany godzinny limit list obserwowanych; pozostałe konta zostaną rozwinięte przy następnym uruchomieniu';

  const polish = [...records.values()].filter(isPolish);
  const castLines = existsSync(`${dir}/casts.jsonl`) ? readFileSync(`${dir}/casts.jsonl`, 'utf8').split('\n').filter(Boolean).length : 0;
  return {
    channels, evaluated: seen.size, polish: polish.length, withWallet: polish.filter((r) => r.wallets.length).length, wallets: new Set(polish.flatMap((r) => r.wallets)).size,
    castsOf: casted.size, casts: castLines, requests: spent(), stopped,
  };
}

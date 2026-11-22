import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { FARCASTER_NODE, parseFarcasterCasts, parseFarcasterClaims, parseFarcasterUserData } from '@olcys/connectors';
import { verifyFarcasterClaim } from '@olcys/core';
import { readAttestations } from './attestations';
import { readFarcasterRecords, type FarcasterRecord } from './farcaster';
import { parseGeo } from './poland';
import { polishSignals } from './polish';
import { BlockedError, GaveUpError, PoliteClient } from './polite';

export interface ExpandOptions {
  maxRequests?: number;
  perSecond?: number;
  /** A candidate is looked at once this many known Polish accounts follow it or are followed by it. */
  minNeighbours?: number;
  /** From this many Polish neighbours on, an account with no Polish sign on its profile gets a second look: all its wallets are checked against the attestations. */
  postsFrom?: number;
  log?(message: string): void;
}

export interface ExpandResult {
  polish: number;
  added: number;
  checked: number;
  withWallet: number;
  wallets: number;
  claimsVerified: number;
  claimsFailed: number;
  withX: number;
  requests: number;
  stopped?: string;
}

const POLISH_FROM = 0.5;
const readLines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

/**
 * Grows the Polish register by walking the follow graph on the protocol node.
 *
 * People follow people they know. An account that several known Polish accounts follow, or that follows several
 * of them, is far more likely to be Polish than a random one — so candidates are looked at in the order of how
 * many Polish neighbours they have, and most of the network is never looked at at all.
 *
 * Whether a candidate is Polish is still decided by what the account itself shows: the coordinates of its stated
 * location, the language of its description, and — for well-connected accounts that state nothing — the language
 * of its posts. Every wallet claim of an accepted account is verified on the spot.
 */
export async function expandFarcaster(dir: string, opts: ExpandOptions = {}): Promise<ExpandResult> {
  mkdirSync(dir, { recursive: true });
  const log = opts.log ?? (() => {});
  const node = new PoliteClient(opts.perSecond ?? 8, 4);
  const budget = opts.maxRequests ?? 30_000;
  const minNeighbours = opts.minNeighbours ?? 2;
  const postsFrom = opts.postsFrom ?? 3;

  // Wallets whose owners Coinbase attests, in public, as verified in Poland (see attestations.ts).
  const attestedWallets = new Set(readAttestations(dir.replace(/\/farcaster$/, '')).map((a) => a.wallet));
  const records = new Map(readFarcasterRecords(dir).map((r) => [r.fid, r]));

  // Accounts already on file are judged again with the attestations: a wallet attested as Polish settles it.
  let reclassified = 0;
  for (const r of records.values()) {
    const attested = r.wallets.filter((w) => attestedWallets.has(w));
    if (!attested.length || r.attested?.length) continue;
    r.attested = attested;
    r.polish = polishSignals({ attested: true, location: r.location, bio: r.bio, name: r.displayName, url: r.url });
    reclassified++;
  }
  if (reclassified) {
    writeFileSync(`${dir}/profiles.jsonl`, [...records.values()].map((r) => JSON.stringify(r)).join('\n') + '\n');
    log(`Poświadczenia: ${reclassified} kont z pliku ma portfel poświadczony jako polski.`);
  }
  const isPolish = (r: FarcasterRecord) => r.polish.score >= POLISH_FROM;
  const checked = new Set(readLines(`${dir}/graph-checked.txt`).map(Number)); // candidates looked at and found not Polish
  const expanded = new Set(readLines(`${dir}/graph-expanded.txt`).map(Number));
  const posted = new Set(readLines(`${dir}/casted.txt`).map(Number));
  const score = new Map<number, number>(existsSync(`${dir}/graph-scores.json`) ? (JSON.parse(readFileSync(`${dir}/graph-scores.json`, 'utf8')) as [number, number][]) : []);
  const bump = (fid: number, by: number) => score.set(fid, (score.get(fid) ?? 0) + by);
  // Everyone who follows a Polish channel starts with a head start.
  if (!score.size) {
    for (const f of readdirSync(dir).filter((x) => /^channel-.*\.json$/.test(x))) for (const fid of JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as number[]) bump(fid, 3);
  }
  const before = [...records.values()].filter(isPolish).length;
  let [claimsVerified, claimsFailed] = [0, 0];
  let stopped: string | undefined;

  const neighbours = async (fid: number): Promise<void> => {
    const page = async (url: string, pick: (m: Record<string, any>) => number | undefined, weight: number) => {
      let token: string | undefined;
      for (let p = 0; p < 2 && node.requests < budget; p++) {
        const res = await node.json<{ messages?: Record<string, any>[]; nextPageToken?: string }>(`${url}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
        for (const m of res?.messages ?? []) {
          const other = pick(m);
          if (other && other !== fid) bump(other, weight);
        }
        token = res?.nextPageToken || undefined;
        if (!token) break;
      }
    };
    await page(`${FARCASTER_NODE}/v1/linksByFid?fid=${fid}&link_type=follow&pageSize=1000`, (m) => Number(m.data?.linkBody?.targetFid) || undefined, 1);
    // Whoever follows a small Polish account most likely knows the person; a large account's followers say less.
    await page(`${FARCASTER_NODE}/v1/linksByTargetFid?target_fid=${fid}&link_type=follow&pageSize=1000`, (m) => Number(m.data?.fid) || undefined, 1);
  };

  const readPosts = async (fid: number): Promise<string[]> => {
    const casts = parseFarcasterCasts(await node.json(`${FARCASTER_NODE}/v1/castsByFid?fid=${fid}&pageSize=100&reverse=true`));
    if (casts.length && !posted.has(fid)) {
      appendFileSync(`${dir}/casts.jsonl`, casts.map((c) => JSON.stringify({ fid, ...c })).join('\n') + '\n');
      posted.add(fid);
      appendFileSync(`${dir}/casted.txt`, `${fid}\n`);
    }
    return casts.map((c) => c.text);
  };

  /** Looks at one candidate. Returns the record if the account is Polish. */
  const check = async (fid: number, neighbourCount: number): Promise<FarcasterRecord | undefined> => {
    const profile = parseFarcasterUserData(await node.json(`${FARCASTER_NODE}/v1/userDataByFid?fid=${fid}`), fid);
    const reject = () => {
      checked.add(fid);
      appendFileSync(`${dir}/graph-checked.txt`, `${fid}\n`);
      return undefined;
    };
    if (!profile) return reject();
    const geo = parseGeo(profile.geo);
    // The account's primary wallet comes with the profile; if Coinbase attests it as Polish, nothing more is needed.
    let attested = profile.wallets.some((w) => attestedWallets.has(w));
    const signals = (texts?: string[]) => polishSignals({ attested, geo, bio: profile.bio, name: profile.displayName, url: profile.url, texts });
    let polish = signals();
    let texts: string[] | undefined;
    let claims: ReturnType<typeof parseFarcasterClaims> | undefined;
    // Well-connected accounts that show nothing Polish get a second look: their other wallets, then the language of their posts.
    if (polish.score < POLISH_FROM && (polish.score > 0 || neighbourCount >= postsFrom)) {
      claims = parseFarcasterClaims(await node.json(`${FARCASTER_NODE}/v1/verificationsByFid?fid=${fid}`));
      attested = claims.some((c) => attestedWallets.has(c.address));
      polish = signals();
      // Posts are read only when the profile already hints at Poland: on this network Poles mostly post in English,
      // so the language of posts settled almost nothing and cost a request per candidate.
      if (polish.score < POLISH_FROM && polish.score > 0) {
        texts = await readPosts(fid);
        polish = signals(texts);
      }
    }
    if (polish.score < POLISH_FROM) return reject();

    // Accepted: its wallets, each with the claim the wallet's own key signed — checked here.
    claims ??= parseFarcasterClaims(await node.json(`${FARCASTER_NODE}/v1/verificationsByFid?fid=${fid}`));
    const wallets: string[] = [];
    for (const c of claims) {
      const ok = c.type !== 0 || verifyFarcasterClaim({ fid, address: c.address, blockHash: c.blockHash, signature: c.signature }).valid;
      if (c.type === 0) ok ? claimsVerified++ : claimsFailed++;
      if (ok && !wallets.includes(c.address)) wallets.push(c.address);
    }
    if (!texts) await readPosts(fid);
    const { geo: rawGeo, ...rest } = profile;
    const record: FarcasterRecord = {
      ...rest, wallets, attested: wallets.filter((w) => attestedWallets.has(w)), location: polish.reasons.find((r) => r.startsWith('podana lokalizacja'))?.replace(/^podana lokalizacja w Polsce \((.*)\)$/, '$1, Polska') ?? undefined,
      polish, via: `sieć obserwacji: ${Math.round(neighbourCount)} polskich sąsiadów`, fetchedAt: new Date().toISOString(),
    };
    void rawGeo;
    records.set(fid, record);
    appendFileSync(`${dir}/profiles.jsonl`, JSON.stringify(record) + '\n');
    return record;
  };

  try {
    for (let round = 1; node.requests < budget; round++) {
      // 1. neighbours of Polish accounts not yet expanded
      const frontier = [...records.values()].filter((r) => isPolish(r) && !expanded.has(r.fid));
      for (const r of frontier) {
        if (node.requests >= budget) break;
        await neighbours(r.fid);
        expanded.add(r.fid);
        appendFileSync(`${dir}/graph-expanded.txt`, `${r.fid}\n`);
      }
      writeFileSync(`${dir}/graph-scores.json`, JSON.stringify([...score]));
      // 2. the best-connected candidates not looked at yet
      const candidates = [...score].filter(([fid, s]) => s >= minNeighbours && !records.has(fid) && !checked.has(fid)).sort((a, b) => b[1] - a[1]);
      log(`Runda ${round}: rozwinięto ${frontier.length} kont; kandydatów ${candidates.length}; polskich ${[...records.values()].filter(isPolish).length}; zapytań ${node.requests}`);
      if (!candidates.length && !frontier.length) break;
      let found = 0;
      // A batch at a time, so that newly found accounts widen the search before the weakest candidates are looked at.
      for (const [fid, s] of candidates.slice(0, 1500)) {
        if (node.requests >= budget) break;
        if (await check(fid, s)) found++;
      }
      if (!found && !frontier.length && candidates.length <= 1500) break;
    }
  } catch (err) {
    if (!(err instanceof BlockedError) && !(err instanceof GaveUpError)) throw err;
    stopped = err.message;
  }
  writeFileSync(`${dir}/graph-scores.json`, JSON.stringify([...score]));
  if (!stopped && node.requests >= budget) stopped = 'wyczerpany limit zapytań tego przebiegu';
  const polish = [...records.values()].filter(isPolish);
  return {
    polish: polish.length, added: polish.length - before, checked: checked.size, withWallet: polish.filter((r) => r.wallets.length).length,
    wallets: new Set(polish.flatMap((r) => r.wallets)).size, claimsVerified, claimsFailed, withX: polish.filter((r) => r.connected.some((c) => c.platform === 'x')).length,
    requests: node.requests, stopped,
  };
}

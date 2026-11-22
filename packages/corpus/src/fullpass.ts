import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { FARCASTER_NODE, parseFarcasterClaims, parseFarcasterUserData } from '@olcys/connectors';
import { verifyFarcasterClaim } from '@olcys/core';
import { readAttestations } from './attestations';
import { readFarcasterRecords, type FarcasterRecord } from './farcaster';
import { parseGeo } from './poland';
import { polishSignals } from './polish';
import { BlockedError, GaveUpError, PoliteClient } from './polite';

export interface FullPassOptions {
  from?: number;
  to?: number;
  /** Starting pace, and the most it may rise to while the node keeps answering cleanly. */
  startPerSecond?: number;
  maxPerSecond?: number;
  log?(m: string): void;
}

/**
 * Reads every account of the network once, in order of registration. One request returns what the account says
 * about itself — name, description, location, connected handle, primary wallet — which is enough to decide whether
 * it is Polish: a stated location in Poland, a Polish description, or a primary wallet that Coinbase attests as Polish.
 * Accepted accounts get their wallet claims fetched and verified.
 *
 * The pace adapts: it rises while the node answers cleanly, halves when the node slows us down, and the run stops
 * outright if the node refuses. Progress is kept, so the pass can be continued.
 */
export async function fullPass(dir: string, opts: FullPassOptions = {}): Promise<{ scanned: number; polish: number; added: number; next: number; stopped?: string }> {
  mkdirSync(dir, { recursive: true });
  const log = opts.log ?? (() => {});
  const node = new PoliteClient(opts.startPerSecond ?? 40, 3);
  const cap = opts.maxPerSecond ?? 150;
  const attested = new Set(readAttestations(dir.replace(/\/farcaster$/, '')).map((a) => a.wallet));
  const records = new Map(readFarcasterRecords(dir).map((r) => [r.fid, r]));
  const known = new Set(existsSync(`${dir}/graph-checked.txt`) ? readFileSync(`${dir}/graph-checked.txt`, 'utf8').split('\n').filter(Boolean).map(Number) : []);
  const progress = `${dir}/fullpass-next.txt`;
  let next = opts.from ?? (existsSync(progress) ? Number(readFileSync(progress, 'utf8')) : 1);
  const end = opts.to ?? 3_500_000;
  const before = [...records.values()].filter((r) => r.polish.score >= 0.5).length;
  let scanned = 0;
  let added = 0;
  let stopped: string | undefined;

  const one = async (fid: number) => {
    if (records.has(fid) || known.has(fid)) return;
    const profile = parseFarcasterUserData(await node.json(`${FARCASTER_NODE}/v1/userDataByFid?fid=${fid}`), fid);
    scanned++;
    if (!profile) return;
    const geo = parseGeo(profile.geo);
    const polish = polishSignals({ attested: profile.wallets.some((w) => attested.has(w)), geo, bio: profile.bio, name: profile.displayName, url: profile.url });
    if (polish.score < 0.5) return;
    const claims = parseFarcasterClaims(await node.json(`${FARCASTER_NODE}/v1/verificationsByFid?fid=${fid}`));
    const wallets: string[] = [];
    for (const c of claims) {
      const ok = c.type !== 0 || verifyFarcasterClaim({ fid, address: c.address, blockHash: c.blockHash, signature: c.signature }).valid;
      if (ok && !wallets.includes(c.address)) wallets.push(c.address);
    }
    const { geo: _geo, ...rest } = profile;
    const record: FarcasterRecord = {
      ...rest, wallets, attested: wallets.filter((w) => attested.has(w)),
      location: polish.reasons.find((r) => r.startsWith('podana lokalizacja'))?.replace(/^podana lokalizacja w Polsce \((.*)\)$/, '$1, Polska'),
      polish, via: 'pełny przegląd kont sieci', fetchedAt: new Date().toISOString(),
    };
    records.set(fid, record);
    appendFileSync(`${dir}/profiles.jsonl`, JSON.stringify(record) + '\n');
    added++;
  };

  const BLOCK = 4000;
  try {
    while (next < end) {
      const seen = node.slowdowns;
      const started = Date.now();
      const fids = Array.from({ length: Math.min(BLOCK, end - next) }, (_, i) => next + i);
      let i = 0;
      const worker = async () => {
        while (i < fids.length) {
          const fid = fids[i++];
          try {
            await one(fid);
          } catch (err) {
            if (err instanceof BlockedError) throw err;
            if (!(err instanceof GaveUpError)) throw err; // one account that will not load is skipped
          }
        }
      };
      await Promise.all(Array.from({ length: 24 }, worker));
      next += fids.length;
      writeFileSync(progress, String(next));
      // Adapt: any sign of strain halves the pace; a clean block earns a little more, up to the cap.
      const strained = node.slowdowns - seen;
      node.perSecond = strained > 0 ? Math.max(10, Math.floor(node.perSecond / 2)) : Math.min(cap, node.perSecond + 5);
      log(`do konta ${next - 1}: przejrzano ${scanned}, nowych polskich ${added}, tempo ${node.perSecond}/s${strained ? ` (spowolnień: ${strained})` : ''}, blok w ${Math.round((Date.now() - started) / 1000)} s`);
      if (strained > 200) {
        stopped = 'węzeł wielokrotnie odmawiał lub nie odpowiadał; przegląd wstrzymany';
        break;
      }
    }
  } catch (err) {
    if (!(err instanceof BlockedError)) throw err;
    stopped = err.message;
  }
  writeFileSync(progress, String(next));
  return { scanned, polish: before + added, added, next, stopped };
}

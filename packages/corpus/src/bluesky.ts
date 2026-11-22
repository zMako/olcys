import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extractAddresses } from '@olcys/core';
// Imported by path until the connectors package lists these in its index.
import { BLUESKY_API, parseBlueskyActors, type BlueskyProfile } from '@olcys/connectors';
import { polishSignals, type PolishSignals } from './polish';
import { BlockedError, GaveUpError, PoliteClient } from './polite';

/** A Polish Bluesky account that itself states a wallet: a name (something.eth) or an address in its description. */
export interface BlueskyRecord {
  handle: string;
  did: string;
  displayName?: string;
  description?: string;
  /** Wallet names the account shows, e.g. "nick.eth", "nick.base.eth". */
  names: string[];
  /** Crypto addresses written out in the description. */
  addresses: string[];
  polish: PolishSignals;
  /** The search query that surfaced the account. */
  via: string;
  fetchedAt: string;
}

/**
 * What the account search is asked. The search ranks by popularity and treats several words loosely, so the
 * list is made of single words: words Polish people put in a description, Polish places, and crypto words.
 * Every account returned is then judged locally — the query only decides who gets looked at.
 */
export const BLUESKY_QUERIES = [
  // crypto, in Polish
  'krypto', 'kryptowaluty', 'kryptowaluta', 'kryptowalut', 'kryptowalutowy', 'kryptoinwestor', 'bitcoiner', 'hodler', 'inwestor', 'inwestycje', 'inwestowanie', 'giełda', 'gielda',
  'finanse', 'trader', 'kopanie', 'górnik',
  // crypto, international (few of these accounts are Polish; the local filter keeps those that are)
  'bitcoin', 'btc', 'eth', 'ethereum', 'blockchain', 'web3', 'nft', 'defi', 'hodl', 'crypto', 'altcoin', 'solana', 'degen', 'airdrop', 'dao', 'solidity', 'stablecoin', 'satoshi', 'ens',
  'onchain', 'farcaster', 'base',
  // Poland and its cities
  'polska', 'polski', 'polak', 'polka', 'polacy', 'poland', 'polish', 'warszawa', 'warsaw', 'kraków', 'krakow', 'wrocław', 'wroclaw', 'poznań', 'poznan', 'gdańsk', 'gdansk', 'gdynia',
  'łódź', 'lodz', 'katowice', 'szczecin', 'lublin', 'białystok', 'bydgoszcz', 'rzeszów', 'toruń', 'śląsk', 'trójmiasto', 'kielce', 'olsztyn', 'opole', 'gliwice',
  // words of a Polish description
  'programista', 'programistka', 'inżynier', 'informatyk', 'przedsiębiorca', 'dziennikarz', 'student', 'prywatnie', 'poglądy', 'pasjonat', 'miłośnik', 'entuzjasta', 'kibic', 'tata',
  'mąż', 'ojciec', 'mama', 'żona', 'jestem', 'lubię', 'piszę', 'moje', 'tylko', 'oraz', 'wszystko', 'życie', 'technologie', 'gracz', 'twórca', 'fotograf', 'grafik', 'analityk',
  'ekonomista', 'prawnik', 'nauczyciel', 'lekarz', 'kierowca', 'muzyk', 'podróże', 'książki', 'polityka', 'sport', 'piłka',
];

/** Wallet names in a text: "nick.eth", "nick.base.eth". Addresses of pages ("nick.eth.limo") count too: the name is the same. */
export function walletNamesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![a-z0-9.@/_-])([a-z0-9][a-z0-9-]{2,}(?:\.base)?\.eth)(?![a-z0-9-])/gi)) out.add(m[1].toLowerCase());
  return [...out];
}

/** Judges one account: Polish by its own description, name and domain — and does it state a wallet? */
export function judgeBlueskyAccount(a: BlueskyProfile): { polish: PolishSignals; names: string[]; addresses: string[] } {
  const own = a.handle.endsWith('.bsky.social') ? undefined : `https://${a.handle}`;
  const polish = polishSignals({ bio: a.description, name: a.displayName, url: own });
  const text = `${a.displayName ?? ''}\n${a.description ?? ''}`;
  return { polish, names: walletNamesIn(text), addresses: [...new Set(extractAddresses(a.description ?? '').map((m) => m.address))] };
}

export interface BlueskyIngestOptions {
  queries?: string[];
  /** Pages (100 accounts each) read per query. */
  maxPagesPerQuery?: number;
  /** Upper limit of requests in this run. The run can be continued later; finished queries are not asked again. */
  maxRequests?: number;
  perSecond?: number;
  log?(message: string): void;
}

export interface BlueskyIngestResult {
  queries: number;
  requests: number;
  /** Distinct accounts the search returned, over all runs. */
  seen: number;
  polish: number;
  /** Polish accounts that state a wallet name or an address: these are the records kept. */
  withWallet: number;
  added: number;
  /** Set when the run ended early: the service refused, or the request budget ran out. */
  stopped?: string;
}

export function readBlueskyRecords(dir: string): BlueskyRecord[] {
  const file = `${dir}/profiles.jsonl`;
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as BlueskyRecord) : [];
}

const POLISH_FROM = 0.5;

/**
 * Finds Polish Bluesky accounts that state a wallet, through the network's public account search.
 * Kept in `dir`:
 *   profiles.jsonl   the accounts that are Polish and state a wallet name or an address;
 *   maybe.jsonl      accounts that state a wallet and show some sign of Poland, but not enough to count as Polish;
 *   seen.tsv         every account the search returned: id, Polish score, wallet stated or not (for honest counts);
 *   state.json       which queries are finished and where the current one stopped, so the run can be continued.
 */
export async function ingestBluesky(dir: string, opts: BlueskyIngestOptions = {}): Promise<BlueskyIngestResult> {
  mkdirSync(dir, { recursive: true });
  const log = opts.log ?? (() => {});
  const client = new PoliteClient(Math.min(5, opts.perSecond ?? 4));
  const stateFile = `${dir}/state.json`;
  const state: { done: string[]; current?: { query: string; cursor: string; page: number } } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { done: [] };
  const seen = new Map<string, [number, boolean]>();
  if (existsSync(`${dir}/seen.tsv`)) for (const line of readFileSync(`${dir}/seen.tsv`, 'utf8').split('\n')) {
    const [did, score, wallet] = line.split('\t');
    if (did) seen.set(did, [Number(score), wallet === '1']);
  }
  const kept = new Set(readBlueskyRecords(dir).map((r) => r.did));
  const maxPages = opts.maxPagesPerQuery ?? 30;
  let added = 0;
  let queries = 0;
  let stopped: string | undefined;

  try {
    for (const query of opts.queries ?? BLUESKY_QUERIES) {
      if (state.done.includes(query)) continue;
      queries++;
      let cursor = state.current?.query === query ? state.current.cursor : undefined;
      let page = state.current?.query === query ? state.current.page : 0;
      let fresh = 0;
      for (; page < maxPages; ) {
        if (client.requests >= (opts.maxRequests ?? 4000)) {
          stopped = 'wyczerpano limit zapytań tego przebiegu';
          break;
        }
        let answer;
        try {
          answer = await client.json<Record<string, unknown>>(`${BLUESKY_API}/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(query)}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        } catch (err) {
          if (!(err instanceof GaveUpError)) throw err;
          break; // this query will not load; the next one may
        }
        const { actors, cursor: next } = parseBlueskyActors(answer);
        page++;
        for (const a of actors) {
          if (seen.has(a.did)) continue;
          fresh++;
          const verdict = judgeBlueskyAccount(a);
          const polish = verdict.polish.score >= POLISH_FROM;
          const wallet = verdict.names.length + verdict.addresses.length > 0;
          seen.set(a.did, [verdict.polish.score, wallet]);
          appendFileSync(`${dir}/seen.tsv`, `${a.did}\t${verdict.polish.score}\t${wallet ? 1 : 0}\n`);
          if (!wallet || kept.has(a.did) || verdict.polish.score <= 0) continue;
          const record: BlueskyRecord = { handle: a.handle, did: a.did, displayName: a.displayName, description: a.description, names: verdict.names, addresses: verdict.addresses, polish: verdict.polish, via: query, fetchedAt: new Date().toISOString() };
          if (!polish) {
            appendFileSync(`${dir}/maybe.jsonl`, JSON.stringify(record) + '\n');
            continue;
          }
          appendFileSync(`${dir}/profiles.jsonl`, JSON.stringify(record) + '\n');
          kept.add(a.did);
          added++;
        }
        if (!next || !actors.length) break;
        cursor = next;
        state.current = { query, cursor, page };
        writeFileSync(stateFile, JSON.stringify(state));
      }
      if (stopped) break;
      state.done.push(query);
      delete state.current;
      writeFileSync(stateFile, JSON.stringify(state));
      log(`„${query}”: stron ${page}, nowych kont ${fresh}; łącznie kont ${seen.size}, polskich ${[...seen.values()].filter(([p]) => p >= POLISH_FROM).length}, z portfelem ${kept.size}`);
    }
  } catch (err) {
    if (!(err instanceof BlockedError)) throw err;
    stopped = `serwis odmówił: ${err.message}`;
  }
  const flags = [...seen.values()];
  return { queries, requests: client.requests, seen: seen.size, polish: flags.filter(([p]) => p >= POLISH_FROM).length, withWallet: kept.size, added, stopped };
}

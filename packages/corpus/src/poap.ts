import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { parseAddress } from '@olcys/core';
import { PoliteClient } from './polite';

/**
 * Attendance tokens (POAP): an organiser hands a token to the wallets of people who took part in an event.
 * A wallet holding a token of an event held in Poland was, in all likelihood, used by someone who was there —
 * a pointer to where the owner moves, not a proof of who they are (conferences have foreign guests, and a
 * token can be claimed with a link passed on by someone else).
 *
 * The public index answers without a key. One query per request; everything is paced.
 */
export const POAP_INDEX = 'https://public.compass.poap.tech/v1/graphql';
/** How organisers spelled the country. The index has no country code, only free text. */
const POLAND = ['Poland', 'poland', 'POLAND', 'Polnd', 'Polska', 'polska', 'POLSKA', 'PL'];

export interface PoapDrop {
  id: number;
  name: string;
  city?: string;
  country: string;
  /** Day the event started. */
  date?: string;
  /** True when the organiser marked the event as held online. */
  virtual: boolean;
}

export interface PoapHolder {
  wallet: string;
  dropId: number;
  drop: string;
  city?: string;
  date?: string;
  virtual: boolean;
  /** When the token was issued to the wallet. */
  mintedAt?: string;
}

export const poapDir = (root: string) => `${root}/poap`;
const lines = <T>(file: string): T[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []);
export const readPoapDrops = (root: string) => lines<PoapDrop>(`${poapDir(root)}/drops.jsonl`);
export const readPoapHolders = (root: string) => lines<PoapHolder>(`${poapDir(root)}/holders.jsonl`);

async function ask<T>(client: PoliteClient, endpoint: string, query: string): Promise<T> {
  const res = await client.raw(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const parsed = JSON.parse(res.body) as { data?: T; errors?: { message: string }[] };
  if (res.status !== 200 || !parsed.data) throw new Error(`Indeks POAP: ${parsed.errors?.[0]?.message ?? `odpowiedź ${res.status}`}`);
  return parsed.data;
}

const day = (t: unknown): string | undefined => (typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString().slice(0, 10) : undefined);
const instant = (t: unknown): string | undefined =>
  typeof t === 'number' && t > 0 ? new Date(t * 1000).toISOString() : typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : undefined;

/**
 * Downloads the events located in Poland and, for each, the wallets that hold its token.
 * Events already read are skipped, so the job can be stopped and continued, and repeated later for new events.
 */
export async function ingestPolishPoaps(root: string, opts: { endpoint?: string; perSecond?: number; maxDrops?: number; onProgress?(drops: number, holders: number): void } = {}): Promise<{ drops: number; newDrops: number; holders: number; wallets: number }> {
  const dir = poapDir(root);
  mkdirSync(dir, { recursive: true });
  const endpoint = opts.endpoint ?? POAP_INDEX;
  const client = new PoliteClient(Math.min(opts.perSecond ?? 2, 3), 4);
  const known = new Set(readPoapDrops(root).map((d) => d.id));
  const doneFile = `${dir}/drops.done`;
  const done = new Set(existsSync(doneFile) ? readFileSync(doneFile, 'utf8').split('\n').filter(Boolean).map(Number) : []);

  // 1. The events.
  const drops: PoapDrop[] = readPoapDrops(root);
  let newDrops = 0;
  for (let offset = 0; ; offset += 200) {
    const page = (await ask<{ drops: Record<string, any>[] }>(client, endpoint, `{ drops(where: { country: { _in: ${JSON.stringify(POLAND)} } }, limit: 200, offset: ${offset}, order_by: { id: asc }) { id name city country start_date location_type virtual } }`)).drops;
    for (const d of page) {
      if (known.has(d.id)) continue;
      known.add(d.id);
      const drop: PoapDrop = { id: d.id, name: String(d.name ?? '').trim(), city: d.city ? String(d.city).trim() : undefined, country: String(d.country), date: day(d.start_date), virtual: d.virtual === true || d.location_type === 'VIRTUAL' };
      drops.push(drop);
      appendFileSync(`${dir}/drops.jsonl`, JSON.stringify(drop) + '\n');
      newDrops++;
    }
    if (page.length < 200) break;
  }

  // 2. Who holds each event's token.
  let holders = readPoapHolders(root).length;
  let read = 0;
  for (const drop of drops) {
    if (done.has(drop.id)) continue;
    if (opts.maxDrops !== undefined && read >= opts.maxDrops) break;
    const found: PoapHolder[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = (await ask<{ poaps: Record<string, any>[] }>(client, endpoint, `{ poaps(where: { drop_id: { _eq: ${drop.id} } }, limit: 500, offset: ${offset}, order_by: { id: asc }) { collector_address minted_on } }`)).poaps;
      for (const p of page) {
        const wallet = parseAddress(String(p.collector_address ?? ''))?.address;
        // The zero address and the usual "burn" address are where discarded tokens go, not wallets.
        if (!wallet || /^0x0{36,}/i.test(wallet) || /^0x0{20,}dead$/i.test(wallet)) continue;
        found.push({ wallet, dropId: drop.id, drop: drop.name, city: drop.city, date: drop.date, virtual: drop.virtual, mintedAt: instant(p.minted_on) });
      }
      if (page.length < 500) break;
    }
    // A drop's holders are written in one piece, then the drop is marked as read: an interrupted run repeats nothing.
    if (found.length) appendFileSync(`${dir}/holders.jsonl`, found.map((h) => JSON.stringify(h)).join('\n') + '\n');
    appendFileSync(doneFile, `${drop.id}\n`);
    holders += found.length;
    read++;
    opts.onProgress?.(read, holders);
  }
  return { drops: drops.length, newDrops, holders, wallets: new Set(readPoapHolders(root).map((h) => h.wallet)).size };
}

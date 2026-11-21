import type { Transfer } from '@olcys/core';
import { formatAmount } from './indicators';
import { DEFAULT_RULESET, type Ruleset } from './ruleset';

/** An amount the person stated in public, with where and when. */
export interface StatedAmount {
  documentId: string;
  url: string;
  docType: string;
  title?: string;
  /** When the ad or post was published. */
  at?: string;
  value: number;
  unit: string;
  raw: string;
  /** 'price' = the asking price of an ad; 'text' = an amount mentioned in a post. */
  kind: 'price' | 'text';
}

/** A transfer on one of the person's addresses that a stated amount could correspond to. */
export interface CandidateTransfer extends Transfer {
  /** The person's address that took part, and the published address of its wallet. */
  address: string;
  walletRoot: string;
  direction: 'in' | 'out';
  valuePln?: number;
  rate?: { mid: number; table: string };
}

/** A stated amount that corresponds to an actual transfer: an independent tie between a document and an address. */
export interface AmountMatch {
  documentId: string;
  url: string;
  docType: string;
  kind: 'price' | 'text';
  statedRaw: string;
  statedAt?: string;
  chain: string;
  address: string;
  walletRoot: string;
  txHash: string;
  transferAt: string;
  asset: string;
  amount: number;
  valuePln?: number;
  /** How far the transfer is from the stated amount, as a fraction. */
  deviation: number;
  /** False when more than one transfer fits; such a match is reported but earns no points. */
  unique: boolean;
  detail: string;
}

const DAY = 86_400_000;
const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;
const day = (iso?: string) => (iso ? iso.slice(0, 10) : '?');
const pln = (n: number) => `${Math.round(n).toLocaleString('pl-PL')} zł`;

/**
 * Looks for transfers that correspond to amounts the person stated in public.
 *  - An ad's asking price is compared with what arrived afterwards, valued in złoty on the day of the transfer.
 *  - A crypto amount mentioned in a post is compared with transfers of that asset within a few days.
 * Each transfer can answer one stated amount only, the closest one.
 */
export function matchAmounts(stated: StatedAmount[], transfers: CandidateTransfer[], ruleset: Ruleset = DEFAULT_RULESET): AmountMatch[] {
  const cfg = ruleset.amountMatch;
  const pairs: { s: StatedAmount; t: CandidateTransfer; deviation: number }[] = [];
  const fits = new Map<StatedAmount, number>();
  for (const s of stated) {
    if (!s.at) continue;
    const published = Date.parse(s.at);
    const [from, to] = s.kind === 'price' ? [published - DAY, published + cfg.adWindowDays * DAY] : [published - cfg.postWindowDays * DAY, published + cfg.postWindowDays * DAY];
    for (const t of transfers) {
      const when = Date.parse(t.at);
      if (when < from || when > to) continue;
      if (s.kind === 'price' && t.direction !== 'in') continue; // a sale brings money in
      let deviation: number;
      if (s.unit === 'PLN') {
        if (t.valuePln === undefined) continue;
        deviation = Math.abs(t.valuePln - s.value) / s.value;
        if (deviation > cfg.tolerancePln) continue;
      } else {
        if (t.asset !== s.unit) continue;
        deviation = Math.abs(t.amount - s.value) / s.value;
        if (deviation > cfg.toleranceCrypto) continue;
      }
      pairs.push({ s, t, deviation });
      fits.set(s, (fits.get(s) ?? 0) + 1);
    }
  }

  // Closest pairs first; each stated amount and each transfer is used once.
  pairs.sort((a, b) => a.deviation - b.deviation || a.t.at.localeCompare(b.t.at));
  const usedStated = new Set<StatedAmount>();
  const usedTransfers = new Set<string>();
  const out: AmountMatch[] = [];
  for (const { s, t, deviation } of pairs) {
    const key = `${t.txHash}|${t.from}|${t.to}|${t.asset}`;
    if (usedStated.has(s) || usedTransfers.has(key)) continue;
    usedStated.add(s);
    usedTransfers.add(key);
    const unique = fits.get(s) === 1;
    const what = `${formatAmount(t.amount)} ${t.asset}`;
    const detail =
      s.kind === 'price'
        ? `Ogłoszenie${s.title ? ` „${s.title}”` : ''} z ${day(s.at)} podaje cenę ${s.raw}. Dnia ${day(t.at)} na adres ${short(t.address)} wpłynęło ${what}, warte tego dnia ${pln(t.valuePln ?? 0)}${t.rate ? ` (kurs NBP ${t.rate.mid.toLocaleString('pl-PL', { minimumFractionDigits: 4 })}, tab. ${t.rate.table})` : ''} — różnica ${(deviation * 100).toFixed(1).replace('.', ',')}%.${unique ? '' : ' W tym okresie pasuje więcej niż jedna wpłata.'}`
        : `We wpisie z ${day(s.at)} mowa o kwocie „${s.raw}”. Dnia ${day(t.at)} adres ${short(t.address)} ${t.direction === 'in' ? 'otrzymał' : 'wysłał'} ${what}.${unique ? '' : ' W tym okresie pasuje więcej niż jeden przelew.'}`;
    out.push({
      documentId: s.documentId, url: s.url, docType: s.docType, kind: s.kind, statedRaw: s.raw, statedAt: s.at,
      chain: t.chain, address: t.address, walletRoot: t.walletRoot, txHash: t.txHash, transferAt: t.at, asset: t.asset, amount: t.amount,
      valuePln: t.valuePln, deviation, unique, detail,
    });
  }
  return out.sort((a, b) => a.transferAt.localeCompare(b.transferAt));
}

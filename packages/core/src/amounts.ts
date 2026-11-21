/** An amount of money someone stated in public, e.g. the price in an ad or "0,01 ETH doszło". */
export interface StatedValue {
  value: number;
  /** PLN, or the ticker of a crypto asset. */
  unit: string;
  raw: string;
}

const PLN = /(\d{1,3}(?:[ \u00a0.]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:zł|zl|PLN|złotych)(?![\p{L}\d])/giu;
const CRYPTO = /(\d+(?:[.,]\d+)?)\s*(BTC|ETH|USDT|USDC|TRX)\b/g;

/** Amounts in złoty ("3 200 zł", "1900 PLN"). */
export function findPlnAmounts(text: string): StatedValue[] {
  const out: StatedValue[] = [];
  for (const m of text.matchAll(PLN)) {
    const value = Number(m[1].replace(/[ \u00a0.]/g, '') + (m[2] ? `.${m[2]}` : ''));
    if (value > 0) out.push({ value, unit: 'PLN', raw: m[0].trim() });
  }
  return out;
}

/** Amounts of crypto assets ("0,5 BTC", "5000 USDT"). */
export function findCryptoAmounts(text: string): StatedValue[] {
  const out: StatedValue[] = [];
  for (const m of text.matchAll(CRYPTO)) {
    const value = Number(m[1].replace(',', '.'));
    if (value > 0) out.push({ value, unit: m[2], raw: m[0] });
  }
  return out;
}

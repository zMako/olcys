import type { PriceQuote, RateQuote, Transfer } from '@olcys/core';
import type { Certainty, IndicatorType, OffRamp } from './indicators';
import { formatAmount } from './indicators';

/** A transfer to a cash-out service with its value in złoty and the figures the value was computed from. */
export interface ValuedTransfer {
  chain: string;
  txHash: string;
  at: string;
  /** Calendar day in Poland, which decides the tax year and the exchange-rate table. */
  day: string;
  taxYear: number;
  from: string;
  to: string;
  counterparty?: string;
  asset: string;
  amount: number;
  channel: IndicatorType;
  channelTitle: string;
  certainty: Certainty;
  priceUsd?: number;
  priceSource?: string;
  rate?: { mid: number; table: string; effectiveDate: string };
  valueUsd?: number;
  valuePln?: number;
  /** Why the transfer could not be valued, if it could not. */
  note?: string;
}

export interface EstimateYear {
  year: number;
  probablePln: number;
  possiblePln: number;
  totalPln: number;
  channels: { channel: IndicatorType; title: string; certainty: Certainty; pln: number; count: number }[];
}

/** Estimated value of crypto sent to services where it could be turned into traditional currency. */
export interface Estimate {
  /** Only addresses scoring at least this much, on accounts firmly tied to the person, are counted. */
  minScore: number;
  addresses: { chain: string; address: string; score: number; walletSize: number }[];
  /** Attributed addresses left out because the link is too weak. */
  leftOut: { chain: string; address: string; score: number; reason: string }[];
  years: EstimateYear[];
  totalPln: number;
  transfers: ValuedTransfer[];
  unvalued: number;
  /** The method in plain sentences, for the report. */
  method: string[];
}

const WARSAW = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Calendar day in Poland for a UTC timestamp. */
export const warsawDay = (iso: string): string => WARSAW.format(new Date(iso));

export function valueTransfer(
  t: Transfer,
  meta: { channel: IndicatorType; channelTitle: string; certainty: Certainty; counterparty?: string },
  price: PriceQuote | undefined,
  rate: RateQuote | undefined,
): ValuedTransfer {
  const day = warsawDay(t.at);
  const base: ValuedTransfer = {
    chain: t.chain, txHash: t.txHash, at: t.at, day, taxYear: Number(day.slice(0, 4)), from: t.from, to: t.to,
    asset: t.asset, amount: t.amount, ...meta,
  };
  if (!price) return { ...base, note: `brak kursu ${t.asset} z dnia ${day}` };
  if (!rate) return { ...base, priceUsd: price.usd, priceSource: price.source, note: `brak tabeli kursów NBP sprzed dnia ${day}` };
  const valueUsd = t.amount * price.usd;
  return {
    ...base,
    priceUsd: price.usd,
    priceSource: price.source,
    rate: { mid: rate.mid, table: rate.table, effectiveDate: rate.effectiveDate },
    valueUsd: Math.round(valueUsd * 100) / 100,
    valuePln: Math.round(valueUsd * rate.mid * 100) / 100,
  };
}

export function buildEstimate(
  transfers: ValuedTransfer[],
  meta: Pick<Estimate, 'minScore' | 'addresses' | 'leftOut'>,
): Estimate {
  const sorted = [...transfers].sort((a, b) => a.at.localeCompare(b.at));
  const years = new Map<number, EstimateYear>();
  for (const t of sorted) {
    if (t.valuePln === undefined) continue;
    const y = years.get(t.taxYear) ?? { year: t.taxYear, probablePln: 0, possiblePln: 0, totalPln: 0, channels: [] };
    if (t.certainty === 'probable') y.probablePln += t.valuePln;
    else y.possiblePln += t.valuePln;
    y.totalPln += t.valuePln;
    let c = y.channels.find((x) => x.channel === t.channel);
    if (!c) y.channels.push((c = { channel: t.channel, title: t.channelTitle, certainty: t.certainty, pln: 0, count: 0 }));
    c.pln += t.valuePln;
    c.count++;
    years.set(t.taxYear, y);
  }
  const whole = (n: number) => Math.round(n);
  const list = [...years.values()]
    .sort((a, b) => a.year - b.year)
    .map((y) => ({
      ...y, probablePln: whole(y.probablePln), possiblePln: whole(y.possiblePln), totalPln: whole(y.totalPln),
      channels: y.channels.map((c) => ({ ...c, pln: whole(c.pln) })).sort((a, b) => b.pln - a.pln),
    }));
  return {
    ...meta,
    years: list,
    totalPln: list.reduce((n, y) => n + y.totalPln, 0),
    transfers: sorted,
    unvalued: sorted.filter((t) => t.valuePln === undefined).length,
    method: [
      `Do szacunku wchodzą tylko adresy z Wskaźnikiem Pewności co najmniej ${meta.minScore}%, należące do kont pewnie powiązanych z osobą, wraz z adresami tego samego portfela.`,
      'Liczone są przelewy do usług, w których kryptowaluta może zostać zamieniona na walutę tradycyjną, towar lub usługę: giełd, usług P2P, bramek płatniczych, kart płatniczych i kantorów.',
      'Wymiana jednej kryptowaluty na inną (także na stablecoin) nie jest liczona, ponieważ nie jest odpłatnym zbyciem waluty wirtualnej (art. 17 ust. 1f ustawy o PIT).',
      'Wartość przelewu = ilość × dzienny kurs rynkowy aktywa w USD × kurs średni USD/PLN z tabeli A NBP z ostatniego dnia roboczego poprzedzającego dzień przelewu (art. 11a ust. 1 ustawy o PIT). Dla stablecoinów USDT, USDC i DAI przyjęto 1 USD.',
      'Rok podatkowy ustalono według dnia przelewu w czasie polskim.',
      'Przelew do kantoru, bramki, karty lub usługi P2P oznaczono jako „zbycie prawdopodobne”. Wpłatę na giełdę oznaczono jako „zbycie możliwe”: środki mogły zostać sprzedane, ale też przechowane lub wymienione.',
      'Szacunek dotyczy potencjalnego przychodu, nie dochodu: nie uwzględnia kosztów nabycia. Jest wnioskiem do weryfikacji, a nie ustaleniem.',
    ],
  };
}

export const formatPln = (n: number) => `${Math.round(n).toLocaleString('pl-PL')} zł`;

/**
 * Draft of a request to the exchange for the identity of the customer behind a deposit address.
 * The exchange holds verified customer data; the request lists exactly the deposits that were observed.
 */
export function draftRequest(off: OffRamp, context: { caseTitle: string; runId: string; generatedAt: string }): string {
  const rows = off.deposits
    .map((d, i) => `${i + 1}. ${d.at.slice(0, 10)} ${d.at.slice(11, 16)} UTC — ${formatAmount(d.amount)} ${d.asset} — identyfikator transakcji: ${d.txHash}`)
    .join('\n');
  return [
    'PROJEKT — do weryfikacji i uzupełnienia przez osobę prowadzącą sprawę',
    '',
    `Adresat: ${off.exchange} (podmiot świadczący usługi wymiany kryptowalut)`,
    `Dotyczy: ustalenia klienta, któremu przypisano adres depozytowy ${off.depositAddress} (sieć: ${off.chain})`,
    'Podstawa prawna: [do uzupełnienia]',
    '',
    `W toku czynności analitycznych ustalono, że na wskazany adres depozytowy wpłynęły następujące środki:`,
    rows,
    '',
    `Podstawa ustalenia adresu: ${off.detail}`,
    '',
    'Prosimy o przekazanie:',
    '1. danych identyfikujących klienta, któremu przypisano wskazany adres depozytowy;',
    '2. historii wpłat na ten adres i sposobu ich wykorzystania (sprzedaż, wymiana, wypłata) w okresie objętym wykazem;',
    '3. historii wypłat środków w walutach tradycyjnych na rzecz tego klienta w tym samym okresie, wraz z numerami rachunków;',
    '4. innych adresów depozytowych przypisanych temu klientowi.',
    '',
    `Sprawa: ${context.caseTitle}. Analiza nr ${context.runId}, wygenerowano ${context.generatedAt.slice(0, 16).replace('T', ' ')} UTC.`,
    'Wykaz powstał automatycznie na podstawie publicznych danych z łańcucha bloków i wymaga sprawdzenia przed wysłaniem.',
  ].join('\n');
}

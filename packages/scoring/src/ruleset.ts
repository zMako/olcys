import type { LabelCategory } from '@olcys/core';
import type { BandId, ClusterLevel, Placement } from './types';

/**
 * The complete scoring method as data. Nothing about the score is hidden in code:
 * change a number here and every result, with its receipt, changes accordingly.
 * The ruleset is stored with each assessment, so any past result can be recomputed exactly.
 */
export interface Ruleset {
  id: string;
  version: string;
  name: string;
  /** Score bands, highest first. */
  bands: { id: BandId; label: string; min: number }[];
  /** Starting score by where the address was published. */
  placements: Record<Exclude<Placement, 'quoted'>, { rule: string; title: string; base: number }>;
  synergy: { rule: string; points: number; minOrigins: number };
  obfuscation: { rule: string; points: number };
  identityCaps: Record<Exclude<ClusterLevel, 'third_party'>, number>;
  /** A valid signed message that names the account sets the score to 100. One that does not name it adds `unboundPoints`, up to `unboundMax`. */
  proof: { unboundPoints: number; unboundMax: number };
  exclusions: {
    /** Label categories that can never be a person's private wallet. */
    labelCategories: LabelCategory[];
    /** Exclude addresses whose bytecode is a contract (delegated accounts and contract wallets are not excluded). */
    contractCode: boolean;
    /** Exclude an address published by at least this many unrelated accounts. */
    unrelatedPublishers: number;
  };
  massContext: { keywords: string[]; minPostsWithAddress: number; minShare: number };
  indicators: { stablecoins: string[]; significantStablecoinSwap: number };
  /** An unlabelled address counts as an exchange deposit address if it forwarded at least this share of what it received to the exchange. */
  offRamp: { minForwardShare: number };
  /** Limits of wallet expansion: transactions with more funding addresses than `maxInputs` are ignored (they may be shared transactions). */
  wallet: { maxInputs: number; maxAddresses: number; sharedMax: number };
  /** Matching publicly stated amounts to transfers: tolerances, time windows, and points per unique match. */
  amountMatch: { points: number; maxPoints: number; tolerancePln: number; toleranceCrypto: number; adWindowDays: number; postWindowDays: number };
  /** An exchange deposit address belongs to one customer. If more than this many other addresses pay into it, it is treated as shared and ignored. */
  depositReuse: { maxOtherSenders: number };
  /** A name whose records point at the account that published the address confirms the link from both sides: the score is raised to at least `mutualMin`. */
  names: { mutualMin: number };
  /** Only addresses scoring at least `minScore` enter the PLN estimate. */
  estimate: { minScore: number };
}

export const DEFAULT_RULESET: Ruleset = {
  id: 'olcys-kas',
  version: '1.0.0',
  name: 'Metoda KAS z kontrolą tożsamości',
  bands: [
    { id: 'very_high', label: 'BARDZO WYSOKIE', min: 80 },
    { id: 'probable', label: 'PRAWDOPODOBNE', min: 60 },
    { id: 'medium', label: 'ŚREDNIE', min: 40 },
    { id: 'noise', label: 'NISKIE / SZUM', min: 1 },
  ],
  placements: {
    own_profile: { rule: 'P1', title: 'Własny profil, strona lub repozytorium', base: 85 },
    sale: { rule: 'P2', title: 'Ogłoszenie sprzedaży lub rozliczenie', base: 65 },
    discussion: { rule: 'P3', title: 'Wpis w dyskusji na forum', base: 45 },
    mass_comment: { rule: 'P4', title: 'Masowe komentarze (konkurs, rozdawnictwo)', base: 20 },
  },
  synergy: { rule: 'S1', points: 15, minOrigins: 2 },
  obfuscation: { rule: 'O1', points: 3 },
  identityCaps: { entered: 100, publisher: 100, handle_variant: 79, name_unique: 59, name_ambiguous: 39 },
  proof: { unboundPoints: 30, unboundMax: 95 },
  exclusions: {
    labelCategories: ['exchange', 'exchange_deposit', 'p2p', 'payment_gateway', 'card', 'otc', 'dex', 'token', 'contract', 'mixer', 'charity', 'bridge'],
    contractCode: true,
    unrelatedPublishers: 3,
  },
  massContext: {
    keywords: ['konkurs', 'rozdaj', 'rozdawnictw', 'giveaway', 'airdrop', 'wpisz swoj adres', 'zostaw adres'],
    minPostsWithAddress: 5,
    minShare: 0.5,
  },
  indicators: { stablecoins: ['USDT', 'USDC', 'DAI'], significantStablecoinSwap: 2000 },
  offRamp: { minForwardShare: 0.9 },
  wallet: { maxInputs: 10, maxAddresses: 25, sharedMax: 90 },
  amountMatch: { points: 10, maxPoints: 20, tolerancePln: 0.06, toleranceCrypto: 0.005, adWindowDays: 45, postWindowDays: 4 },
  depositReuse: { maxOtherSenders: 3 },
  names: { mutualMin: 95 },
  estimate: { minScore: 60 },
};

export function bandOf(ruleset: Ruleset, score: number): { id: BandId; label: string } {
  for (const b of ruleset.bands) if (score >= b.min) return { id: b.id, label: b.label };
  return { id: 'noise', label: ruleset.bands[ruleset.bands.length - 1].label };
}

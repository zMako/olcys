/**
 * One thing established in a case, written as a sentence and numbered. The language model is given findings and
 * nothing else, and every sentence it writes must name the findings it rests on — so its text can be checked.
 */
export interface Finding {
  /** "U1", "U2", … within one run. */
  id: string;
  /** Source fact, computed result, or conclusion to verify: the three layers the report keeps apart. */
  layer: 'fact' | 'computed' | 'conclusion';
  text: string;
  /** Where the finding can be checked: a page, an explorer, an attestation. */
  source?: string;
}

/** Something that could still be done in the case. */
export interface Lead {
  /** "T1", "T2", … within one run. */
  id: string;
  kind: 'exchange_request' | 'attestation_request' | 'account' | 'unconfirmed' | 'address' | 'statement';
  text: string;
  /** Findings the lead comes from. */
  basis: string[];
}

/** What an account says about itself, for comparing two accounts. */
export interface ProfileCard {
  origin: string;
  service: string;
  handle: string;
  displayName?: string;
  /** The profile's own text (description, location, links). */
  profile: string;
  /** A few of the account's posts, shortened. */
  posts: string[];
}

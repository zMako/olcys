export type Chain = 'bitcoin' | 'ethereum' | 'tron';

/** 'valid' = checksum verified; 'absent' = format carries no checksum (e.g. all-lowercase EVM hex). */
export type ChecksumStatus = 'valid' | 'absent';

export interface ParsedAddress {
  chain: Chain;
  /** Canonical form used as the key everywhere (EIP-55 for EVM, lowercase for bech32). */
  address: string;
  /** p2pkh | p2sh | p2wpkh | p2wsh | p2tr | segwit_vN | evm | tron */
  type: string;
  checksum: ChecksumStatus;
}

/**
 * One address format. Adding a blockchain = adding one codec to the registry;
 * extraction, validation and split-address recovery pick it up automatically.
 */
export interface AddressCodec {
  id: string;
  chain: Chain;
  /** Validates a candidate and returns its canonical form, or null if it is not a real address. */
  parse(candidate: string): ParsedAddress | null;
  /** Rules for recovering an address that was split into chunks ("bc1q xy2k gdyg ..."). */
  join: {
    canStart(token: string): boolean;
    tokenOk(token: string): boolean;
    minLength: number;
    maxLength: number;
  };
}

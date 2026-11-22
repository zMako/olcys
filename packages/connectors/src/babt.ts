import { parseAddress, type AddressAttestation, type ConnectorContext } from '@olcys/core';
import { rpc } from './evm';

/**
 * Binance's "account-bound token" (BABT): a token on BNB Smart Chain that Binance issues to a customer who passed
 * its identity check, and that cannot be transferred. An address holding one belongs to a verified Binance customer.
 * Like Coinbase's attestation, it names nobody — it names the exchange that knows.
 *
 * Ethereum and BNB Smart Chain share the address format, so the check is made for the same address the person
 * uses on Ethereum. Any node of the chain answers it, including one run in-house.
 */
export const BABT_CONTRACT = '0x2B09d47D550061f995A3b5C6F0Fd58005215D7c8';
export const BSC_RPC = 'https://bsc-rpc.publicnode.com';

const BALANCE_OF = '0x70a08231'; // balanceOf(address)
const TOKEN_ID_OF = '0x773c02d4'; // tokenIdOf(address); reverts when the address holds no token
const pad = (address: string) => address.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** The two calls that answer "does this address hold the token, and which one". */
export function encodeBabtCalls(address: string): { method: string; params: unknown[] }[] {
  return [BALANCE_OF, TOKEN_ID_OF].map((fn) => ({ method: 'eth_call', params: [{ to: BABT_CONTRACT, data: fn + pad(address) }, 'latest'] }));
}

/** Reads the answers: a balance above zero means the token is held; the token id is its public serial number. */
export function decodeBabt(balance: string | undefined, tokenId: string | undefined): { holds: boolean; tokenId?: string } {
  const number = (hex: string | undefined) => (hex && /^0x[0-9a-f]+$/i.test(hex) ? BigInt(hex) : undefined);
  const holds = (number(balance) ?? 0n) > 0n;
  const id = holds ? number(tokenId) : undefined;
  return { holds, tokenId: id === undefined ? undefined : id.toString() };
}

export const babtHolderUrl = (address: string) => `https://bscscan.com/token/${BABT_CONTRACT}?a=${address}`;

/** The attestation a held token amounts to. */
export function babtAttestation(address: string, tokenId?: string): AddressAttestation {
  return { chain: 'ethereum', address, issuer: 'Binance', claim: 'verified_account', uid: tokenId ? `BABT-${tokenId}` : `BABT:${address.toLowerCase()}`, sourceUrl: babtHolderUrl(address) };
}

/** Asks a BNB Smart Chain node whether the address holds Binance's account-bound token. One request. */
export async function binanceAttestations(rpcUrl: string, address: string, ctx: ConnectorContext): Promise<AddressAttestation[]> {
  const parsed = parseAddress(address);
  if (!parsed || parsed.chain !== 'ethereum') return [];
  const [balance, tokenId] = await rpc(ctx, rpcUrl, encodeBabtCalls(parsed.address));
  const { holds, tokenId: id } = decodeBabt(balance?.result, tokenId?.result);
  return holds ? [babtAttestation(parsed.address, id)] : [];
}

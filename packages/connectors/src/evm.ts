import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { createAlchemyTransfers } from './alchemy';
import { binanceAttestations } from './babt';
import { describeAttestation, walletAttestations } from './eas';
import { createBlockscout } from './blockscout';
import { classifyCode, parseAddress, toEip55, type AccountInfo, type AddressAttestation, type Chain, type ChainConnector, type ConnectorContext, type Deployment, type NameRecord, type NameService, type Transfer } from '@olcys/core';

interface RpcResult {
  result?: string;
  error?: { message: string };
  snapshotId: string;
}

/** One JSON-RPC batch to a node, through the engine's network exit. */
export async function rpc(ctx: ConnectorContext, url: string, calls: { method: string; params: unknown[] }[], headers: Record<string, string> = {}): Promise<RpcResult[]> {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, ...c })));
  const res = await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  if (res.status !== 200) throw new Error(`Node answered ${res.status}`);
  const parsed = JSON.parse(res.body) as { id: number; result?: string; error?: { message: string } }[];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return calls.map((_, i) => ({ ...(list.find((x) => x.id === i + 1) ?? { error: { message: 'no answer' } }), snapshotId: res.snapshotId }));
}

/**
 * Ethereum through a node's standard JSON-RPC: whether an address carries code (contract, delegation, plain
 * account), how many transactions it sent, and its balance. Works with any node, including one run in-house.
 * A node does not index transfers, so the history of an address needs an indexer on top.
 */
/** Coinbase's attesting address on Base, and how its attestation types are named. */
export const COINBASE_ATTESTER = '0x357458739F90461b99789350868CD7CF330Dd7EE';
const CLAIMS: Record<string, string> = { 'Verified Account': 'verified_account', 'Verified Country': 'verified_country' };

/** Reads Coinbase's public attestations about one address from an Ethereum Attestation Service index. */
export async function coinbaseAttestations(endpoint: string, address: string, ctx: ConnectorContext): Promise<AddressAttestation[]> {
  const query = `{ attestations(take: 20, where: { recipient: { equals: "${address}", mode: insensitive }, attester: { equals: "${COINBASE_ATTESTER}" }, revoked: { equals: false } }) { id time decodedDataJson schema { schemaNames { name } } } }`;
  const res = await ctx.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  if (res.status !== 200) return [];
  const list = ((JSON.parse(res.body) as { data?: { attestations?: { id: string; time: number; decodedDataJson: string; schema?: { schemaNames?: { name: string }[] } }[] } }).data?.attestations ?? []);
  const out: AddressAttestation[] = [];
  for (const a of list) {
    const claim = CLAIMS[a.schema?.schemaNames?.[0]?.name ?? ''];
    if (!claim) continue;
    let value: string | undefined;
    try {
      const v = (JSON.parse(a.decodedDataJson) as { value?: { value?: unknown } }[])[0]?.value?.value;
      if (claim === 'verified_country' && typeof v === 'string' && /^[A-Z]{2}$/.test(v)) value = v;
    } catch {
      // an attestation we cannot decode is still an attestation
    }
    out.push({ chain: 'ethereum', address, issuer: 'Coinbase', claim, value, uid: a.id, at: new Date(a.time * 1000).toISOString(), sourceUrl: `${new URL(endpoint).origin}/attestation/view/${a.id}` });
  }
  return out;
}

export interface EvmOptions {
  indexer?: string;
  labels?: string;
  /** Attestation index (Ethereum Attestation Service on Base). */
  attestations?: string;
  /** A node of BNB Smart Chain, to check Binance's account-bound token. */
  bscRpc?: string;
  /** Key for transfer history on Base. */
  baseKey?: string;
  /** Attestations from data kept on this machine (e.g. attendance tokens of events in Poland). */
  localAttestations?(address: string): AddressAttestation[];
}

export function createEvmRpcConnector(rpcUrl: string, opts: EvmOptions = {}): ChainConnector {
  // A node cannot say who created a contract or list an address's transfers; an indexer with a Blockscout-style API can.
  const indexer = opts.indexer?.replace(/\/+$/, '');
  const scout = indexer ? createBlockscout({ indexer, labels: opts.labels }) : undefined;
  // The same addresses live on the Base network too. Its history comes from a second source; its labels from the same label service.
  const base = opts.baseKey ? createAlchemyTransfers({ key: opts.baseKey }) : undefined;
  const baseLabels = base && indexer && opts.labels ? createBlockscout({ indexer, labels: opts.labels, chainId: 8453 }) : undefined;
  return {
    id: 'evm-rpc',
    descriptor: { name: `Węzeł Ethereum (${new URL(rpcUrl).host})${indexer ? ` i indekser (${new URL(indexer).host})` : ''}`, chains: ['ethereum'], hosts: [new URL(rpcUrl).host, ...(scout?.hosts ?? []), ...(opts.attestations ? [new URL(opts.attestations).host] : []), ...(base ? [base.host] : []), ...(opts.bscRpc ? [new URL(opts.bscRpc).host] : [])], synthetic: false },
    supports: (chain) => chain === 'ethereum',
    async getAccount(chain, address, ctx): Promise<AccountInfo> {
      const [code, nonce, balance] = await rpc(ctx, rpcUrl, [
        { method: 'eth_getCode', params: [address, 'latest'] },
        { method: 'eth_getTransactionCount', params: [address, 'latest'] },
        { method: 'eth_getBalance', params: [address, 'latest'] },
      ]);
      if (code.result === undefined) throw new Error(code.error?.message ?? 'node error');
      // The same address may be a plain account on the main network and a contract on Base (or the other way round).
      const baseCode = base ? (await rpc(ctx, base.url, [{ method: 'eth_getCode', params: [address, 'latest'] }], base.headers).catch(() => [] as RpcResult[]))[0]?.result : undefined;
      const here = classifyCode(code.result);
      const there = baseCode ? classifyCode(baseCode) : undefined;
      const eth = Number(BigInt(balance.result ?? '0x0')) / 1e18;
      return {
        chain, address, ...(here.kind !== 'contract' && there?.kind === 'contract' ? there : here), code: code.result, labels: [...(scout ? await scout.labelsOf(address, ctx) : []), ...(baseLabels ? await baseLabels.labelsOf(address, ctx) : [])].filter((l, i, all) => all.findIndex((x) => x.name === l.name) === i), txCount: Number(BigInt(nonce.result ?? '0x0')),
        balances: eth > 0 ? [{ asset: 'ETH', amount: Math.round(eth * 1e6) / 1e6 }] : [], snapshotId: code.snapshotId, sourceUrl: rpcUrl,
      };
    },
    async getTransfers(_chain, address, ctx): Promise<Transfer[]> {
      const [main, onBase] = await Promise.all([
        scout ? scout.transfers(address, ctx) : [],
        // If Base cannot be read, the main network's history still stands; the gap is written to the run's log.
        base ? base.transfers(address, ctx).catch((err) => (ctx.log(err instanceof Error ? err.message : String(err)), [] as Transfer[])) : [],
      ]);
      if (baseLabels && onBase.length) await baseLabels.labelMany([...new Set(onBase.flatMap((t) => [t.from, t.to]))].filter((a) => a !== address), ctx);
      return [...main, ...onBase].sort((a, b) => a.at.localeCompare(b.at));
    },
    async getLabelled(_chain, addresses, ctx): Promise<string[]> {
      await Promise.all([scout?.labelMany(addresses, ctx), baseLabels?.labelMany(addresses, ctx)]);
      const out: string[] = [];
      for (const a of addresses) if ((scout && (await scout.labelsOf(a, ctx)).length) || (baseLabels && (await baseLabels.labelsOf(a, ctx)).length)) out.push(a);
      return out;
    },
    ...(opts.attestations || opts.bscRpc || opts.localAttestations
      ? {
          // Everything institutions publicly state about the address: exchanges that verified its owner, identity
          // services, event organisers. Each source is asked on its own; one that fails does not cost the others.
          async getAttestations(_chain: Chain, address: string, ctx: ConnectorContext): Promise<AddressAttestation[]> {
            const [eas, babt] = await Promise.all([
              opts.attestations ? walletAttestations(opts.attestations, address, ctx).catch((err) => (ctx.log(`poświadczenia adresu ${address}: ${err instanceof Error ? err.message : err}`), [] as AddressAttestation[])) : [],
              opts.bscRpc ? binanceAttestations(opts.bscRpc, address, ctx).catch((err) => (ctx.log(`token Binance adresu ${address}: ${err instanceof Error ? err.message : err}`), [] as AddressAttestation[])) : [],
            ]);
            return [...[...eas, ...babt].map((a): AddressAttestation => ({ ...a, note: a.note ?? describeAttestation(a) })), ...(opts.localAttestations?.(address) ?? [])];
          },
        }
      : {}),
    ...(indexer
      ? {
          async getCreator(chain: Chain, contract: string, ctx: ConnectorContext): Promise<Deployment | undefined> {
            const url = `${indexer}/api/v2/addresses/${contract}`;
            const res = await ctx.fetch(url);
            if (res.status !== 200) return undefined;
            const a = JSON.parse(res.body) as { creator_address_hash?: string | null; creation_transaction_hash?: string | null; creation_tx_hash?: string | null };
            const creator = a.creator_address_hash ? parseAddress(a.creator_address_hash) : null;
            if (!creator) return undefined;
            return { chain, contract, creator: creator.address, txHash: a.creation_transaction_hash ?? a.creation_tx_hash ?? undefined, sourceUrl: url, snapshotId: res.snapshotId };
          },
        }
      : {}),
  };
}

// ----------------------------------------------------------------------------- ENS

const hex = (b: Uint8Array) => bytesToHex(b);
/** First four bytes of the hash of a function signature: how a contract call names the function. */
export const selector = (signature: string) => hex(keccak_256(utf8ToBytes(signature))).slice(0, 8);
/** ENS namehash (EIP-137): the identifier of a name inside the registry. */
export function namehash(name: string): string {
  let node: Uint8Array = new Uint8Array(32);
  for (const label of name.toLowerCase().split('.').filter(Boolean).reverse()) {
    const both = new Uint8Array(64);
    both.set(node, 0);
    both.set(keccak_256(utf8ToBytes(label)), 32);
    node = keccak_256(both);
  }
  return hex(node);
}
const word = (n: number) => n.toString(16).padStart(64, '0');
const encodeString = (s: string) => {
  const bytes = hex(utf8ToBytes(s));
  return word(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
};
/** Decodes an ABI-encoded string return value. */
export function decodeString(result: string | undefined): string {
  const data = (result ?? '').replace(/^0x/, '');
  if (data.length < 128) return '';
  const offset = parseInt(data.slice(0, 64), 16) * 2;
  const length = parseInt(data.slice(offset, offset + 64), 16) * 2;
  if (!Number.isFinite(length) || length > 4096) return '';
  return new TextDecoder().decode(hexToBytes(data.slice(offset + 64, offset + 64 + length)));
}
const addressOf = (result: string | undefined): string | undefined => {
  const data = (result ?? '').replace(/^0x/, '');
  return data.length >= 64 && !/^0+$/.test(data.slice(24, 64)) ? toEip55(data.slice(24, 64)) : undefined;
};

/** The ENS registry: one contract that says which resolver answers for a name. */
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const RECORD_KEYS = ['com.github', 'com.twitter', 'org.telegram', 'email', 'url', 'description'];

/**
 * Ethereum Name Service, read with plain contract calls on any node. A name's text records are written by
 * whoever controls it, so "com.github: someone" is the address owner pointing at an account.
 */
export function createEnsNameService(rpcUrl: string): NameService {
  const call = (to: string, data: string) => ({ method: 'eth_call', params: [{ to, data: `0x${data}` }, 'latest'] });
  const resolverOf = async (ctx: ConnectorContext, node: string) => addressOf((await rpc(ctx, rpcUrl, [call(ENS_REGISTRY, selector('resolver(bytes32)') + node)]))[0].result);

  const resolve = async (name: string, ctx: ConnectorContext): Promise<NameRecord | undefined> => {
    const node = namehash(name);
    const resolver = await resolverOf(ctx, node);
    if (!resolver) return undefined;
    const answers = await rpc(ctx, rpcUrl, [
      call(resolver, selector('addr(bytes32)') + node),
      ...RECORD_KEYS.map((k) => call(resolver, selector('text(bytes32,string)') + node + word(64) + encodeString(k))),
    ]);
    const address = addressOf(answers[0].result);
    if (!address) return undefined;
    const records: Record<string, string> = {};
    RECORD_KEYS.forEach((k, i) => {
      const v = decodeString(answers[i + 1].result).trim();
      if (v) records[k] = v;
    });
    return { name: name.toLowerCase(), chain: 'ethereum', address, records, snapshotId: answers[0].snapshotId, sourceUrl: rpcUrl };
  };

  return {
    id: 'ens',
    descriptor: { name: 'Ethereum Name Service (ENS)', hosts: [new URL(rpcUrl).host], synthetic: false },
    resolve,
    async reverse(chain, address, ctx) {
      if (chain !== 'ethereum') return undefined;
      const node = namehash(`${address.slice(2).toLowerCase()}.addr.reverse`);
      const resolver = await resolverOf(ctx, node);
      if (!resolver) return undefined;
      const name = decodeString((await rpc(ctx, rpcUrl, [call(resolver, selector('name(bytes32)') + node)]))[0].result).trim();
      if (!name) return undefined;
      // Anyone can claim any name in a reverse record; it counts only if the name points back at the address.
      const forward = await resolve(name, ctx);
      return forward && forward.address === address ? forward : undefined;
    },
  };
}

/** The synthetic environment's name service: same questions, answered by its explorer. */
export function createWorldNameService(base: string): NameService {
  const root = base.replace(/\/+$/, '');
  const get = async (ctx: ConnectorContext, url: string): Promise<NameRecord | undefined> => {
    const res = await ctx.fetch(url);
    if (res.status !== 200) return undefined;
    const r = JSON.parse(res.body) as { name: string; address: string; records: Record<string, string> };
    return { name: r.name, chain: 'ethereum', address: r.address, records: r.records, snapshotId: res.snapshotId, sourceUrl: url };
  };
  return {
    id: 'world-names',
    descriptor: { name: 'Nazwy adresów (środowisko testowe)', hosts: [new URL(root).host], synthetic: true },
    resolve: (name, ctx) => get(ctx, `${root}/api/v1/name/${encodeURIComponent(name.toLowerCase())}`),
    reverse: (chain, address, ctx) => (chain === 'ethereum' ? get(ctx, `${root}/api/v1/address/${address}/name`) : Promise.resolve(undefined)),
  };
}

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { classifyCode, toEip55, type AccountInfo, type ChainConnector, type ConnectorContext, type NameRecord, type NameService, type Transfer } from '@olcys/core';

interface RpcResult {
  result?: string;
  error?: { message: string };
  snapshotId: string;
}

/** One JSON-RPC batch to a node, through the engine's network exit. */
async function rpc(ctx: ConnectorContext, url: string, calls: { method: string; params: unknown[] }[]): Promise<RpcResult[]> {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, ...c })));
  const res = await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
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
export function createEvmRpcConnector(rpcUrl: string): ChainConnector {
  return {
    id: 'evm-rpc',
    descriptor: { name: `Węzeł Ethereum (${new URL(rpcUrl).host})`, chains: ['ethereum'], hosts: [new URL(rpcUrl).host], synthetic: false },
    supports: (chain) => chain === 'ethereum',
    async getAccount(chain, address, ctx): Promise<AccountInfo> {
      const [code, nonce, balance] = await rpc(ctx, rpcUrl, [
        { method: 'eth_getCode', params: [address, 'latest'] },
        { method: 'eth_getTransactionCount', params: [address, 'latest'] },
        { method: 'eth_getBalance', params: [address, 'latest'] },
      ]);
      if (code.result === undefined) throw new Error(code.error?.message ?? 'node error');
      const eth = Number(BigInt(balance.result ?? '0x0')) / 1e18;
      return {
        chain, address, ...classifyCode(code.result), code: code.result, labels: [], txCount: Number(BigInt(nonce.result ?? '0x0')),
        balances: eth > 0 ? [{ asset: 'ETH', amount: Math.round(eth * 1e6) / 1e6 }] : [], snapshotId: code.snapshotId, sourceUrl: rpcUrl,
      };
    },
    async getTransfers(): Promise<Transfer[]> {
      return [];
    },
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

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { parseAddress, type ConnectorContext, type NameRecord, type NameService } from '@olcys/core';
import { decodeString, namehash, rpc, selector } from './evm';

/**
 * Base names ("ania.base.eth"): the name service of the Base network. The owner of a wallet registers a name,
 * points it at the wallet, and may attach records — a handle on X, on Farcaster, on GitHub, a website.
 * Everything is written by whoever holds the wallet's key.
 */
export const BASENAME_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD';
export const BASENAME_KEYS = ['com.twitter', 'xyz.farcaster', 'com.github', 'url', 'description', 'email', 'org.telegram'];

/** The key under which the Base resolver keeps "the name this address chose for itself". */
export function baseReverseNode(address: string): string {
  const both = new Uint8Array(64);
  both.set(hexToBytes(namehash('80002105.reverse')), 0); // 0x80000000 | 8453: the Base network in the name system's numbering
  both.set(keccak_256(utf8ToBytes(address.toLowerCase().replace(/^0x/, ''))), 32);
  return bytesToHex(keccak_256(both));
}
const word = (n: number) => n.toString(16).padStart(64, '0');
export const encodeTextCall = (node: string, key: string): string => {
  const bytes = bytesToHex(utf8ToBytes(key));
  return selector('text(bytes32,string)') + node + word(64) + word(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
};

export function createBasenameService(rpcUrl = 'https://mainnet.base.org'): NameService {
  const call = (data: string) => ({ method: 'eth_call', params: [{ to: BASENAME_RESOLVER, data: `0x${data}` }, 'latest'] });
  const records = async (ctx: ConnectorContext, name: string): Promise<{ records: Record<string, string>; snapshotId: string }> => {
    const node = namehash(name);
    const res = await rpc(ctx, rpcUrl, BASENAME_KEYS.map((k) => call(encodeTextCall(node, k))));
    const out: Record<string, string> = {};
    BASENAME_KEYS.forEach((k, i) => {
      const v = res[i].result ? decodeString(res[i].result).trim() : '';
      if (v) out[k] = v.slice(0, 300);
    });
    return { records: out, snapshotId: res[0]?.snapshotId ?? '' };
  };
  const resolve = async (name: string, ctx: ConnectorContext): Promise<NameRecord | undefined> => {
    if (!/\.base\.eth$/i.test(name)) return undefined;
    const [res] = await rpc(ctx, rpcUrl, [call(selector('addr(bytes32)') + namehash(name))]);
    const address = res.result && /^0x0{24}[0-9a-f]{40}$/i.test(res.result) && !/^0x0+$/.test(res.result) ? parseAddress(`0x${res.result.slice(-40)}`)?.address : undefined;
    if (!address) return undefined;
    const r = await records(ctx, name);
    return { name: name.toLowerCase(), chain: 'ethereum', address, records: r.records, sourceUrl: `https://www.base.org/name/${name.toLowerCase().replace(/\.base\.eth$/, '')}`, snapshotId: res.snapshotId };
  };
  return {
    id: 'basenames',
    descriptor: { name: 'Nazwy Base', hosts: [new URL(rpcUrl).host], synthetic: false },
    resolve,
    /** The name an address chose for itself — accepted only if the name points back at the address. */
    async reverse(_chain, address, ctx) {
      const [res] = await rpc(ctx, rpcUrl, [call(selector('name(bytes32)') + baseReverseNode(address))]);
      const name = res.result ? decodeString(res.result) : '';
      if (!name || !/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u.test(name)) return undefined;
      const forward = await resolve(name, ctx);
      return forward && forward.address.toLowerCase() === address.toLowerCase() ? forward : undefined;
    },
  };
}

/** Several name services as one: a name goes to the first that knows it; an address is asked about in turn. */
export function combineNameServices(...services: NameService[]): NameService {
  return {
    id: services.map((s) => s.id).join('+'),
    descriptor: { name: services.map((s) => s.descriptor.name).join(', '), hosts: [...new Set(services.flatMap((s) => s.descriptor.hosts))], synthetic: services.every((s) => s.descriptor.synthetic) },
    async resolve(name, ctx) {
      for (const s of services) {
        const r = await s.resolve(name, ctx).catch(() => undefined);
        if (r) return r;
      }
      return undefined;
    },
    async reverse(chain, address, ctx) {
      for (const s of services) {
        const r = await s.reverse(chain, address, ctx).catch(() => undefined);
        if (r) return r;
      }
      return undefined;
    },
  };
}

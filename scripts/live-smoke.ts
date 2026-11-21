// Checks the real connectors against the live services, through the engine's own network exit.
// Uses only well-known public institutional addresses and names. Usage: npx tsx scripts/live-smoke.ts
import {
  createCoinbasePriceConnector, createEnsNameService, createEsploraConnector, createEvmRpcConnector, createGithubConnector,
  createNbpConnector, createWaybackConnector,
} from '@olcys/connectors';
import { BUNDLED_LABELS, makeIdentifier, type ConnectorContext, type FetchInit } from '@olcys/core';
import { Store, migrate, openDatabase } from '@olcys/db';
import { createEgress } from '@olcys/engine';

const btcApi = process.env.BITCOIN_API_URL ?? 'https://mempool.space/api';
const ethRpc = process.env.ETH_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const github = createGithubConnector({ token: process.env.GITHUB_TOKEN });
const esplora = createEsploraConnector(btcApi, 1);
const evm = createEvmRpcConnector(ethRpc);
const ens = createEnsNameService(ethRpc);
const nbp = createNbpConnector('https://api.nbp.pl');
const wayback = createWaybackConnector();
const prices = createCoinbasePriceConnector();

const db = await openDatabase('pglite://memory');
await migrate(db);
const store = new Store(db);
const c = await store.createCase('smoke', [makeIdentifier('username', 'smoke')]);
const run = await store.createRun(c.id, 'smoke', {});
const allowlist = [github, esplora, evm, ens, nbp, wayback, prices].flatMap((x) => x.descriptor.hosts);
const egress = createEgress({ store, runId: run.id, allowlist });
const ctx = (id: string): ConnectorContext => ({ fetch: (url: string, init?: FetchInit) => egress.text(id, url, init), log: (m) => console.log(`   [${id}] ${m}`) });

let failed = 0;
const check = async (name: string, fn: () => Promise<unknown>) => {
  try {
    console.log(`ok   ${name}: ${JSON.stringify(await fn())}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
};

const binanceCold = BUNDLED_LABELS[1].address;
const usdt = BUNDLED_LABELS[3].address;
const binanceHot = BUNDLED_LABELS[0].address;

await check(`Bitcoin explorer ${new URL(btcApi).host}: account`, async () => {
  const a = await esplora.getAccount('bitcoin', binanceCold, ctx('esplora'));
  if (a.txCount < 100) throw new Error('unexpected transaction count');
  return { txCount: a.txCount, balance: a.balances[0]?.amount };
});
await check('Bitcoin explorer: transfers with co-inputs', async () => {
  const t = await esplora.getTransfers('bitcoin', binanceCold, ctx('esplora'));
  if (!t.length) throw new Error('no transfers');
  return { transfers: t.length, last: t.at(-1)!.at, withCoInputs: t.filter((x) => x.coInputs?.length).length };
});
await check('Ethereum node: contract vs plain account', async () => {
  const [token, wallet] = [await evm.getAccount('ethereum', usdt, ctx('evm-rpc')), await evm.getAccount('ethereum', binanceHot, ctx('evm-rpc'))];
  if (token.kind !== 'contract' || wallet.kind !== 'eoa') throw new Error(`got ${token.kind} / ${wallet.kind}`);
  return { usdt: token.kind, binanceHot: wallet.kind, sent: wallet.txCount };
});
await check('ENS: name to address, records, and back', async () => {
  const r = await ens.resolve('vitalik.eth', ctx('ens'));
  if (r?.address !== '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045') throw new Error(`resolved to ${r?.address}`);
  const back = await ens.reverse('ethereum', r.address, ctx('ens'));
  return { address: r.address, records: Object.keys(r.records), reverse: back?.name };
});
await check('NBP: table before 2025-04-22 (after Easter Monday)', async () => {
  const q = await nbp.usdPlnBefore('2025-04-22', ctx('nbp'));
  if (q?.effectiveDate !== '2025-04-18') throw new Error(`got ${q?.effectiveDate}`);
  return { mid: q.mid, table: q.table };
});
await check('Coinbase: BTC close on 2025-07-08', async () => (await prices.usdPrice('BTC', '2025-07-08', ctx('coinbase-prices')))?.usd ?? Promise.reject(new Error('no price')));
await check('Wayback Machine: captures of github.com/github', async () => {
  const caps = await wayback.captures('https://github.com/github', ctx('wayback'));
  if (!caps.length) throw new Error('no captures');
  return { captures: caps.length, first: caps[0].at.slice(0, 10) };
});
await check('GitHub: organisation profile (needs quota or GITHUB_TOKEN)', async () => {
  const items = [];
  for await (const i of github.search(makeIdentifier('username', 'github'), ctx('github'))) items.push(i.resourceId);
  if (!items.length) throw new Error('no answer — rate limit exhausted for this IP address; set GITHUB_TOKEN');
  return items.slice(0, 3);
});
await check('Network exit: refuses a host that is not approved', async () => {
  try {
    await egress.text('test', 'https://example.org/');
  } catch (err) {
    return (err as Error).message.slice(0, 60);
  }
  throw new Error('request was allowed');
});

const v = await store.verifyEvidence(run.id);
console.log(`\nEvidence: ${v.checked} live responses stored, chain ${v.ok ? 'intact' : 'BROKEN'}. ${failed ? `${failed} check(s) failed.` : 'All checks passed.'}`);
await db.close();
process.exit(failed ? 1 : 0);

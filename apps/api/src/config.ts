import { existsSync } from 'node:fs';
import { attendanceLookup, createCorpusConnector } from '@olcys/corpus';
import { z } from 'zod';
import {
  combineNameServices, createBasenameService, createCoinbasePriceConnector, createEnsNameService, createEsploraConnector, createEvmRpcConnector, createBlueskyConnector, createFarcasterConnector, createGithubConnector, createKeybaseConnector, createLensConnector, createTelegramConnector, createNbpConnector,
  createWaybackConnector, createWorldArchiveConnector, createWorldChainConnector, createWorldConnectors, createWorldNameService, createWorldPriceConnector,
} from '@olcys/connectors';
import type { ArchiveConnector, ChainConnector, NameService, PriceConnector, RatesConnector, SourceConnector } from '@olcys/core';
import { migrate, openDatabase, Store } from '@olcys/db';

const Env = z.object({
  DATABASE_URL: z.string().default('pglite://./.data/pglite'),
  /** Which sources a run uses unless the request says otherwise. */
  SOURCES: z.enum(['synthetic', 'live']).default('synthetic'),
  // --- synthetic environment
  WORLD_FORUM_URL: z.string().url().default('http://localhost:4101'),
  WORLD_CODE_URL: z.string().url().default('http://localhost:4102'),
  WORLD_ADS_URL: z.string().url().default('http://localhost:4103'),
  WORLD_EXPLORER_URL: z.string().url().default('http://localhost:4104'),
  // Official rates: the offline copy by default; set to https://api.nbp.pl to read them from the National Bank of Poland.
  NBP_API_URL: z.string().url().default('http://localhost:4105'),
  PRICES_URL: z.string().url().default('http://localhost:4105'),
  ARCHIVE_URL: z.string().url().default('http://localhost:4106'),
  // --- live sources
  GITHUB_TOKEN: z.string().optional(),
  BITCOIN_API_URL: z.string().url().default('https://mempool.space/api'),
  ETH_RPC_URL: z.string().url().default('https://ethereum-rpc.publicnode.com'),
  /** Indexer with a Blockscout-style API: transfer history of an address, and which address created a contract. */
  ETH_INDEXER_URL: z.string().url().default('https://eth.blockscout.com'),
  /** Public labels of addresses (exchanges, routers, bridges), in the indexer's label-service format. */
  ETH_LABELS_URL: z.string().url().default('https://metadata.services.blockscout.com'),
  /** Index of public attestations on Base (Ethereum Attestation Service): tells when an exchange vouches for an address's owner. */
  /** A node of the Base network: names of wallets there, with the records their owners attached. */
  BASE_RPC_URL: z.string().url().default('https://mainnet.base.org'),
  /** Key for transfer history on the Base network (Alchemy). Without it, Base activity is not analysed. */
  ALCHEMY_KEY: z.string().optional(),
  /** A node of BNB Smart Chain: Binance marks verified customers' addresses there with a non-transferable token. */
  BSC_RPC_URL: z.string().url().default('https://bsc-rpc.publicnode.com'),
  ATTESTATIONS_URL: z.string().url().default('https://base.easscan.org/graphql'),
  LIVE_NBP_API_URL: z.string().url().default('https://api.nbp.pl'),
  EGRESS_ALLOWLIST: z.string().default(''),
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default('127.0.0.1'),
});

export type SourceMode = 'synthetic' | 'live';

/** Everything a run reads from, and the hosts it is allowed to contact for that. */
export interface SourceSet {
  connectors: SourceConnector[];
  chain: ChainConnector[];
  rates: RatesConnector;
  prices: PriceConnector;
  archive: ArchiveConnector;
  names: NameService;
  allowlist: string[];
}

export interface Runtime {
  store: Store;
  sets: Record<SourceMode, SourceSet>;
  defaultMode: SourceMode;
  port: number;
  host: string;
  close(): Promise<void>;
}

// Settings may sit in a local .env file (never committed); real environment variables win over it.
try {
  process.loadEnvFile('.env');
} catch {
  // no file: the environment alone decides
}

export async function loadRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const cfg = Env.parse(env);
  const db = await openDatabase(cfg.DATABASE_URL);
  await migrate(db);
  // Default policy: only the hosts of the configured connectors. An explicit list replaces it.
  const explicit = cfg.EGRESS_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
  const withAllowlist = (s: Omit<SourceSet, 'allowlist'>): SourceSet => ({
    ...s,
    allowlist: explicit.length ? explicit : [...new Set([...s.connectors, ...s.chain, s.rates, s.prices, s.archive, s.names].flatMap((c) => c.descriptor.hosts))],
  });

  const synthetic = withAllowlist({
    connectors: createWorldConnectors({ forum: cfg.WORLD_FORUM_URL, code: cfg.WORLD_CODE_URL, ads: cfg.WORLD_ADS_URL }),
    chain: [createWorldChainConnector(cfg.WORLD_EXPLORER_URL)],
    rates: createNbpConnector(cfg.NBP_API_URL, !/(^|\.)nbp\.pl$/.test(new URL(cfg.NBP_API_URL).hostname)),
    prices: createWorldPriceConnector(cfg.PRICES_URL),
    archive: createWorldArchiveConnector(cfg.ARCHIVE_URL),
    names: createWorldNameService(cfg.WORLD_EXPLORER_URL),
  });
  const corpusDir = process.env.CORPUS_DIR ?? '.corpus';
  // The public internet: GitHub, Farcaster, Keybase, Bluesky, Lens, Telegram's public profile page, a Bitcoin explorer, an Ethereum node with ENS, NBP, the Wayback Machine.
  const live = withAllowlist({
    connectors: [
      createGithubConnector({ token: cfg.GITHUB_TOKEN }), createFarcasterConnector(), createKeybaseConnector(),
      // A targeted pass on one handle: the public profile of that account, nothing broader.
      createBlueskyConnector(), createLensConnector(), createTelegramConnector(),
      // The locally built index answers "which account claimed this address?", which no public service does.
      ...(existsSync(`${corpusDir}/farcaster/profiles.jsonl`) ? [createCorpusConnector(corpusDir)] : []),
    ],
    chain: [createEsploraConnector(cfg.BITCOIN_API_URL), createEvmRpcConnector(cfg.ETH_RPC_URL, { indexer: cfg.ETH_INDEXER_URL, labels: cfg.ETH_LABELS_URL, attestations: cfg.ATTESTATIONS_URL, baseKey: cfg.ALCHEMY_KEY, bscRpc: cfg.BSC_RPC_URL, localAttestations: existsSync(`${corpusDir}/poap/holders.jsonl`) ? attendanceLookup(corpusDir) : undefined })],
    rates: createNbpConnector(cfg.LIVE_NBP_API_URL),
    prices: createCoinbasePriceConnector(),
    archive: createWaybackConnector(),
    names: combineNameServices(createEnsNameService(cfg.ETH_RPC_URL), createBasenameService(cfg.BASE_RPC_URL)),
  });
  return { store: new Store(db), sets: { synthetic, live }, defaultMode: cfg.SOURCES, port: cfg.API_PORT, host: cfg.API_HOST, close: () => db.close() };
}

import { guessIdentifier, makeIdentifier, type Identifier, type IdentifierKind } from '@olcys/core';
import { diffRuns, runAnalysis, type RunSummary } from '@olcys/engine';
import { loadRuntime } from './config';

const KINDS: Record<string, IdentifierKind> = {
  name: 'full_name', username: 'username', nick: 'username', email: 'email', phone: 'phone',
  messenger: 'messenger_id', url: 'profile_url', address: 'crypto_address',
};

function parseArgs(argv: string[]) {
  const identifiers: Identifier[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) identifiers.push(guessIdentifier(a));
    else if (KINDS[a.slice(2)]) identifiers.push(makeIdentifier(KINDS[a.slice(2)], argv[++i] ?? ''));
    else if (['json', 'verbose', 'live'].includes(a.slice(2))) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i] ?? '';
  }
  return { identifiers, flags };
}

function print(s: RunSummary) {
  console.log(`\nRun ${s.runId} — ${s.status}${s.error ? `: ${s.error}` : ''}`);
  console.log(`Fetched ${s.counts.snapshots} resources (${s.counts.denied} refused by the egress policy), parsed ${s.counts.documents} documents.`);
  console.log(`\nIdentifiers searched (${s.identifiers.length}):`);
  for (const i of s.identifiers) console.log(`  ${'  '.repeat(i.depth)}${i.kind.padEnd(15)} ${i.value}${i.origin === 'seed' ? '   ← entered' : ''}`);
  console.log(`\nAddresses found: ${s.addresses.length} unique, ${s.counts.mentions} occurrences.`);

  const a = s.assessment;
  if (!a) return;
  console.log(`\nRuleset: ${a.ruleset.name} v${a.ruleset.version}`);
  for (const c of a.clusters) {
    console.log(`\n━━ ${c.id}  ${c.level}  (identity cap ${c.identityCap}%)  ${c.accounts.map((x) => `${x.handle}@${x.origin}`).join(', ')}`);
    for (const j of c.joins) console.log(`     ${j.rule}  ${j.detail}`);
    for (const l of a.links.filter((x) => x.clusterId === c.id)) {
      console.log(`\n  ${String(l.score).padStart(3)}%  ${l.bandLabel.padEnd(18)} ${l.chain.toUpperCase()} ${l.address}`);
      for (const r of l.receipt) {
        const pts = r.points === null ? '   ' : r.effect === 'bonus' ? `+${r.points}`.padStart(3) : String(r.points).padStart(3);
        console.log(`        ${r.rule.padEnd(3)} ${pts} → ${String(r.total).padStart(3)}  ${r.title}: ${r.detail}`);
      }
      const act = s.chain.activity.find((x) => x.address === l.address);
      for (const i of act?.indicators ?? []) console.log(`        ${i.rule.padEnd(3)} ${i.cashOut ? 'CASH-OUT?' : 'info     '}  ${i.title}: ${i.summary}`);
    }
  }
  console.log(`\nOther accounts seen publishing the same addresses: ${a.thirdPartyAccounts}`);

  for (const w of s.chain.activity) {
    if (w.wallet.length > 1) console.log(`\nWallet of ${w.address}: ${w.wallet.length} addresses (rule W1, spent together).`);
    for (const o of w.offRamps) console.log(`Exchange: ${o.exchange} via ${o.depositAddress} (rule ${o.rule}, ${o.deposits.length} deposits).`);
  }
  if (s.estimate) {
    console.log('\nEstimate of value sent to cash-out services (potential revenue, to be verified):');
    for (const y of s.estimate.years) {
      console.log(`  ${y.year}: ${y.totalPln.toLocaleString('pl-PL')} PLN  (probable ${y.probablePln.toLocaleString('pl-PL')}, possible ${y.possiblePln.toLocaleString('pl-PL')})`);
    }
  }
}

const { identifiers, flags } = parseArgs(process.argv.slice(2));
if (!identifiers.length) {
  console.error('Usage: npm run analyze -- <identifier> [more…] [--nick x] [--name "x y"] [--email x] [--phone x] [--address x] [--url x] [--depth n] [--live] [--json] [--verbose]');
  process.exit(1);
}

const rt = await loadRuntime();
try {
  const title = typeof flags.title === 'string' ? flags.title : identifiers.map((i) => i.value).join(', ');
  // Running the same identifiers again adds a run to the same case, so the two can be compared.
  const mode = flags.live ? 'live' : rt.defaultMode;
  const c = await rt.store.findOrCreateCase(title, identifiers, mode);
  const summary = await runAnalysis(
    { store: rt.store, ...rt.sets[mode], log: flags.verbose ? (m) => console.error(m) : undefined },
    c.id,
    typeof flags.depth === 'string' ? { maxDepth: Number(flags.depth) } : {},
  );
  if (flags.json) console.log(JSON.stringify(summary, null, 2));
  else print(summary);
  const diff = await diffRuns(rt.store, summary.runId);
  if (diff && !flags.json) {
    console.log(`\n${diff.summary}`);
    for (const line of [...diff.links, ...diff.profiles, ...diff.accounts, ...diff.indicators]) console.log(`  · ${line.text}`);
  }
  const evidence = await rt.store.verifyEvidence(summary.runId);
  if (!flags.json) console.log(`\nEvidence chain: ${evidence.ok ? 'intact' : 'BROKEN at ' + evidence.broken.join(', ')} (${evidence.checked} snapshots verified).`);
  process.exitCode = summary.status === 'completed' ? 0 : 2;
} finally {
  await rt.close();
}

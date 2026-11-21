import { writeFileSync } from 'node:fs';
import { generateWorld } from './generate';
import { startWorld } from './server';

const [command = 'serve', ...rest] = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};

const world = generateWorld({ seed: arg('seed', process.env.WORLD_SEED ?? 'olcys'), personas: Number(arg('personas', process.env.WORLD_PERSONAS ?? '40')) });

if (command === 'generate') {
  // Ground truth for test scenarios. Private keys are test keys derived from the public seed.
  const out = arg('out', 'world.json')!;
  writeFileSync(out, JSON.stringify(world, null, 2));
  console.log(`World "${world.seed}": ${world.personas.length} personas, ${world.truth.length} address placements → ${out}`);
} else if (command === 'serve') {
  const port = (env: string, fallback: number) => Number(process.env[env] ?? fallback);
  const running = await startWorld(
    world,
    { forum: port('WORLD_FORUM_PORT', 4101), code: port('WORLD_CODE_PORT', 4102), ads: port('WORLD_ADS_PORT', 4103), explorer: port('WORLD_EXPLORER_PORT', 4104), rates: port('WORLD_RATES_PORT', 4105), archive: port('WORLD_ARCHIVE_PORT', 4106) },
    process.env.WORLD_HOST ?? '127.0.0.1',
    process.env.WORLD_PUBLIC_HOST ?? 'localhost',
  );
  console.log(`Synthetic world "${world.seed}" (${world.personas.length} personas) is up:`);
  for (const [site, base] of Object.entries(running.bases)) console.log(`  ${site.padEnd(9)} ${base}`);
} else {
  console.error('Usage: cli.ts serve | generate [--seed s] [--personas n] [--out file]');
  process.exit(1);
}

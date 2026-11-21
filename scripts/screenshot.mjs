// Takes screenshots of the running interface.
// Usage: node scripts/screenshot.mjs <out-dir> <url-suffix>::<name>[::<scroll-y>] ...
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [outDir, ...targets] = process.argv.slice(2);
const base = process.env.WEB_URL ?? 'http://localhost:5173';
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1440), height: Number(process.env.H ?? 900) }, deviceScaleFactor: 1 });
for (const [i, t] of targets.entries()) {
  const [suffix, name = `shot-${i + 1}`, scroll] = t.split('::');
  await page.goto(base + suffix, { waitUntil: 'networkidle' });
  if (scroll) await page.evaluate((y) => window.scrollTo(0, y), Number(scroll));
  await page.waitForTimeout(Number(process.env.WAIT ?? 2500));
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`${outDir}/${name}.png`);
}
await browser.close();

// Drives the interface the way a presenter would: types an identifier, starts the analysis,
// and checks that the graph builds live and ends with a result. Usage: node scripts/live-check.mjs [out-dir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const base = process.env.WEB_URL ?? 'http://localhost:5173';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(base, { waitUntil: 'networkidle' });
if (out) await page.screenshot({ path: `${out}/live-0-empty.png` });
await page.fill('#identifier', process.env.QUERY ?? 'szklane_domy');
await page.click('button.primary');
await page.waitForSelector('svg.graph .node-account', { timeout: 15000 });
await page.waitForTimeout(5000);
const midNodes = await page.locator('svg.graph .node').count();
if (out) await page.screenshot({ path: `${out}/live-1-running.png` });

await page.click('text=4×');
await page.waitForSelector('text=Analiza zakończona.', { timeout: 90000 });
await page.waitForTimeout(2500);
const endNodes = await page.locator('svg.graph .node').count();
const receipt = await page.locator('.receipt').count();
if (out) await page.screenshot({ path: `${out}/live-2-finished.png` });

// Keyboard: a node can be reached and opened without a mouse.
await page.locator('svg.graph .node-service').first().focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const serviceOpen = await page.locator('.side h2').first().textContent();

await page.click('text=Raport');
await page.waitForTimeout(500);
if (out) await page.screenshot({ path: `${out}/live-3-report.png`, fullPage: false });
const reportHeading = await page.frameLocator('.report-frame').locator('h1').first().textContent();

console.log(JSON.stringify({ midNodes, endNodes, receipt, serviceOpen, reportHeading, errors }, null, 2));
await browser.close();
if (errors.length || !(midNodes > 1 && endNodes > midNodes && receipt === 1)) process.exit(1);

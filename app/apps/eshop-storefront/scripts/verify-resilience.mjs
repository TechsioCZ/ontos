// Headless fault-isolated integration proof over the LIVE OntOS owner (no fixture, no writes).
// A private local proxy interrupts only this script's BFF; the shared demo is never stopped.
// PLAYWRIGHT_MODULE=/…/@playwright/test/index.js OUT=/…/shots node scripts/verify-resilience.mjs
import assert from 'node:assert/strict';
import { createServer, request as upstreamRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const OUT = process.env.OUT;
assert(OUT?.startsWith('/'), 'OUT must be an absolute evidence directory');
mkdirSync(OUT, { recursive: true });
let failUntil = 0;
let failedReads = 0;
let assertions = 0;
let actions = 0;
let child;
let browser;
let childLog = '';
const sockets = new Set();
const proxy = createServer((request, response) => {
  const path = request.url ?? '/';
  if (path.includes('/actions/')) {
    actions += 1;
    response.writeHead(403).end('No Actions permitted by this read-only proof');
    return;
  }
  if (path.endsWith('/gateway-context')) assertions += 1;
  if (path.endsWith('/reads/records') && Date.now() < failUntil) {
    failedReads += 1;
    response.writeHead([502, 503, 504, 401][(failedReads - 1) % 4], { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'isolated_transport_interruption' }));
    return;
  }
  const upstream = upstreamRequest(`http://localhost:3020${path}`, {
    headers: { ...request.headers, host: 'localhost:3020' }, method: request.method,
  }, (result) => {
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(503); response.end(); });
  request.pipe(upstream);
});
proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const report = { scope: 'Controlled transport interruptions on a private BFF; recovered data comes from live OntOS. No shared service interruption or order writes.', scenarios: [] };
let closing = false;
const clean = async () => {
  if (closing) return;
  closing = true;
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => proxy.close(resolve));
};
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => { void clean().finally(() => process.exit(code)); });
}
try {
  const proxyPort = await listen(proxy);
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  // Set this to the runtime worktree entry when rebuild-one built its dist rather than this tree's.
  const entry = process.env.STOREFRONT_SERVER_ENTRY ?? new URL('../server/server.ts', import.meta.url).pathname;
  child = spawn(process.execPath, [entry], {
    env: { ...process.env, ESHOP_FIXTURE: '0', ESHOP_STOREFRONT_PORT: String(port), ONTOS_SHELL_URL: `http://127.0.0.1:${proxyPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { childLog += chunk; });
  child.stderr.on('data', (chunk) => { childLog += chunk; });
  for (let attempt = 0; ; attempt += 1) {
    const ready = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
    if (ready) break;
    assert(attempt < 50 && child.exitCode === null, `private BFF failed to start: ${childLog}`);
    await delay(100);
  }
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.fixture, false);
  const productResponse = await fetch(`${base}/api/products/etiopie-yirgacheffe`);
  assert.equal(productResponse.status, 200);
  const { product } = await productResponse.json();
  const variant = product.variants[0];
  assert(variant.priceMinor > 0);
  const item = { productId: product.id, variantId: variant.id, name: product.name, slug: product.slug, image: product.image, variantLabel: variant.label, quantity: 1, priceMinor: variant.priceMinor };
  browser = await chromium.launch({ headless: true });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, locale: 'cs-CZ' });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const shot = async (label) => {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
      await page.screenshot({ path: `${OUT}/fix-${name}-${label}.png`, fullPage: false });
    };
    // The first request cannot use the 1.5-second burst cache. Both home and navigation recover.
    await delay(1600);
    const homeAt = Date.now();
    const beforeHome = failedReads;
    failUntil = Date.now() + 8000;
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('.product-card:not(.product-card--skeleton)').first().waitFor();
    assert(Date.now() - homeAt >= 8000, 'real retry loop covered the eight-second outage');
    assert(failedReads - beforeHome >= 5, 'extended retry window was exercised');
    assert(await page.locator('.site-nav > a').count() >= 6, 'all five backend categories recovered');
    assert.equal(await page.getByRole('button', { name: 'Zkusit znovu' }).count(), 0, 'no manual recovery');
    await shot('31-home-auto-recovered');
    report.scenarios.push({ persona: 'guest', viewport: name, scenario: 'Home + categories automatically recover from 8 s of upstream 502/503/504/401', status: 'PASS', elapsedMs: Date.now() - homeAt });

    await page.evaluate((item) => localStorage.setItem('kavarna-doma.cart.v1', JSON.stringify([item])), item);
    failUntil = Date.now() + 8000;
    const cartAt = Date.now();
    const beforeCart = failedReads;
    await page.goto(`${base}/kosik`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Ověřuji ceny a dostupnost v OntOS…', { exact: false }).waitFor();
    assert(await page.getByRole('button', { name: 'Pokračovat', exact: false }).isDisabled(), 'pending validation stays blocked');
    if (name === 'mobile') await page.locator('.summary').scrollIntoViewIfNeeded();
    await shot('32-cart-recovering');
    await page.getByText('Ceny a dostupnost ověřeny', { exact: false }).waitFor();
    assert(failedReads - beforeCart >= 5);
    assert(Date.now() - cartAt >= 8000);
    assert(!(await page.getByRole('button', { name: 'Pokračovat', exact: false }).isDisabled()));
    assert.equal(await page.getByRole('heading', { name: 'Košík nelze ověřit' }).count(), 0);
    await shot('33-cart-auto-recovered');
    report.scenarios.push({ persona: 'guest', viewport: name, scenario: 'Cart validation automatically recovers from 8 s outage, never enables continuation before a fresh owner response', status: 'PASS', elapsedMs: Date.now() - cartAt });

    // Match the critic: quantity change, then hard reload, while an interruption is in progress.
    failUntil = Date.now() + 5000;
    await page.getByRole('button', { name: 'Přidat kus' }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Ceny a dostupnost ověřeny', { exact: false }).waitFor();
    assert.equal(await page.locator('.cart-line .stepper input').inputValue(), '2');
    assert(!(await page.getByRole('button', { name: 'Pokračovat', exact: false }).isDisabled()));
    report.scenarios.push({ persona: 'guest', viewport: name, scenario: 'Quantity change + cart hard reload during 5 s interruption preserves quantity and automatically validates', status: 'PASS' });

    // A real persistent transport failure must still settle into an honest blocking error.
    failUntil = Infinity;
    const downAt = Date.now();
    await page.getByRole('button', { name: 'Přidat kus' }).click();
    await page.getByRole('heading', { name: 'Košík nelze ověřit' }).waitFor();
    assert(Date.now() - downAt < 23_000, 'persistent fast failure is bounded');
    assert(await page.getByRole('button', { name: 'Pokračovat', exact: false }).isDisabled());
    if (name === 'mobile') await page.locator('.summary').scrollIntoViewIfNeeded();
    await shot('34-persistent-outage-blocked');
    report.scenarios.push({ persona: 'guest', viewport: name, scenario: 'Persistent outage settles into Czech error + disabled continuation, no stale success', status: 'PASS', elapsedMs: Date.now() - downAt });
    failUntil = Date.now() + 2000;
    await page.getByRole('button', { name: 'Zkusit znovu' }).click();
    await page.getByText('Ověřuji ceny a dostupnost v OntOS…', { exact: false }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Košík nelze ověřit' }).count(), 0, 'retry clears settled error while checking');
    await page.getByText('Ceny a dostupnost ověřeny', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Pokračovat', exact: false }).click();
    await page.getByRole('button', { name: 'Vyplnit ukázkové údaje' }).waitFor();
    assert.equal(await page.locator('.order-number').count(), 0, 'no invented confirmation');
    report.scenarios.push({ persona: 'guest', viewport: name, scenario: 'Manual retry clears old error, fresh validation succeeds, checkout becomes reachable without order write', status: 'PASS' });
    assert.deepEqual(errors, []);
    await context.close();
    failUntil = 0;
  }
  assert.equal(actions, 0, 'no Action ever attempted');
  report.totals = { assertions, injectedReadFailures: failedReads, attemptedActions: actions };
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error);
  console.error(childLog);
  throw error;
} finally {
  writeFileSync(`${OUT}/fix-resilience-results.json`, JSON.stringify(report, null, 2));
  await clean();
}

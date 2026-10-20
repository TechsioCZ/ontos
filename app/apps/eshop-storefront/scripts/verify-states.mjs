// Headless, mostly read-only acceptance proof. Faults are intercepted in this browser only.
// Replays an ALREADY SAVED submission; creates no orders. Never run against production.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const BASE = process.env.BASE ?? 'http://localhost:3060';
const OUT = process.env.OUT ?? './shots';
const SAVED = process.env.SAVED_SUBMISSION;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const key = 'kavarna-doma.cart.v1';
const report = {};
try {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  assert.equal(health.fixture, false, 'live backend, never fixture');
  const productOf = async (slug) => (await fetch(`${BASE}/api/products/${slug}`).then((r) => r.json())).product;
  const coffee = await productOf('etiopie-yirgacheffe');
  const unknown = await productOf('rwanda-nyamasheke');
  const asItem = (product, variant = product.variants[0]) => ({ productId: product.id, variantId: variant.id, name: product.name, slug: product.slug, image: product.image, variantLabel: variant.label, quantity: 1, priceMinor: variant.priceMinor });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'cs-CZ' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const goto = async (path) => { await page.goto(BASE + path, { waitUntil: 'networkidle' }); };
    const shot = async (id) => {
      await page.waitForTimeout(200);
      assert((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, `${id} overflow`);
      await page.screenshot({ path: `${OUT}/${name}-${id}.png`, fullPage: false });
    };
    const setCart = async (items) => {
      await page.evaluate(({ key, items }) => localStorage.setItem(key, JSON.stringify(items)), { key, items });
      await goto('/kosik');
    };
    await goto('/produkt/filtry-v60');
    await page.locator('.buy-box').waitFor();
    assert.equal(await page.locator('.gallery__main img').getAttribute('src'), '/img/bez-obrazku.svg');
    await shot('11-missing-image');
    await goto('/produkt/guatemala-antigua');
    assert(await page.locator('.buy-box__cta').isDisabled());
    await shot('12-out-of-stock');
    await goto('/produkt/rwanda-nyamasheke');
    assert(await page.locator('.buy-box__cta').isDisabled());
    assert((await page.locator('.buy-box__blocked').innerText()).includes('nelze ověřit'));
    await shot('13-unknown-availability');
    await goto('/produkt/neexistujici-produkt');
    await page.getByRole('heading', { name: 'Produkt nenalezen' }).waitFor();
    await shot('14-not-found');
    await goto('/produkty?q=KD-ETH-YIR');
    assert.equal(await page.locator('.product-card').count(), 1, 'SKU search');
    await shot('15-sku-search');
    if (name === 'mobile') {
      await page.getByRole('button', { name: /^Filtry/u }).click();
      await page.locator('.filters__options').getByText('Čaj', { exact: false }).click();
      await page.waitForURL(/kategorie\/caj/u);
      assert.equal(await page.locator('.filters--open').count(), 0, 'category closes mobile filter drawer');
    }
    await goto('/produkt/etiopie-yirgacheffe');
    const image = await page.locator('.gallery__main img').getAttribute('src');
    await page.getByRole('button', { name: 'Obrázek 2', exact: true }).click();
    assert.notEqual(await page.locator('.gallery__main img').getAttribute('src'), image);
    await shot('16-gallery');
    await setCart([{ ...asItem(coffee), priceMinor: coffee.variants[0].priceMinor - 100 }]);
    await page.getByText('Cena se změnila', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Pokračovat', exact: false }).isDisabled());
    await shot('17-price-acceptance');
    await page.getByRole('button', { name: 'Přijmout novou cenu', exact: true }).click();
    await page.getByText('Ceny a dostupnost ověřeny', { exact: false }).waitFor();
    assert(!(await page.getByRole('button', { name: 'Pokračovat', exact: false }).isDisabled()));
    await setCart([asItem(unknown)]);
    await page.getByText('Dostupnost nelze ověřit', { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: 'Pokračovat', exact: false }).isDisabled());
    await shot('18-cart-blocked');
    await page.locator('.cart-line__qty').getByRole('button', { name: 'Odebrat' }).click();
    await page.getByRole('heading', { name: 'Košík je prázdný' }).waitFor();
    await shot('19-empty-cart');

    const catalogFault = async (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ code: 'backend_unavailable', message: 'Katalog OntOS je teď nedostupný. Zkuste to prosím znovu.' }) });
    await page.route('**/api/products?**', catalogFault);
    await goto('/produkty?q=Etiopie');
    await page.getByRole('heading', { name: 'Katalog se nepodařilo načíst' }).waitFor();
    assert(!(await page.locator('.listing__count').innerText()).includes('Načítám'));
    await shot('20-catalog-error');
    await page.unroute('**/api/products?**', catalogFault);
    await page.getByRole('button', { name: 'Zkusit znovu' }).click();
    await page.locator('.product-card').waitFor();
    assert.equal(await page.locator('.product-card').count(), 1);

    const noPrice = async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.product.variants = body.product.variants.map((v) => ({ ...v, priceMinor: null }));
      await route.fulfill({ response, json: body });
    };
    await page.route('**/api/products/etiopie-yirgacheffe', noPrice);
    await goto('/produkt/etiopie-yirgacheffe');
    assert(await page.locator('.buy-box__cta').isDisabled());
    assert((await page.locator('.buy-box').innerText()).includes('Cena není dostupná'));
    await shot('21-no-price');
    await page.unroute('**/api/products/etiopie-yirgacheffe', noPrice);

    await setCart([asItem(coffee)]);
    await page.getByText('Ceny a dostupnost ověřeny', { exact: false }).waitFor();
    await goto('/pokladna');
    await page.getByRole('button', { name: 'Vyplnit ukázkové údaje' }).click();
    await page.locator('#email').fill('neplatny-email');
    let posts = 0;
    const failedWrite = async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ code: 'order_save_failed', message: 'Uložení objednávky se teď nepodařilo ověřit. Můžete bezpečně zkusit znovu.' }) });
    };
    await page.route('**/api/orders', failedWrite);
    await page.getByRole('button', { name: 'Potvrdit DEMO objednávku' }).click();
    await page.locator('#email-error').waitFor();
    assert.equal(posts, 0, 'invalid email never writes');
    await shot('22-invalid-email');
    await page.locator('#email').fill('jana.novakova@example.com');
    await page.getByRole('button', { name: 'Potvrdit DEMO objednávku' }).click();
    await page.getByText('Uložení objednávky se nepodařilo potvrdit.', { exact: true }).waitFor();
    assert.equal(await page.locator('.order-number').count(), 0);
    const firstId = await page.evaluate(() => sessionStorage.getItem('kavarna-doma.checkout.submission'));
    await page.getByRole('button', { name: 'Potvrdit DEMO objednávku' }).click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('kavarna-doma.checkout.submission')), firstId);
    assert.equal(posts, 2, 'two intercepted failures, no live writes');
    await shot('23-save-error');
    await page.unroute('**/api/orders', failedWrite);
    if (SAVED) {
      await goto(`/objednavka/${SAVED}`);
      await page.locator('.order-number').waitFor();
      await shot('10-confirmation');
    }
    assert.deepEqual(errors, []);
    report[name] = 'PASS gallery/missing image/out-of-stock/unknown/SKU/not-found/price acceptance/cart blocking/empty/retry/no-price/invalid-email/failed-save';
    await context.close();
  }

  // Read the exact same saved number in the authorized admin UI; do not edit another lane's records.
  if (SAVED && process.env.VERIFY_STAFF === '1') {
    const saved = await fetch(`${BASE}/api/orders/${SAVED}`).then((r) => r.json());
    const staff = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await staff.newPage();
    let recordsUrl;
    page.on('request', (request) => { if (request.url().includes('/reads/records') && request.url().includes('merchandise')) recordsUrl = request.url(); });
    await page.goto('http://localhost:3020/cs/login');
    await page.fill('#login', 'eshop@kavarna.demo');
    await page.fill('#password', 'password1234');
    await page.click('button[type=submit]');
    await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 60000 });
    await page.goto('http://localhost:3020/cs/prodej/objednavky');
    const row = page.getByText(saved.orderNumber, { exact: true });
    await row.waitFor({ timeout: 60000 });
    assert.equal(await row.count(), 1, 'exactly one admin row');
    await row.click();
    await page.getByRole('dialog').last().waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/desktop-24-admin-saved-order.png` });
    report.admin = `${saved.orderNumber}: one row and persisted detail; records ${recordsUrl}`;
    if (recordsUrl) {
      const anonymous = await browser.newContext();
      const denied = await anonymous.request.post(recordsUrl, { data: {} });
      assert([401, 403].includes(denied.status()), `anonymous records returned ${denied.status()}`);
      const actionUrl = recordsUrl.replace(/\/reads\/records.*$/u, '/merchandise/actions/apply-command');
      const action = await anonymous.request.post(actionUrl, { data: { expectedRevision: 0, command: { _tag: 'ChangePrice', id: coffee.id, priceMinor: 100 } } });
      assert([401, 403].includes(action.status()), `anonymous action returned ${action.status()}`);
      report.anonymous = `records ${denied.status()}, staff action ${action.status()}`;
      await anonymous.close();
    }
    await staff.close();
  }
  console.log('RESULT', JSON.stringify(report));
} finally {
  await browser.close();
}

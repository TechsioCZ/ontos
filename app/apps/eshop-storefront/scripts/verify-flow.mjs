// Headless purchase-flow proof for the Kavárna Doma storefront (desktop + 390 px mobile).
//   PLAYWRIGHT_MODULE=/…/playwright/index.js BASE=http://localhost:3060 OUT=/…/shots node scripts/verify-flow.mjs
// Never opens a visible window. Exits non-zero when a step fails.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const BASE = process.env.BASE ?? 'http://localhost:3060';
const OUT = process.env.OUT ?? './shots';
const ONLY = process.env.ONLY; // desktop | mobile
mkdirSync(OUT, { recursive: true });

const log = (...args) => console.log('•', ...args);
const assert = (condition, message) => {
  if (!condition) throw new Error(`ASSERTION: ${message}`);
};

const run = async (browser, name, viewport) => {
  const context = await browser.newContext({ deviceScaleFactor: name === 'mobile' ? 2 : 1, isMobile: name === 'mobile', locale: 'cs-CZ', viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const bodies = [];
  page.on('response', async (response) => {
    if (response.url().startsWith(BASE)) bodies.push(await response.text().catch(() => ''));
  });
  page.on('response', async (response) => {
    if (response.url().includes('/api/orders') || (response.url().includes('/api/') && response.status() >= 400)) {
      console.log('  ', response.status(), response.request().method(), response.url().replace(BASE, ''), (await response.text().catch(() => '')).slice(0, 200));
    }
  });
  const shot = async (step) => {
    // Full-page capture must load lazy artwork below the fold, especially on a 390px viewport.
    await page.evaluate(async () => {
      const start = window.scrollY;
      for (let y = 0; y < document.documentElement.scrollHeight; y += window.innerHeight) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
      window.scrollTo(0, start);
    });
    await page.waitForTimeout(200);
    return page.screenshot({ fullPage: true, scale: 'css', path: `${OUT}/${name}-${step}.png` });
  };
  const noHorizontalScroll = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
  };

  // E02 homepage
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.product-card:not(.product-card--skeleton)');
  const ribbon = await page.textContent('.demo-ribbon');
  assert(ribbon.includes('DEMO'), 'demo ribbon visible');
  const robots = await page.getAttribute('meta[name="robots"]', 'content');
  assert(robots?.includes('noindex'), 'noindex meta');
  const homeCards = await page.locator('.product-card:not(.product-card--skeleton)').count();
  assert(homeCards >= 6, `home shows >= 6 products (got ${homeCards})`);
  await noHorizontalScroll('home');
  await shot('01-home');
  log(name, 'home ok', homeCards, 'cards');

  // E02/E03 category + filters in URL
  const firstCategory = await page.locator('.category-card').first().getAttribute('href');
  await page.goto(`${BASE}${firstCategory}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.listing__count');
  await page.waitForFunction(() => !document.querySelector('.listing__count')?.textContent?.includes('Načítám'));
  const categoryCount = await page.locator('.product-card').count();
  await shot('02-category');
  await page.goto(`${BASE}${firstCategory}?razeni=cena-vzestupne&dostupnost=skladem`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  assert((await page.inputValue('select')) === 'cena-vzestupne', 'sort persisted after reload');
  assert(await page.isChecked('.checkbox input'), 'availability filter persisted after reload');
  await noHorizontalScroll('category');
  await shot('03-category-filtered');
  log(name, 'category ok', categoryCount, 'products; filters persisted');

  await page.goto(`${BASE}/produkty?q=xyzneexistuje`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Nenalezeny žádné produkty');
  await shot('04-search-empty');
  log(name, 'empty search ok');

  // E02 product detail with variants
  await page.goto(`${BASE}/produkty`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.product-card');
  const variantProduct = page.locator('.product-card', { has: page.locator('.product-card__flag:not(.product-card__flag--out)') }).first();
  const productHref = await variantProduct.locator('a.product-card__media').getAttribute('href');
  await page.goto(`${BASE}${productHref}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.buy-box');
  const priceA = await page.textContent('.buy-box .price');
  const variants = page.locator('.variant');
  const variantCount = await variants.count();
  assert(variantCount >= 2, 'variant product has a picker');
  // pick a different, purchasable variant if possible
  let changed = false;
  for (let index = variantCount - 1; index >= 0 && !changed; index -= 1) {
    const button = variants.nth(index);
    if ((await button.getAttribute('aria-pressed')) === 'true') continue;
    await button.click();
    await page.waitForTimeout(150);
    const priceB = await page.textContent('.buy-box .price');
    if (priceB !== priceA) changed = true;
  }
  assert(changed, 'variant switch changes the price');
  if (await page.locator('.buy-box__cta').isDisabled()) {
    for (let index = 0; index < variantCount; index += 1) {
      await variants.nth(index).click();
      await page.waitForTimeout(100);
      if (!(await page.locator('.buy-box__cta').isDisabled())) break;
    }
  }
  await shot('05-product-variant');
  await page.click('.stepper button[aria-label="Přidat kus"]');
  await page.click('.buy-box__cta');
  await page.waitForSelector('.toast');
  await shot('06-added-toast');
  log(name, 'product ok', productHref);

  // second product without variants
  await page.goto(`${BASE}/produkty?dostupnost=skladem&razeni=cena-vzestupne`, { waitUntil: 'networkidle' });
  const cheap = await page.locator('.product-card a.product-card__media').first().getAttribute('href');
  await page.goto(`${BASE}${cheap}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.buy-box');
  if (!(await page.locator('.buy-box__cta').isDisabled())) await page.click('.buy-box__cta');

  // E05 cart
  await page.goto(`${BASE}/kosik`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Ceny a dostupnost ověřeny', { timeout: 15000 });
  const lines = await page.locator('.cart-line').count();
  assert(lines >= 2, `cart has two lines (got ${lines})`);
  await page.locator('.cart-line').first().locator('button[aria-label="Přidat kus"]').click();
  await page.waitForSelector('text=Ceny a dostupnost ověřeny', { timeout: 15000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('text=Ceny a dostupnost ověřeny', { timeout: 15000 });
  assert((await page.locator('.cart-line').count()) === lines, 'cart persisted after reload');
  await noHorizontalScroll('cart');
  await shot('07-cart');
  log(name, 'cart ok', lines, 'lines');

  // E06 checkout: validation, then submit twice
  await page.click('text=Pokračovat >> nth=0');
  await page.waitForSelector('.checkout__form');
  await page.click('button[type="submit"]');
  await page.waitForSelector('.field--error');
  await shot('08-checkout-errors');
  await page.click('text=Vyplnit ukázkové údaje');
  const disclaimer = await page.textContent('.disclaimer');
  assert(disclaimer.includes('E-shop je prezentační demo. Žádné zboží vám nebude doručeno a nic neplatíte.'), 'exact disclaimer before submit');
  await noHorizontalScroll('checkout');
  await shot('09-checkout-filled');
  if (process.env.VERIFY_NO_SUBMIT === '1') {
    assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
    await context.close();
    return 'checkout verified without creating another order';
  }
  const orderPosts = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/orders') && request.method() === 'POST') orderPosts.push(JSON.parse(request.postData()).submissionId);
  });
  await page.locator('button[type="submit"]').dblclick();
  await page.waitForURL(/\/objednavka\//u, { timeout: 30000 }).catch(async (error) => {
    await shot('99-submit-failed');
    throw error;
  });
  await page.waitForSelector('.order-number');
  const number = (await page.textContent('.order-number')).trim();
  assert(/\S/u.test(number), 'order number shown');
  assert(new Set(orderPosts).size <= 1, 'one submission id for all posts');
  const confirmText = await page.textContent('.confirmation__hero');
  assert(confirmText.includes(`DEMO objednávka č. ${number} byla uložena do administrace`), 'confirmation sentence');
  assert(confirmText.includes('E-shop je prezentační demo. Žádné zboží vám nebude doručeno a nic neplatíte.'), 'disclaimer after submit');
  await shot('10-confirmation');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.order-number');
  const again = (await page.textContent('.order-number')).trim();
  assert(again === number, `same number after refresh (${number} vs ${again})`);
  await noHorizontalScroll('confirmation');
  log(name, 'order ok', number, 'posts', orderPosts.length);

  // E00-03: the server credential never reaches the browser (bundle, HTML, API answers).
  const envFile = new URL('../../../.env.demo.local', import.meta.url);
  const key = existsSync(envFile) ? /^ONTOS_STOREFRONT_API_KEY=(.+)$/mu.exec(readFileSync(envFile, 'utf-8'))?.[1]?.trim() : undefined;
  if (key !== undefined && key.length > 8) {
    assert(!bodies.some((body) => body.includes(key)), 'storefront API key leaked to the browser');
    log(name, `credential check ok (${bodies.length} responses scanned)`);
  }
  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  await context.close();
  return number;
};

const browser = await chromium.launch({ headless: true });
try {
  const results = {};
  if (ONLY !== 'mobile') results.desktop = await run(browser, 'desktop', { height: 900, width: 1440 });
  if (ONLY !== 'desktop') results.mobile = await run(browser, 'mobile', { height: 844, width: 390 });
  console.log('RESULT', JSON.stringify(results));
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import {
  assertSymmyStorefrontImage,
  assertSymmyStorefrontPages,
  proveSymmyStorefront,
  readSymmyStorefrontProofInput,
  SymmyStorefrontProofFailure,
} from './stage-symmy-storefront-proof.mts';

const input = {
  origin: 'https://store.example.test',
  locale: 'cs',
  sku: 'FRESH_NATIVE_123',
  productId: '0193e001-0000-7000-8000-000000000001',
  categorySlug: 'fresh-source-category',
  productSlug: 'fresh-native-product',
  galleryUrl: '/obrazky/0193e001-0000-7000-8000-000000000001/0193e001-0000-7000-8000-000000000002',
  timeoutMs: 1000,
};
const product = {
  productId: input.productId,
  slug: input.productSlug,
  name: 'Fresh & real',
  imageSrc: input.galleryUrl,
};
const image = `<img src="/_next/image?url=${encodeURIComponent(input.galleryUrl)}&amp;w=480&amp;q=75">`;
const detail = `<h1 id="product-title">Fresh &amp; real</h1><dl><dd>${input.sku}</dd></dl>${image}`;
const listing = `<section aria-label="Produkty: New source"><a href="/cs/produkt/${input.productSlug}">Fresh product</a>${image}</section>`;
const category = `<h1 id="category-title">New source</h1>${listing}`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQ9bvxHwAEEgJD6R8JuAAAAABJRU5ErkJggg==',
  'base64',
);
const search = () => Response.json({ total: 1, items: [product] });

const fetcher = (overrides: Partial<Record<'search' | 'product' | 'category' | 'image', () => Response>> = {}) => {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : url);
    calls.push({ url: target, init });
    if (target.pathname === '/api/ontos/search') return (overrides.search ?? search)();
    if (target.pathname === `/cs/produkt/${input.productSlug}`)
      return overrides.product?.() ?? new Response(detail, { headers: { 'content-type': 'text/html' } });
    if (target.pathname === `/cs/kategorie/${input.categorySlug}`)
      return overrides.category?.() ?? new Response(category, { headers: { 'content-type': 'text/html' } });
    if (target.pathname === input.galleryUrl)
      return overrides.image?.() ?? new Response(png, { headers: { 'content-type': 'image/png' } });
    throw new Error('Unexpected proof destination');
  };
  return { fetch, calls };
};

test('public proof verifies exact fresh search identity, real category listing, rendered SKU and uploaded bytes', async () => {
  const transport = fetcher();
  const result = await Effect.runPromise(proveSymmyStorefront(input, transport));
  assert.equal(result.outcome, 'PASS');
  assert.equal(result.productId, input.productId);
  assert.equal(result.imageBytes, png.length);
  assert.equal(result.imageMime, 'image/png');
  assert.equal(transport.calls.length, 4);
  const [first] = transport.calls;
  assert.ok(first);
  assert.equal(first.init?.method, 'POST');
  assert.equal(first.init?.body, JSON.stringify({ q: input.sku }));
  for (const call of transport.calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get('x-akros-market-locale'), 'cs');
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('x-api-key'), null);
    assert.equal(headers.get('cookie'), null);
    assert.equal(call.init?.redirect, 'manual');
  }
});

test('empty search, foreign product identity, unexpected slug and mismatched native gallery all fail closed', async () => {
  for (const body of [
    { total: 0, items: [] },
    { total: 1, items: [{ ...product, productId: 'other-native-product' }] },
    { total: 1, items: [{ ...product, slug: 'another-product' }] },
    { total: 1, items: [{ ...product, imageSrc: '/storefront/products/image-unavailable.svg' }] },
    { total: 2, items: [product, product] },
  ]) {
    const transport = fetcher({ search: () => Response.json(body) });
    const result = await Effect.runPromise(proveSymmyStorefront(input, transport).pipe(Effect.flip));
    assert.equal(result._tag, 'SymmyStorefrontProofFailure');
    assert.equal(result.stage, 'search');
    assert.equal(transport.calls.length, 1);
  }
});

test('missing/soft-404 category or a product shown only in recommendations is never accepted', async () => {
  for (const response of [
    () => new Response('Not found', { status: 404 }),
    () => new Response('<h1>Not found</h1>', { headers: { 'content-type': 'text/html' } }),
    () =>
      new Response(
        `<h1 id="category-title">New source</h1><section aria-labelledby="recommendations-title">${listing}</section>`,
        { headers: { 'content-type': 'text/html' } },
      ),
    () =>
      new Response(`<h1 id="category-title">New source</h1><script>${listing}</script>`, {
        headers: { 'content-type': 'text/html' },
      }),
  ]) {
    const transport = fetcher({ category: response });
    const result = await Effect.runPromise(proveSymmyStorefront(input, transport).pipe(Effect.flip));
    assert.equal(result.stage, 'category');
    assert.equal(transport.calls.length, 3);
  }
});

test('product SKU/title and actual category product-link/image are required outside script payloads', () => {
  for (const bad of [
    detail.replace(input.sku, 'OLD_SKU'),
    detail.replace('Fresh &amp; real', 'Old product'),
    `<script>${detail}</script><h1>Unavailable</h1>`,
    detail.replace(image, ''),
  ])
    assert.throws(() => assertSymmyStorefrontPages(input, product, bad, category), SymmyStorefrontProofFailure);
  assert.throws(
    () => assertSymmyStorefrontPages(input, product, detail, category.replace(input.productSlug, 'old-product')),
    (error: unknown) => error instanceof SymmyStorefrontProofFailure && error.reason === 'product-not-in-category',
  );
  assert.throws(
    () => assertSymmyStorefrontPages(input, product, detail, category.replace(image, '')),
    (error: unknown) => error instanceof SymmyStorefrontProofFailure && error.reason === 'gallery',
  );
});

test('image HTTP status, empty bodies, incorrect MIME/signature and oversized downloads fail', async () => {
  for (const response of [
    () => new Response('not found', { status: 404 }),
    () => new Response('', { headers: { 'content-type': 'image/png' } }),
    () => new Response('<html>error</html>', { headers: { 'content-type': 'image/png' } }),
    () => new Response(png, { headers: { 'content-type': 'text/html' } }),
    () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '9000000' } }),
  ]) {
    const result = await Effect.runPromise(proveSymmyStorefront(input, fetcher({ image: response })).pipe(Effect.flip));
    assert.equal(result.stage, 'image');
  }
  assert.doesNotThrow(() => assertSymmyStorefrontImage('image/png', png));
});

test('public requests never follow a cross-origin redirect or return a partial success', async () => {
  let attempts = 0;
  const fetch: typeof globalThis.fetch = async () => {
    attempts += 1;
    return new Response(null, { status: 307, headers: { location: 'https://foreign.example.test/page' } });
  };
  const result = await Effect.runPromise(proveSymmyStorefront(input, { fetch }).pipe(Effect.flip));
  assert.equal(result.stage, 'search');
  assert.equal(attempts, 1);
});

test('same-origin redirects cannot substitute another category or a placeholder image', async () => {
  for (const stage of ['category', 'image'] as const) {
    const base = fetcher({
      [stage]: () => new Response(null, { status: 307, headers: { location: '/substitute' } }),
    });
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const target = new URL(url instanceof Request ? url.url : url);
      if (target.pathname !== '/substitute') return base.fetch(url, init);
      return stage === 'category'
        ? new Response(category, { headers: { 'content-type': 'text/html' } })
        : new Response(png, { headers: { 'content-type': 'image/png' } });
    };
    const result = await Effect.runPromise(proveSymmyStorefront(input, { fetch }).pipe(Effect.flip));
    assert.equal(result.stage, stage);
    assert.equal(result.reason, 'redirected-identity');
  }
});

test('CLI/env take only explicit public identities, support flag overrides, and need no secret', () => {
  const env = {
    SYMMY_STOREFRONT_ORIGIN: input.origin,
    SYMMY_STOREFRONT_SKU: input.sku,
    SYMMY_STOREFRONT_CATEGORY_SLUG: input.categorySlug,
    SYMMY_STOREFRONT_PRODUCT_ID: input.productId,
    SYMMY_STOREFRONT_GALLERY_URL: input.galleryUrl,
    SYMMY_STOREFRONT_PRODUCT_SLUG: input.productSlug,
    SYMMY_STOREFRONT_TIMEOUT_MS: '1000',
  };
  assert.deepEqual(readSymmyStorefrontProofInput([], env), input);
  assert.equal(readSymmyStorefrontProofInput(['--sku', 'OVERRIDE'], env).sku, 'OVERRIDE');
  assert.throws(() => readSymmyStorefrontProofInput([], {}), SymmyStorefrontProofFailure);
  assert.throws(() => readSymmyStorefrontProofInput(['--api-key', 'not-accepted'], env));
});

test('invalid or cross-product media input is rejected before any HTTP request', async () => {
  for (const galleryUrl of [
    'https://foreign.example.test/image.png',
    '/obrazky/another-product/0193e001-0000-7000-8000-000000000002',
  ]) {
    const transport = fetcher();
    const result = await Effect.runPromise(proveSymmyStorefront({ ...input, galleryUrl }, transport).pipe(Effect.flip));
    assert.equal(result.stage, 'configuration');
    assert.equal(transport.calls.length, 0);
  }
});

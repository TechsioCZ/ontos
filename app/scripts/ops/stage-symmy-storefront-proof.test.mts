import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Result, Schema } from 'effect';
import {
  assertSymmyStorefrontImage,
  assertSymmyStorefrontPages,
  proveSymmyStorefront,
  readSymmyStorefrontProofInput,
  SymmyStorefrontProofCliLayer,
  SymmyStorefrontProofFailure,
  SymmyStorefrontProofInputSchema,
} from './stage-symmy-storefront-proof.mts';

await using runtime = ManagedRuntime.make(Layer.merge(NodeServices.layer, SymmyStorefrontProofCliLayer));

const input = Result.getOrThrow(
  Schema.decodeUnknownResult(
    Schema.Struct({
      ...SymmyStorefrontProofInputSchema.fields,
      productSlug: Schema.Literal('fresh-native-product'),
    }),
  )({
    categorySlug: 'fresh-source-category',
    galleryUrl: '/obrazky/0193e001-0000-7000-8000-000000000001/0193e001-0000-7000-8000-000000000002',
    locale: 'cs',
    origin: 'https://store.example.test',
    productId: '0193e001-0000-7000-8000-000000000001',
    productSlug: 'fresh-native-product',
    sku: 'FRESH_NATIVE_123',
    timeoutMs: 1000,
  }),
);
const product = {
  imageSrc: input.galleryUrl,
  name: 'Fresh & real',
  productId: input.productId,
  slug: input.productSlug,
};
const image = `<img src="/_next/image?url=${encodeURIComponent(input.galleryUrl)}&amp;w=480&amp;q=75">`;
const detail = `<section aria-labelledby="product-title"><div class="sf-product-detail__gallery">${image}</div><h1 id="product-title">Fresh &amp; real</h1><dl><dd>${input.sku}</dd></dl></section>`;
const card = `<article><a class="sf-catalog-product-card__image-link" href="/cs/produkt/${input.productSlug}">${image}</a></article>`;
const listing = `<section aria-label="Produkty: New source">${card}</section>`;
const category = `<h1 id="category-title">New source</h1>${listing}`;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQ9bvxHwAEEgJD6R8JuAAAAABJRU5ErkJggg==',
  'base64',
);
const search = Effect.sync(() => Response.json({ items: [product], total: 1 }));

const fetcher = (
  overrides: Partial<Record<'search' | 'product' | 'category' | 'image', Effect.Effect<Response, Error>>> = {},
) => {
  const calls: { init: RequestInit | undefined; url: URL }[] = [];
  const respond = Effect.fn('StorefrontProofFixtureResponse')(function* respond(
    url: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ) {
    const target = new URL(Schema.is(Schema.instanceOf(Request))(url) ? url.url : url);
    calls.push({ init, url: target });
    if (target.pathname === '/api/ontos/search') {
      return yield* overrides.search ?? search;
    }
    if (target.pathname === `/cs/produkt/${input.productSlug}`) {
      return yield* (
        overrides.product ?? Effect.sync(() => new Response(detail, { headers: { 'content-type': 'text/html' } }))
      );
    }
    if (target.pathname === `/cs/kategorie/${input.categorySlug}`) {
      return yield* (
        overrides.category ?? Effect.sync(() => new Response(category, { headers: { 'content-type': 'text/html' } }))
      );
    }
    if (target.pathname === input.galleryUrl) {
      return yield* (
        overrides.image ?? Effect.sync(() => new Response(png, { headers: { 'content-type': 'image/png' } }))
      );
    }
    return yield* Effect.fail(new Error('Unexpected proof destination'));
  });
  // The native fetch contract is the foreign Promise edge; fixture behavior remains an Effect port.
  const fetch: typeof globalThis.fetch = (url, init) => runtime.runPromise(respond(url, init));
  return { calls, fetch, respond };
};

await test('public proof verifies exact fresh search identity, real category listing, rendered SKU and uploaded bytes', () =>
  runtime.runPromise(
    Effect.gen(function* proofSuccess() {
      const transport = fetcher();
      const result = yield* proveSymmyStorefront(input, transport);
      assert.equal(result.outcome, 'PASS');
      assert.equal(result.productId, input.productId);
      assert.equal(result.imageBytes, png.length);
      assert.equal(result.imageMime, 'image/png');
      assert.equal(transport.calls.length, 4);
      assert.deepEqual(
        transport.calls.map((call) => call.url.pathname),
        [
          '/api/ontos/search',
          `/cs/produkt/${input.productSlug}`,
          `/cs/kategorie/${input.categorySlug}`,
          input.galleryUrl,
        ],
      );
      assert.deepEqual(
        transport.calls.map((call) => call.init?.method),
        ['POST', 'GET', 'GET', 'GET'],
      );
      const [first] = transport.calls;
      assert.notEqual(first, undefined);
      assert.equal(first.init?.method, 'POST');
      assert.equal(first.init?.body, JSON.stringify({ q: input.sku }));
      for (const call of transport.calls) {
        const headers = new Headers(call.init?.headers);
        assert.equal(headers.get('x-akros-market-locale'), 'cs');
        assert.equal(headers.get('authorization'), null);
        assert.equal(headers.get('x-api-key'), null);
        assert.equal(headers.get('cookie'), null);
        assert.equal(call.init?.redirect, 'manual');
        assert.ok(Schema.is(Schema.instanceOf(AbortSignal))(call.init?.signal));
      }
    }),
  ));

await test('empty search, foreign product identity, unexpected slug and mismatched native gallery all fail closed', () =>
  runtime.runPromise(
    Effect.gen(function* searchFailures() {
      yield* Effect.forEach(
        [
          { items: [], total: 0 },
          { items: [{ ...product, productId: 'other-native-product' }], total: 1 },
          { items: [{ ...product, slug: 'another-product' }], total: 1 },
          { items: [{ ...product, imageSrc: '/storefront/products/image-unavailable.svg' }], total: 1 },
          { items: [product, product], total: 2 },
        ],
        (body) =>
          Effect.gen(function* searchFailure() {
            const transport = fetcher({ search: Effect.sync(() => Response.json(body)) });
            const result = yield* proveSymmyStorefront(input, transport).pipe(Effect.flip);
            assert.ok(Schema.is(Schema.instanceOf(SymmyStorefrontProofFailure))(result));
            assert.equal(result.stage, 'search');
            assert.equal(transport.calls.length, 1);
          }),
        { concurrency: 1 },
      );
    }),
  ));

await test('missing/soft-404 category or a product shown only in recommendations is never accepted', () =>
  runtime.runPromise(
    Effect.gen(function* categoryFailures() {
      yield* Effect.forEach(
        [
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
        ],
        (response) =>
          Effect.gen(function* categoryFailure() {
            const transport = fetcher({ category: Effect.sync(response) });
            const result = yield* proveSymmyStorefront(input, transport).pipe(Effect.flip);
            assert.equal(result.stage, 'category');
            assert.equal(transport.calls.length, 3);
          }),
        { concurrency: 1 },
      );
    }),
  ));

await test('product SKU/title and actual category product-link/image are required outside script payloads', () =>
  runtime.runPromise(
    Effect.sync(() => {
      for (const bad of [
        detail.replace(input.sku, 'OLD_SKU'),
        detail.replace('Fresh &amp; real', 'Old product'),
        `<script>${detail}</script><h1>Unavailable</h1>`,
        detail.replace(image, ''),
      ]) {
        assert.throws(() => assertSymmyStorefrontPages(input, product, bad, category), SymmyStorefrontProofFailure);
      }
      assert.throws(
        () => assertSymmyStorefrontPages(input, product, detail, category.replace(input.productSlug, 'old-product')),
        Schema.is(
          Schema.instanceOf(SymmyStorefrontProofFailure).check(
            Schema.makeFilter((error) => error.reason === 'product-not-in-category'),
          ),
        ),
      );
      assert.throws(
        () => assertSymmyStorefrontPages(input, product, detail, category.replace(image, '')),
        Schema.is(
          Schema.instanceOf(SymmyStorefrontProofFailure).check(
            Schema.makeFilter((error) => error.reason === 'gallery'),
          ),
        ),
      );
    }),
  ));

await test('gallery must belong to the product overview and the matching category card image link', () =>
  runtime.runPromise(
    Effect.sync(() => {
      for (const elsewhere of [
        `${detail.replace(image, '')}<aside>${image}</aside>`,
        detail.replace(image, '').replace('</section>', `<div>${image}</div></section>`),
      ]) {
        assert.throws(
          () => assertSymmyStorefrontPages(input, product, elsewhere, category),
          Schema.is(
            Schema.instanceOf(SymmyStorefrontProofFailure).check(
              Schema.makeFilter((error) => error.reason === 'gallery' && error.stage === 'product'),
            ),
          ),
        );
      }
      const otherCard = card.replace(input.productSlug, 'unrelated');
      for (const misplaced of [
        category.replace(card, `${card.replace(image, '')}${otherCard}`),
        category.replace(image, `</a><a href="/cs/produkt/unrelated">${image}`),
      ]) {
        assert.throws(
          () => assertSymmyStorefrontPages(input, product, detail, misplaced),
          Schema.is(
            Schema.instanceOf(SymmyStorefrontProofFailure).check(
              Schema.makeFilter((error) => error.reason === 'gallery' && error.stage === 'category'),
            ),
          ),
        );
      }
    }),
  ));

await test('image HTTP status, empty bodies, incorrect MIME/signature and oversized downloads fail', () =>
  runtime.runPromise(
    Effect.gen(function* imageFailures() {
      yield* Effect.forEach(
        [
          () => new Response('not found', { status: 404 }),
          () => new Response('', { headers: { 'content-type': 'image/png' } }),
          () => new Response('<html>error</html>', { headers: { 'content-type': 'image/png' } }),
          () => new Response(png, { headers: { 'content-type': 'text/html' } }),
          () => new Response(png, { headers: { 'content-length': '9000000', 'content-type': 'image/png' } }),
        ],
        (response) =>
          Effect.gen(function* imageFailure() {
            const result = yield* proveSymmyStorefront(input, fetcher({ image: Effect.sync(response) })).pipe(
              Effect.flip,
            );
            assert.equal(result.stage, 'image');
          }),
        { concurrency: 1 },
      );
      assert.doesNotThrow(() => assertSymmyStorefrontImage('image/png', png));
    }),
  ));

await test('public requests never follow a cross-origin redirect or return a partial success', () =>
  runtime.runPromise(
    Effect.gen(function* foreignRedirect() {
      let attempts = 0;
      const transport = fetcher({
        search: Effect.sync(() => {
          attempts += 1;
          return new Response(null, { headers: { location: 'https://foreign.example.test/page' }, status: 307 });
        }),
      });
      const result = yield* proveSymmyStorefront(input, transport).pipe(Effect.flip);
      assert.equal(result.stage, 'search');
      assert.equal(attempts, 1);
      assert.equal(transport.calls.length, 1);
    }),
  ));

await test('same-origin redirects cannot substitute another category or a placeholder image', () =>
  runtime.runPromise(
    Effect.gen(function* redirectIdentity() {
      yield* Effect.forEach(
        ['category', 'image'] as const,
        (stage) =>
          Effect.gen(function* redirectFailure() {
            const base = fetcher({
              [stage]: Effect.sync(() => new Response(null, { headers: { location: '/substitute' }, status: 307 })),
            });
            const respond = Effect.fn('SubstituteStorefrontFixtureResponse')(function* respond(
              url: Parameters<typeof globalThis.fetch>[0],
              init?: RequestInit,
            ) {
              const target = new URL(Schema.is(Schema.instanceOf(Request))(url) ? url.url : url);
              if (target.pathname !== '/substitute') {
                return yield* base.respond(url, init);
              }
              return stage === 'category'
                ? new Response(category, { headers: { 'content-type': 'text/html' } })
                : new Response(png, { headers: { 'content-type': 'image/png' } });
            });
            const fetch: typeof globalThis.fetch = (url, init) => runtime.runPromise(respond(url, init));
            const result = yield* proveSymmyStorefront(input, { fetch }).pipe(Effect.flip);
            assert.equal(result.stage, stage);
            assert.equal(result.reason, 'redirected-identity');
          }),
        { concurrency: 1 },
      );
    }),
  ));

await test('CLI/env take only explicit public identities, support flag overrides, and need no secret', () =>
  runtime.runPromise(
    Effect.gen(function* inputConfiguration() {
      const env = {
        SYMMY_STOREFRONT_CATEGORY_SLUG: input.categorySlug,
        SYMMY_STOREFRONT_GALLERY_URL: input.galleryUrl,
        SYMMY_STOREFRONT_ORIGIN: input.origin,
        SYMMY_STOREFRONT_PRODUCT_ID: input.productId,
        SYMMY_STOREFRONT_PRODUCT_SLUG: input.productSlug,
        SYMMY_STOREFRONT_SKU: input.sku,
        SYMMY_STOREFRONT_TIMEOUT_MS: '1000',
      };
      const parserLayer = ConfigProvider.layer(ConfigProvider.fromUnknown(env));
      assert.deepEqual(yield* readSymmyStorefrontProofInput([]).pipe(Effect.provide(parserLayer)), input);
      const override = yield* readSymmyStorefrontProofInput(['--sku', 'OVERRIDE']).pipe(Effect.provide(parserLayer));
      assert.equal(override.sku, 'OVERRIDE');
      const missingInput = yield* readSymmyStorefrontProofInput([]).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        Effect.flip,
      );
      assert.ok(Schema.is(Schema.instanceOf(SymmyStorefrontProofFailure))(missingInput));
      const unknownFlag = yield* Effect.exit(
        readSymmyStorefrontProofInput(['--api-key', 'not-accepted']).pipe(Effect.provide(parserLayer)),
      );
      assert.ok(Exit.isFailure(unknownFlag));
    }),
  ));

await test('invalid or cross-product media input is rejected before any HTTP request', () =>
  runtime.runPromise(
    Effect.gen(function* invalidMedia() {
      yield* Effect.forEach(
        ['https://foreign.example.test/image.png', '/obrazky/another-product/0193e001-0000-7000-8000-000000000002'],
        (galleryUrl) =>
          Effect.gen(function* configurationFailure() {
            const transport = fetcher();
            const result = yield* proveSymmyStorefront({ ...input, galleryUrl }, transport).pipe(Effect.flip);
            assert.equal(result.stage, 'configuration');
            assert.equal(transport.calls.length, 0);
          }),
        { concurrency: 1 },
      );
    }),
  ));

await test('GET redirects stop after four requests and cancel every redirect body before the next request', () =>
  runtime.runPromise(
    Effect.gen(function* redirectLimit() {
      let redirects = 0;
      let cancellations = 0;
      const transport = fetcher({
        category: Effect.sync(() => {
          assert.equal(cancellations, redirects);
          redirects += 1;
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancellations += 1;
              },
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
            }),
            {
              headers: { location: `/cs/kategorie/${input.categorySlug}` },
              status: 307,
            },
          );
        }),
      });
      const result = yield* proveSymmyStorefront(input, transport).pipe(Effect.flip);
      assert.equal(result.stage, 'category');
      assert.equal(result.reason, 'too-many-redirects');
      assert.equal(transport.calls.length, 6);
      assert.equal(redirects, 4);
      assert.equal(cancellations, 4);
    }),
  ));

await test('streamed size limit cancels and unlocks the reader without requesting later proof stages', () =>
  runtime.runPromise(
    Effect.gen(function* streamLimit() {
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancellations += 1;
        },
        start(controller) {
          controller.enqueue(new Uint8Array(1_048_577));
        },
      });
      const transport = fetcher({
        search: Effect.sync(() => new Response(body, { headers: { 'content-type': 'application/json' } })),
      });
      const result = yield* proveSymmyStorefront(input, transport).pipe(Effect.flip);
      assert.equal(result.stage, 'search');
      assert.equal(result.reason, 'body-too-large');
      assert.equal(transport.calls.length, 1);
      assert.equal(cancellations, 1);
      assert.equal(body.locked, false);
    }),
  ));

await test('foreign failures are redacted, never retried, and cannot forge the proof failure class', () =>
  runtime.runPromise(
    Effect.gen(function* foreignFailures() {
      const privateMessage = 'private upstream credentials';
      yield* Effect.forEach(
        [
          new Error(privateMessage),
          Object.assign(new Error(privateMessage), {
            _tag: 'SymmyStorefrontProofFailure',
            reason: privateMessage,
            stage: 'private-stage',
          }),
        ],
        (foreignFailure) =>
          Effect.gen(function* foreignFailureCase() {
            let attempts = 0;
            const transport = fetcher({
              search: Effect.sync(() => {
                attempts += 1;
              }).pipe(Effect.andThen(Effect.fail(foreignFailure))),
            });
            const result = yield* proveSymmyStorefront(input, transport).pipe(Effect.flip);
            assert.ok(Schema.is(Schema.instanceOf(SymmyStorefrontProofFailure))(result));
            assert.equal(result.stage, 'search');
            assert.equal(result.reason, 'request-failed');
            assert.equal(attempts, 1);
          }),
        { concurrency: 1 },
      );
    }),
  ));

await test('mixed proof and help/version flags exit 1 without sending requests', () => {
  const observer = `import { mock } from 'node:test';
const fetch = mock.method(globalThis, 'fetch');
process.on('exit', () => process.stdout.write('requests=' + fetch.mock.callCount() + '\\n'));`;
  const proofArgs = ['--sku', 'X'];
  const builtInFlags = [
    '--help',
    '--no-help',
    '-h',
    '--help=true',
    '--version',
    '--no-version',
    '-v',
    '-V',
    '--version=true',
    '--wizard',
    '--no-wizard',
    '--completions=zsh',
    '--log-level=none',
  ];
  for (const args of [
    ...builtInFlags.map((flag) => [...proofArgs, flag]),
    ['--sku', '--help'],
    ['--help', ...proofArgs],
    [...proofArgs, '--', '--help'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(observer)}`,
        new URL('stage-symmy-storefront-proof.mts', import.meta.url).pathname,
        ...args,
      ],
      { encoding: 'utf-8', timeout: 30_000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout, /requests=0/u);
    assert.ok(result.stderr.includes('FAIL storefront-proof:configuration:invalid-input'), result.stderr);
  }
});

await test('standalone help succeeds without sending requests', () => {
  const observer = `import { mock } from 'node:test';
const fetch = mock.method(globalThis, 'fetch');
process.on('exit', () => process.stdout.write('requests=' + fetch.mock.callCount() + '\\n'));`;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(observer)}`,
      new URL('stage-symmy-storefront-proof.mts', import.meta.url).pathname,
      '--help',
    ],
    { encoding: 'utf-8', timeout: 30_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /requests=0/u);
  assert.match(result.stdout, /\busage\b/iu);
});

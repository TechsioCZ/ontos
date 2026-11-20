import { createRequire } from 'node:module';
import path from 'node:path';

import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { Config, Context, Deferred, Effect, FileSystem, Layer, Option, Result, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { CartQuoteSchema, CartQuoteRequestSchema } from '../../n1-storefront/src/ontos/cart-quote.ts';
import { CheckoutRequestSchema, CheckoutResultSchema } from '../../n1-storefront/src/ontos/checkout.ts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const scope = {
  currency: 'CZK',
  legalEntityId: '11111111-1111-4111-8111-111111111111',
  marketId: 'stage',
  tenantId: '22222222-2222-4222-8222-222222222222',
} satisfies (typeof CheckoutRequestSchema.Type)['scope'];
const CART_PATH = '/api/cart-quote';
const CHECKOUT_PATH = '/api/checkout';
const STATUS_PATH = '/api/checkout/status';
const CHECKOUT_PAGE = '/cs/pokladna';
const RESULT_FILE = 'result.json';
const ALL_UNKNOWN = 'all-unknown';
const UNKNOWN_FIRST = 'unknown-first';
const UNKNOWN_MISSING_ADD = 'unknown-missing-add';
const CART_SENTINEL_MODE = 'cart-sentinel';
const CHECKOUT_SENTINEL_MODE = 'checkout-sentinel';
const NO_PRICE = 'Cena není dostupná';
const ALL_NO_PRICE = 'all-no-price';
const ALL_BELOW_MINIMUM = 'all-below-minimum';
const NEGATIVE_QUOTE_LINE_TOTAL = 'negative-quote-line-total';
const malformedQuoteFields = new Map([
  ['missing-quote-status', 'status'],
  ['missing-quote-line-total', 'lineTotalMinor'],
  [NEGATIVE_QUOTE_LINE_TOTAL, 'lineTotalMinor'],
]);
const PRODUCT_CAP = 'product-cap';
const EXPECTED_TCP = 'Expected loopback TCP';
const SECOND_PRODUCT = '/cs/produkt/second';
const sentinel = 'UPSTREAM_PRIVATE_SENTINEL_DO_NOT_RETAIN';
const build = 'fixture-build';
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const document = (body: string) =>
  `<html lang="cs"><head><meta charset="utf-8"></head><body><main>${body}</main><script type="application/json">\\"b\\":\\"${build}\\"</script></body></html>`;
const product = (id: string) =>
  document(`
<div class="n1-product-stock-desktop">Skladem</div>
<input type="number" role="spinbutton" aria-valuemin="1" value="1">
<button id="add" data-purchase-disabled="false">Přidat do košíku</button><output id="added"></output>
<script>
add.onclick = () => {
  localStorage.setItem('n1-cart-v1:stage', JSON.stringify({ scope: ${json(scope)}, entries: [{
    productId: '${id}', variantId: 'blue', expectedUnitPriceMinor: 100, minimumQuantity: 1, quantity: 1
  }] }));
  added.textContent = 'Zboží je ve vašem košíku.';
};
</script>`);
const boundedCatalogue = (mode: string, url: URL): string | null => {
  if (mode === 'page-cap') {
    const index = Number(url.pathname.split('/').at(-1));
    return document(`<a href="/cs/kategorie/${Number.isInteger(index) ? index + 1 : 1}">Další</a>`);
  }
  if (mode !== PRODUCT_CAP) {
    return null;
  }
  if (url.pathname === '/cs') {
    return document(
      Array.from({ length: 26 }, (_, index) => `<a href="/cs/produkt/${index}">Produkt ${index}</a>`).join(''),
    );
  }
  return document(
    url.pathname.startsWith('/cs/produkt/')
      ? '<div class="n1-product-stock-desktop">Vyprodáno</div><button data-purchase-disabled="true" disabled>Vyprodáno</button>'
      : '',
  );
};
const unknownProduct = document(
  '<div class="n1-product-stock-desktop">Dostupnost nelze ověřit</div><button data-purchase-disabled="true" disabled>Přidat do košíku</button>',
);
const unavailableProduct = (label: string) =>
  document(`
<div class="n1-product-stock-desktop">Skladem</div><p>${label}</p>
<button data-purchase-disabled="true" disabled>Přidat do košíku</button>`);
const skippedFirst = new Map([
  [UNKNOWN_FIRST, unknownProduct],
  [ALL_UNKNOWN, unknownProduct],
  [UNKNOWN_MISSING_ADD, unknownProduct],
  ['no-price-first', unavailableProduct(NO_PRICE)],
  ['below-minimum-first', unavailableProduct('Skladem 2 ks, minimální odběr 5 ks')],
]);
const firstProduct = (mode: string) =>
  skippedFirst.get(mode) ??
  (mode === ALL_NO_PRICE || mode === ALL_BELOW_MINIMUM
    ? unavailableProduct(mode === ALL_NO_PRICE ? NO_PRICE : 'Minimální odběr 5 ks')
    : product('first'));
const selectedProduct = (mode: string) => {
  const html = product('second');
  const addMarkup = '<button id="add" data-purchase-disabled="false">';
  const disabled = html.replace(addMarkup, '<button id="add" data-purchase-disabled="false" disabled>');
  return (
    new Map([
      [ALL_UNKNOWN, unknownProduct],
      [
        UNKNOWN_MISSING_ADD,
        unknownProduct.replace('<button data-purchase-disabled="true" disabled>Přidat do košíku</button>', ''),
      ],
      ['limited', html.replace('Skladem', 'Poslední kusy 2 ks')],
      ['no-stock-label', html.replace('<div class="n1-product-stock-desktop">Skladem</div>', '')],
      ['dead-cart', html.replace('add.onclick = () => {', 'add.onclick = () => { return;')],
      [ALL_NO_PRICE, unavailableProduct(NO_PRICE)],
      [ALL_BELOW_MINIMUM, unavailableProduct('Skladem 2 ks, minimální odběr 5 ks')],
      ['dead-add', disabled],
      ['missing-add', html.replace(`${addMarkup}Přidat do košíku</button>`, '<span id="add"></span>')],
      ['duplicate-add', html.replace(addMarkup, `${addMarkup}Přidat do košíku</button>${addMarkup}`)],
      [
        'hydrating',
        disabled
          .replace('data-purchase-disabled="false"', 'data-purchase-disabled="pending"')
          .replace(
            '</script>',
            `fetch('/hydration-ready').then(() => { add.disabled = false; add.dataset.purchaseDisabled = 'false'; });</script>`,
          ),
      ],
    ]).get(mode) ?? html
  );
};
const cart = document(`
<button id="remove">Odebrat</button><a href="/cs/pokladna">Pokladna</a>
<script>
const cart = JSON.parse(localStorage.getItem('n1-cart-v1:stage'));
fetch(${json(CART_PATH)}, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ scope: cart.scope, lines: cart.entries, locale: 'cs' }) });
remove.onclick = () => { localStorage.removeItem('n1-cart-v1:stage'); remove.remove(); };
</script>`);
const checkout = document(`
<form id="form">
${['city', 'email', 'firstName', 'lastName', 'postalCode', 'street'].map((name) => `<input name="${name}">`).join('')}
<input type="radio" name="shippingMethod" value="ZASILKOVNA" disabled>
<input type="radio" name="shippingMethod" value="PPL">
<input type="radio" name="shippingMethod" value="OSOBNI_ODBER">
<button>Ověřit objednávku</button></form><div id="verified"></div>
<script>
const guardKey = 'n1-checkout-guard-v1:stage';
const showReceipt = (result) => {
  verified.innerHTML = '<h1>Objednávka byla přijata</h1><h2>Objednávka ' + result.orderNumber + '</h2>';
};
const recover = async (guard) => {
  const response = await fetch('${STATUS_PATH}', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientRequestId: guard.clientRequestId, scope: guard.scope }) });
  showReceipt((await response.json()).result);
};
const storedGuard = localStorage.getItem(guardKey);
if (storedGuard !== null) recover(JSON.parse(storedGuard));
addEventListener('storage', (event) => {
  if (event.key === guardKey && event.newValue !== null) recover(JSON.parse(event.newValue));
});
form.onsubmit = async (event) => {
  event.preventDefault();
  const cart = JSON.parse(localStorage.getItem('n1-cart-v1:stage'));
  const fields = Object.fromEntries(new FormData(form));
  const body = { scope: cart.scope, lines: cart.entries, locale: 'cs', mode: 'quote',
    clientRequestId: '33333333-3333-4333-8333-333333333333',
    shippingMethod: fields.shippingMethod, expectedShippingPriceMinor: 0,
    contact: { email: fields.email, firstName: fields.firstName, lastName: fields.lastName },
    address: { city: fields.city, postalCode: fields.postalCode, street: fields.street, countryCode: 'CZ' } };
  const response = await fetch('${CHECKOUT_PATH}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (result.outcome === 'VALID') {
    verified.innerHTML = '<button>Objednat</button>';
    verified.querySelector('button').onclick = async (event) => {
      event.currentTarget.disabled = true;
      const placed = await fetch('${CHECKOUT_PATH}', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, mode: 'place' })
      });
      const result = await placed.json();
      localStorage.setItem(guardKey, JSON.stringify({
        clientRequestId: body.clientRequestId, lines: body.lines, scope: body.scope
      }));
      showReceipt(result);
    };
  }
};
</script>`);
const checkoutFixture = (value: Schema.Json) => Schema.decodeUnknownSync(CheckoutResultSchema)(value);
const checkoutResponse = (value: Schema.Json) => HttpServerResponse.jsonUnsafe(checkoutFixture(value));
const corruptCheckoutResponse = (value: Schema.Json) => {
  expect(() => checkoutFixture(value)).toThrow();
  return HttpServerResponse.jsonUnsafe(value);
};
const quoteResponse = (input: typeof CheckoutRequestSchema.Type, mode: string) => {
  const rejected = input.shippingMethod === 'PPL';
  const value = {
    issues: rejected ? [{ code: 'NOT_AVAILABLE' }] : [],
    lines: rejected
      ? []
      : [
          {
            lineTotalMinor: 100,
            name: 'Fixture',
            productId: 'second',
            quantity: 1,
            sku: 'fixture',
            unitPriceMinor: 100,
            variantId: 'blue',
          },
        ],
    orderId: null,
    orderNumber: null,
    outcome: rejected ? 'REJECTED' : 'VALID',
    scope,
    shippingPriceMinor: rejected ? null : 0,
    status: null,
    totalMinor: rejected ? null : 100,
    totalVatMinor: rejected ? null : 17,
  } satisfies typeof CheckoutResultSchema.Encoded;
  const fixture = checkoutFixture(value);
  if (!rejected && malformedQuoteFields.has(mode)) {
    const field = malformedQuoteFields.get(mode);
    const malformed =
      field === 'status'
        ? Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== field))
        : {
            ...fixture,
            lines: fixture.lines.map((line) =>
              mode === NEGATIVE_QUOTE_LINE_TOTAL
                ? { ...line, lineTotalMinor: -1 }
                : Object.fromEntries(Object.entries(line).filter(([key]) => key !== field)),
            ),
          };
    // Deliberate wire corruption starts from a decoded fixture, never an unchecked success payload.
    return corruptCheckoutResponse(malformed);
  }
  return checkoutResponse(fixture);
};
const checkoutDocument = (mode: string) =>
  mode === 'no-shipping' ? checkout.replaceAll(/<input type="radio"[^>]*>/gu, '') : checkout;
const probe = path.resolve(import.meta.dirname, '../ops/stage-n1-checkout.mts');
const playwrightModule = createRequire(new URL('../../apps/shell-super-app/package.json', import.meta.url)).resolve(
  '@playwright/test',
);

it('rejects checkout fixture drift before serving it', () => {
  expect(() => checkoutResponse({ outcome: 'VALID' })).toThrow();
});

it.effect('fails loudly with only an allowlisted category when Chromium is missing', () =>
  Effect.gen(function* missingCheckoutBrowser() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const result = yield* collectToolingProcess(
      ChildProcess.make('node', [probe, 'quote', '--origin', 'http://127.0.0.1:1', '--out', directory], {
        cwd: path.resolve(import.meta.dirname, '../..'),
        env: {
          E2E_PLAYWRIGHT_MODULE: playwrightModule,
          PLAYWRIGHT_BROWSERS_PATH: path.join(directory, sentinel),
        },
        extendEnv: true,
      }),
    );
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(1);
    expect(output).toContain('Checkout proof failed: browser could not start');
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('Executable doesn');
    expect(yield* fs.readDirectory(directory)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const scenario of [
  { mode: 'sequence', status: 0 },
  { mode: UNKNOWN_FIRST, status: 0 },
  { mode: ALL_UNKNOWN, status: 3 },
  { mode: UNKNOWN_MISSING_ADD, status: 1 },
  { mode: 'limited', status: 0 },
  { mode: 'no-stock-label', status: 0 },
  { mode: 'no-price-first', status: 0 },
  { mode: 'below-minimum-first', status: 0 },
  { mode: ALL_NO_PRICE, status: 3 },
  { mode: ALL_BELOW_MINIMUM, status: 3 },
  { mode: 'dead-cart', status: 1 },
  { mode: 'missing-quote-status', status: 1 },
  { mode: 'missing-quote-line-total', status: 1 },
  { mode: NEGATIVE_QUOTE_LINE_TOTAL, status: 1 },
  { mode: 'empty', status: 3 },
  { mode: 'all-rejected', status: 3 },
  { mode: CART_SENTINEL_MODE, status: 1 },
  { mode: CHECKOUT_SENTINEL_MODE, status: 1 },
  { mode: 'mismatch', status: 1 },
  { mode: 'kept', status: 0 },
  { mode: 'page-cap', status: 3 },
  { mode: PRODUCT_CAP, status: 3 },
  { mode: 'dead-add', status: 1 },
  { mode: 'missing-add', status: 1 },
  { mode: 'duplicate-add', status: 1 },
  { mode: 'hydrating', status: 0 },
  { mode: 'no-shipping', status: 1 },
]) {
  it.effect(`drives the real probe over local HTTP: ${scenario.mode}`, () =>
    Effect.gen(function* localCheckoutProbe() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const posts: { path: string; selection: string }[] = [];
      const visited: string[] = [];
      const application = Effect.gen(function* checkoutFixtureHttp() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, 'http://localhost');
        if (request.method === 'POST') {
          const body = yield* request.json;
          if (url.pathname === CART_PATH) {
            const input = yield* Schema.decodeUnknownEffect(CartQuoteRequestSchema)(body);
            const id = input.lines.map((line) => line.productId).join(',');
            posts.push({ path: url.pathname, selection: id });
            if (scenario.mode === CART_SENTINEL_MODE) {
              return HttpServerResponse.text(sentinel, { status: 502 });
            }
            const rejected = id === 'first' || scenario.mode === 'all-rejected';
            const value = {
              issues: rejected ? [{ code: 'NOT_AVAILABLE' }] : [],
              outcome: rejected ? 'REJECTED' : 'VALID',
              scope,
              totalMinor: rejected ? null : 100,
              totalVatMinor: rejected ? null : 17,
            };
            return HttpServerResponse.text(Schema.encodeUnknownSync(Schema.fromJsonString(CartQuoteSchema))(value), {
              contentType: 'application/json',
            });
          }
          const input = yield* Schema.decodeUnknownEffect(CheckoutRequestSchema)(body);
          posts.push({ path: url.pathname, selection: input.shippingMethod });
          expect(input.mode).toBe('quote');
          if (scenario.mode === CHECKOUT_SENTINEL_MODE) {
            return corruptCheckoutResponse({ unexpected: sentinel });
          }
          return quoteResponse(input, scenario.mode);
        }
        visited.push(url.pathname);
        const bounded = boundedCatalogue(scenario.mode, url);
        if (bounded !== null) {
          return HttpServerResponse.html(bounded);
        }
        const documents = new Map([
          ['/cs', document('<a href="/cs/produkt/first">První</a><a href="/cs/kategorie/all">Kategorie</a>')],
          ['/cs/kategorie/all', document('<a href="/cs/produkt/second">Druhý</a>')],
          ['/cs/produkt/first', firstProduct(scenario.mode)],
          [
            SECOND_PRODUCT,
            url.searchParams.has('variantId')
              ? selectedProduct(scenario.mode)
              : document(
                  '<button data-purchase-disabled="true" disabled>Vyberte variantu</button><a href="/cs/produkt/second?variantId=blue">Modrá</a>',
                ),
          ],
          ['/cs/kosik', cart],
          [CHECKOUT_PAGE, checkoutDocument(scenario.mode)],
        ]);
        const html = scenario.mode === 'empty' ? document('') : (documents.get(url.pathname) ?? document(''));
        return HttpServerResponse.html(html);
      }).pipe(Effect.orDie);
      const context = yield* Layer.build(
        HttpServer.serve(application).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const { address } = Context.get(context, HttpServer.HttpServer);
      if (NetAddress.isUnixPathAddress(address)) {
        return yield* Effect.die(EXPECTED_TCP);
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const args = [probe, 'quote', '--origin', origin, '--out', directory];
      if (scenario.mode !== 'kept') {
        args.push('--expect-build-id', scenario.mode === 'mismatch' ? 'wrong-build' : build);
      }
      const result = yield* collectToolingProcess(
        ChildProcess.make('node', args, {
          cwd: path.resolve(import.meta.dirname, '../..'),
          env: { E2E_PLAYWRIGHT_MODULE: playwrightModule },
          extendEnv: true,
        }),
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(scenario.status);
      const files = yield* fs.readDirectory(directory);
      expect(files).not.toContain('placement-storage.json');
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(sentinel);
      const contents = yield* Effect.all(files.map((name) => fs.readFileString(path.join(directory, name))));
      expect(contents.join('\n')).not.toContain(sentinel);
      const summary = yield* fs.readFileString(path.join(directory, RESULT_FILE));
      if (scenario.status === 0) {
        expect(summary).toContain('"state":"passed"');
        expect(summary).toContain(scenario.mode === 'kept' ? 'currently-served-n1-build' : 'packaged-n1-build');
        expect(posts).toEqual([
          ...(skippedFirst.has(scenario.mode) ? [] : [{ path: CART_PATH, selection: 'first' }]),
          { path: CART_PATH, selection: 'second' },
          { path: CHECKOUT_PATH, selection: 'PPL' },
          { path: CHECKOUT_PATH, selection: 'OSOBNI_ODBER' },
        ]);
      } else if (scenario.status === 3) {
        expect(summary).toContain('no-purchasable-fixture');
        expect(`${result.stdout}\n${result.stderr}`).toContain('NO_PURCHASABLE_FIXTURE');
      } else {
        expect(summary).toContain('quote-broken');
      }
      const missingField = malformedQuoteFields.get(scenario.mode);
      if (missingField !== undefined) {
        const fieldPath = missingField === 'status' ? missingField : `lines.0.${missingField}`;
        expect(contents.join('\n')).toContain(`Invalid checkout field: ${fieldPath}`);
      }
      if (scenario.mode === CART_SENTINEL_MODE) {
        expect(posts).toEqual([{ path: CART_PATH, selection: 'first' }]);
      }
      if (scenario.mode === CHECKOUT_SENTINEL_MODE) {
        expect(posts).toEqual([
          { path: CART_PATH, selection: 'first' },
          { path: CART_PATH, selection: 'second' },
          { path: CHECKOUT_PATH, selection: 'PPL' },
        ]);
      }
      if (scenario.mode === 'mismatch') {
        expect(posts).toEqual([]);
      }
      if (skippedFirst.has(scenario.mode) && scenario.status === 0) {
        expect(visited).toContain('/cs/produkt/first');
        expect(visited).toContain(SECOND_PRODUCT);
      }
      if ([ALL_UNKNOWN, UNKNOWN_MISSING_ADD].includes(scenario.mode)) {
        expect(posts).toEqual([]);
      }
      if (scenario.mode === 'page-cap') {
        expect(visited.filter((pathname) => pathname !== '/cs')).toHaveLength(50);
        expect(posts).toEqual([]);
      }
      if (scenario.mode === PRODUCT_CAP) {
        expect(visited.filter((pathname) => pathname.startsWith('/cs/produkt/'))).toHaveLength(25);
        expect(posts).toEqual([]);
      }
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.live('exits with an allowlisted deadline verdict when the local server never answers', () =>
  Effect.gen(function* checkoutDeadline() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const release = yield* Deferred.make<boolean>();
    const context = yield* Layer.build(
      HttpServer.serve(Deferred.await(release).pipe(Effect.as(HttpServerResponse.empty()))).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const { address } = Context.get(context, HttpServer.HttpServer);
    if (NetAddress.isUnixPathAddress(address)) {
      return yield* Effect.die(EXPECTED_TCP);
    }
    const result = yield* collectToolingProcess(
      ChildProcess.make(
        'node',
        [probe, 'quote', '--origin', `http://127.0.0.1:${address.port}`, '--out', directory, '--budget-ms', '1000'],
        {
          env: { E2E_PLAYWRIGHT_MODULE: playwrightModule },
          extendEnv: true,
        },
      ),
    );
    yield* Deferred.succeed(release, true);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(4);
    expect(result.stdout).toContain('"state":"deadline"');
    expect(result.stderr).not.toContain('TimeoutError');
    expect(yield* fs.readFileString(path.join(directory, RESULT_FILE))).toBe('{"mode":"quote","state":"deadline"}');
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('retains only cleanup identifiers before sending a place request that never gets a response', () =>
  Effect.gen(function* killedPlacement() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const sent = yield* Deferred.make<typeof CheckoutRequestSchema.Type>();
    const release = yield* Deferred.make<boolean>();
    const browserPath = yield* Config.String('PLAYWRIGHT_BROWSERS_PATH').pipe(Config.option);
    const application = Effect.gen(function* stalledPlacementHttp() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method === 'POST') {
        if (request.url === CART_PATH) {
          return HttpServerResponse.jsonUnsafe({
            issues: [],
            outcome: 'VALID',
            scope,
            totalMinor: 100,
            totalVatMinor: 17,
          });
        }
        const input = yield* Schema.decodeUnknownEffect(CheckoutRequestSchema)(yield* request.json);
        if (input.mode === 'place') {
          yield* Deferred.succeed(sent, input);
          return yield* Deferred.await(release).pipe(Effect.as(HttpServerResponse.empty()));
        }
        return checkoutResponse({
          issues: [],
          lines: [
            {
              lineTotalMinor: 100,
              name: 'Fixture',
              productId: 'second',
              quantity: 1,
              sku: 'fixture',
              unitPriceMinor: 100,
              variantId: 'blue',
            },
          ],
          orderId: null,
          orderNumber: null,
          outcome: 'VALID',
          scope,
          shippingPriceMinor: 0,
          status: null,
          totalMinor: 100,
          totalVatMinor: 17,
        });
      }
      const documents = new Map([
        ['/cs', document('<a href="/cs/produkt/second">Produkt</a>')],
        [SECOND_PRODUCT, product('second')],
        ['/cs/kosik', cart],
        [CHECKOUT_PAGE, checkout],
      ]);
      return HttpServerResponse.html(documents.get(request.url) ?? document(''));
    }).pipe(Effect.orDie);
    const context = yield* Layer.build(
      HttpServer.serve(application).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
    );
    const { address } = Context.get(context, HttpServer.HttpServer);
    if (NetAddress.isUnixPathAddress(address)) {
      return yield* Effect.die(EXPECTED_TCP);
    }
    const child = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
      ChildProcess.make(
        'node',
        [probe, 'place', '--i-will-clean-up', '--origin', `http://127.0.0.1:${address.port}`, '--out', directory],
        {
          env: {
            ...Option.match(browserPath, {
              onNone: () => ({}),
              onSome: (value) => ({ PLAYWRIGHT_BROWSERS_PATH: value }),
            }),
            E2E_PLAYWRIGHT_MODULE: playwrightModule,
            HOME: yield* Config.String('HOME'),
            PATH: yield* Config.String('PATH'),
          },
        },
      ),
    );
    const input = yield* Deferred.await(sent);
    // Arrival at the server proves the pre-dispatch write must already be on disk; no polling or delay.
    const record = yield* fs.readFileString(path.join(directory, 'place-requests.jsonl')).pipe(Effect.result);
    yield* child.kill({ killSignal: 'SIGKILL' });
    yield* Deferred.succeed(release, true);
    const text = Result.getOrThrow(record);
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text.trim())).toEqual({
      clientRequestId: input.clientRequestId,
      lines: input.lines,
      scope: input.scope,
    });
    expect(text).not.toMatch(/TEST|example.invalid|contact|address|localStorage/u);
    expect(yield* fs.exists(path.join(directory, 'place-responses.jsonl'))).toBe(false);
    return yield* Effect.void;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const journalWritable of [true, false]) {
  it.live(
    `persists the placement verdict and identity when the response journal is ${journalWritable ? 'writable' : 'unwritable'}`,
    () =>
      Effect.gen(function* placementJournalVerdict() {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped();
        const journal = path.join(directory, 'place-responses.jsonl');
        if (!journalWritable) {
          yield* fs.makeDirectory(journal);
        }
        const placements: (typeof CheckoutRequestSchema.Type)[] = [];
        const recoveries: unknown[] = [];
        const placed = {
          issues: [],
          lines: [
            {
              lineTotalMinor: 100,
              name: 'Fixture',
              productId: 'second',
              quantity: 1,
              sku: 'fixture',
              unitPriceMinor: 100,
              variantId: 'blue',
            },
          ],
          orderId: 'fixture-order',
          orderNumber: 'TEST-001',
          outcome: 'PLACED',
          scope,
          shippingPriceMinor: 0,
          status: 'CONFIRMED',
          totalMinor: 100,
          totalVatMinor: 17,
        };
        const browserPath = yield* Config.String('PLAYWRIGHT_BROWSERS_PATH').pipe(Config.option);
        const application = Effect.gen(function* placementJournalHttp() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method === 'POST') {
            const body = yield* request.json;
            if (request.url === CART_PATH) {
              return HttpServerResponse.jsonUnsafe({
                issues: [],
                outcome: 'VALID',
                scope,
                totalMinor: 100,
                totalVatMinor: 17,
              });
            }
            if (request.url === STATUS_PATH) {
              recoveries.push(body);
              return HttpServerResponse.jsonUnsafe({ result: checkoutFixture(placed), state: 'confirmed' });
            }
            const input = yield* Schema.decodeUnknownEffect(CheckoutRequestSchema)(body);
            if (input.mode === 'place') {
              placements.push(input);
              return checkoutResponse(placed);
            }
            return checkoutResponse({
              ...placed,
              orderId: null,
              orderNumber: null,
              outcome: 'VALID',
            });
          }
          const documents = new Map([
            ['/cs', document('<a href="/cs/produkt/second">Produkt</a>')],
            [SECOND_PRODUCT, product('second')],
            ['/cs/kosik', cart],
            [CHECKOUT_PAGE, checkout],
          ]);
          return HttpServerResponse.html(documents.get(request.url) ?? document(''));
        }).pipe(Effect.orDie);
        const context = yield* Layer.build(
          HttpServer.serve(application).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
        );
        const { address } = Context.get(context, HttpServer.HttpServer);
        if (NetAddress.isUnixPathAddress(address)) {
          return yield* Effect.die(EXPECTED_TCP);
        }
        const result = yield* collectToolingProcess(
          ChildProcess.make(
            'node',
            [probe, 'place', '--i-will-clean-up', '--origin', `http://127.0.0.1:${address.port}`, '--out', directory],
            {
              env: {
                ...Option.match(browserPath, {
                  onNone: () => ({}),
                  onSome: (value) => ({ PLAYWRIGHT_BROWSERS_PATH: value }),
                }),
                E2E_PLAYWRIGHT_MODULE: playwrightModule,
                HOME: yield* Config.String('HOME'),
                PATH: yield* Config.String('PATH'),
              },
            },
          ),
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(journalWritable ? 0 : 1);
        const summary = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
          yield* fs.readFileString(path.join(directory, RESULT_FILE)),
        );
        expect(placements).toHaveLength(1);
        const [input] = placements;
        expect(input).toBeDefined();
        expect(summary).toMatchObject({
          clientRequestId: input?.clientRequestId,
          mode: 'place',
          orderId: placed.orderId,
          orderNumber: placed.orderNumber,
          scope,
          state: journalWritable ? 'passed-cleanup-required' : 'failed-cleanup-required',
        });
        expect(recoveries.length).toBeGreaterThanOrEqual(2);
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
            (yield* fs.readFileString(path.join(directory, 'place-requests.jsonl'))).trim(),
          ),
        ).toEqual({ clientRequestId: input?.clientRequestId, lines: input?.lines, scope });
        if (journalWritable) {
          expect(
            Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))((yield* fs.readFileString(journal)).trim()),
          ).toEqual({
            clientRequestId: input?.clientRequestId,
            orderId: placed.orderId,
            orderNumber: placed.orderNumber,
          });
        } else {
          expect(yield* fs.readDirectory(journal)).toEqual([]);
          expect(result.stdout).toContain('"state":"failed-cleanup-required"');
          expect(result.stdout).not.toContain('"state":"passed-cleanup-required"');
        }
        return yield* Effect.void;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

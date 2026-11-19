import { createRequire } from 'node:module';
import path from 'node:path';

import { NodeHttpServer, NodeServices } from '@effect/platform-node';
import { Context, Effect, FileSystem, Layer, Schema } from 'effect';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { CartQuoteSchema, CartQuoteRequestSchema } from '../../n1-storefront/src/ontos/cart-quote.ts';
import { CheckoutRequestSchema, CheckoutResultSchema } from '../../n1-storefront/src/ontos/checkout.ts';
import { collectToolingProcess } from './tooling-process-fixture.mts';

const scope = {
  currency: 'CZK',
  legalEntityId: '11111111-1111-4111-8111-111111111111',
  marketId: 'stage',
  tenantId: '22222222-2222-4222-8222-222222222222',
};
const CART_PATH = '/api/cart-quote';
const CHECKOUT_PATH = '/api/checkout';
const CART_SENTINEL_MODE = 'cart-sentinel';
const CHECKOUT_SENTINEL_MODE = 'checkout-sentinel';
const sentinel = 'UPSTREAM_PRIVATE_SENTINEL_DO_NOT_RETAIN';
const build = 'fixture-build';
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const document = (body: string) =>
  `<html lang="cs"><head><meta charset="utf-8"></head><body><main>${body}</main><script type="application/json">\\"b\\":\\"${build}\\"</script></body></html>`;
const product = (id: string) =>
  document(`
<input type="number" role="spinbutton" aria-valuemin="1" value="1">
<button id="add">Přidat do košíku</button><output id="added"></output>
<script>
add.onclick = () => {
  localStorage.setItem('n1-cart-v1:stage', JSON.stringify({ scope: ${json(scope)}, entries: [{
    productId: '${id}', variantId: 'blue', expectedUnitPriceMinor: 100, minimumQuantity: 1, quantity: 1
  }] }));
  added.textContent = 'Zboží je ve vašem košíku.';
};
</script>`);
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
  if (result.outcome === 'VALID') verified.innerHTML = '<button>Objednat</button>';
};
</script>`);
const probe = path.resolve(import.meta.dirname, '../ops/stage-n1-checkout.mts');
const playwrightModule = createRequire(new URL('../../apps/shell-super-app/package.json', import.meta.url)).resolve(
  '@playwright/test',
);

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
  { mode: 'empty', status: 3 },
  { mode: 'all-rejected', status: 3 },
  { mode: CART_SENTINEL_MODE, status: 1 },
  { mode: CHECKOUT_SENTINEL_MODE, status: 1 },
  { mode: 'mismatch', status: 1 },
  { mode: 'kept', status: 0 },
]) {
  it.effect(`drives the real probe over local HTTP: ${scenario.mode}`, () =>
    Effect.gen(function* localCheckoutProbe() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const posts: { path: string; selection: string }[] = [];
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
            return HttpServerResponse.text(json({ unexpected: sentinel }), { contentType: 'application/json' });
          }
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
          };
          return HttpServerResponse.text(Schema.encodeUnknownSync(Schema.fromJsonString(CheckoutResultSchema))(value), {
            contentType: 'application/json',
          });
        }
        const documents = new Map([
          ['/cs', document('<a href="/cs/produkt/first">První</a><a href="/cs/kategorie/all">Kategorie</a>')],
          ['/cs/kategorie/all', document('<a href="/cs/produkt/second">Druhý</a>')],
          ['/cs/produkt/first', product('first')],
          [
            '/cs/produkt/second',
            url.searchParams.has('variantId')
              ? product('second')
              : document('<a href="/cs/produkt/second?variantId=blue">Modrá</a>'),
          ],
          ['/cs/kosik', cart],
          ['/cs/pokladna', checkout],
        ]);
        const html = scenario.mode === 'empty' ? document('') : (documents.get(url.pathname) ?? document(''));
        return HttpServerResponse.html(html);
      }).pipe(Effect.orDie);
      const context = yield* Layer.build(
        HttpServer.serve(application).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      );
      const { address } = Context.get(context, HttpServer.HttpServer);
      if (NetAddress.isUnixPathAddress(address)) {
        return yield* Effect.die('Expected loopback TCP');
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
      const summary = yield* fs.readFileString(path.join(directory, 'result.json'));
      if (scenario.status === 0) {
        expect(summary).toContain('"state":"passed"');
        expect(summary).toContain(scenario.mode === 'kept' ? 'currently-served-n1-build' : 'packaged-n1-build');
        expect(posts).toEqual([
          { path: CART_PATH, selection: 'first' },
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
      return yield* Effect.void;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

#!/usr/bin/env node
/** Live guest checkout proof. Quote is deploy-safe; place creates stock-debiting orders requiring staff cleanup. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import {
  Clock,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Result as ParseResult,
  Schema,
  Runtime,
} from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import type { Browser, BrowserType, Page, Response } from 'playwright-core';

const CHECKOUT_PATH = '/api/checkout';
const STATUS_PATH = '/api/checkout/status';
const RESULT_FILE = 'result.json';
const RECEIPT_HEADING = 'Objednávka byla přijata';
const endpoint = (response: Response, pathname: string) =>
  new URL(response.url()).pathname === pathname && response.request().method() === 'POST';
const checkoutEndpoint = (response: Response) => endpoint(response, CHECKOUT_PATH);
const CART_PATH = '/api/cart-quote';
const cartEndpoint = (response: Response) => endpoint(response, CART_PATH);
const statusEndpoint = (response: Response) => endpoint(response, STATUS_PATH);
const DEFAULT_ORIGIN = 'https://ontos-stage-n1.web-revolution.cz';
const NO_FIXTURE = 'no-purchasable-fixture';
const PROOF_FAILED = 'Checkout proof failed; see allowlisted result.json';
const Scope = Schema.Struct({
  currency: Schema.String,
  legalEntityId: Schema.String.pipe(Schema.brand('legalEntityId')),
  marketId: Schema.String.pipe(Schema.brand('marketId')),
  tenantId: Schema.String.pipe(Schema.brand('tenantId')),
});
const Line = Schema.Struct({
  expectedUnitPriceMinor: Schema.Int,
  productId: Schema.String.pipe(Schema.brand('productId')),
  quantity: Schema.Finite,
  variantId: Schema.optionalKey(Schema.String.pipe(Schema.brand('variantId'))),
});
const Intent = Schema.Struct({
  clientRequestId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('clientRequestId')),
  lines: Schema.Array(Line),
  scope: Scope,
});
const Request = Schema.Struct({
  ...Intent.fields,
  expectedShippingPriceMinor: Schema.Int,
  mode: Schema.Literals(['quote', 'place']),
  shippingMethod: Schema.String,
});
const ResultLine = Schema.Struct({
  productId: Schema.String.pipe(Schema.brand('productId')),
  quantity: Schema.Finite,
  unitPriceMinor: Schema.Int,
  variantId: Schema.optionalKey(Schema.String.pipe(Schema.brand('variantId'))),
});
const Issues = Schema.Array(Schema.Struct({ code: Schema.String }));
const Amounts = Schema.Struct({
  issues: Issues,
  outcome: Schema.Literals(['VALID', 'REJECTED']),
  scope: Scope,
  totalMinor: Schema.Int,
  totalVatMinor: Schema.Int,
});
const CartResponse = Schema.Struct({
  ...Amounts.fields,
  totalMinor: Schema.Union([Schema.Int, Schema.Null]),
  totalVatMinor: Schema.Union([Schema.Int, Schema.Null]),
});
const Result = Schema.Struct({
  ...Amounts.fields,
  lines: Schema.Array(ResultLine),
  orderId: Schema.Union([Schema.String.pipe(Schema.brand('orderId')), Schema.Null]),
  orderNumber: Schema.Union([Schema.String, Schema.Null]),
  outcome: Schema.Literals(['VALID', 'REJECTED', 'PLACED', 'REPLAYED']),
  shippingPriceMinor: Schema.Int,
});
const CheckoutResponse = Schema.Struct({
  ...Result.fields,
  shippingPriceMinor: Schema.Union([Schema.Int, Schema.Null]),
  totalMinor: Schema.Union([Schema.Int, Schema.Null]),
  totalVatMinor: Schema.Union([Schema.Int, Schema.Null]),
});
const Recovery = Schema.Struct({ result: Result, state: Schema.Literal('confirmed') });
const Cart = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ ...Line.fields, minimumQuantity: Schema.Finite })),
  scope: Scope,
});
const Launcher = Schema.Struct({
  chromium: Schema.Struct({
    launch: Schema.declare<BrowserType['launch']>((value): value is BrowserType['launch'] =>
      Predicate.isFunction(value),
    ),
  }),
});
class CheckoutProofFailure extends Schema.TaggedError<CheckoutProofFailure>()('CheckoutProofFailure', {
  cause: Schema.String,
  code: Schema.Int,
}) {
  get [Runtime.errorExitCode]() {
    return this.code;
  }
}
const issueCodes = new Set([
  'NOT_FOUND',
  'NOT_AVAILABLE',
  'VARIANT_REQUIRED',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'AVAILABILITY_UNKNOWN',
  'MINIMUM_QUANTITY',
  'PACKAGE_QUANTITY',
  'PRICE_CHANGED',
  'PRICE_UNAVAILABLE',
  'SHIPPING_PRICE_CHANGED',
  'MARKET_UNAVAILABLE',
  'NOT_OFFERED_IN_MARKET',
]);
type Save = (name: string, value: Schema.Json) => void;
interface Selection {
  amounts: typeof Amounts.Type;
  cart: typeof Cart.Type;
}
interface Quote {
  request: typeof Request.Type;
  result: typeof Result.Type;
}
type Fixture = Selection & { quote: Quote };
const evidence = (value: typeof CheckoutResponse.Type | typeof CartResponse.Type) => ({
  issueCodes: value.issues.map(({ code }) => (issueCodes.has(code) ? code : 'UNKNOWN_ISSUE')),
  outcome: value.outcome,
  totalMinor: value.totalMinor,
  totalVatMinor: value.totalVatMinor,
});
const readCart = (body: string) => {
  const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(CartResponse))(body);
  assert.ok(ParseResult.isSuccess(decoded), 'Invalid cart quote contract');
  return decoded.success;
};
const readCheckout = (body: string) => {
  const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(CheckoutResponse))(body);
  assert.ok(ParseResult.isSuccess(decoded), 'Invalid checkout contract');
  return decoded.success;
};
const recognizedRejection = (issues: typeof Issues.Type) =>
  assert.ok(issues.length > 0 && issues.every(({ code }) => issueCodes.has(code)), 'Unrecognized business rejection');
const documentLinks = (links: Element[]) =>
  links.flatMap((link) => {
    const href = link.getAttribute('href');
    return href === null ? [] : [href];
  });
const requestLine = ({ expectedUnitPriceMinor, productId, quantity, variantId }: typeof Line.Type) =>
  variantId === undefined
    ? { expectedUnitPriceMinor, productId, quantity }
    : { expectedUnitPriceMinor, productId, quantity, variantId };
const resultLine = ({ productId, quantity, unitPriceMinor, variantId }: typeof ResultLine.Type) =>
  requestLine({ expectedUnitPriceMinor: unitPriceMinor, productId, quantity, variantId });
const validateQuote = (quote: Quote, selection: Selection, shippingMethod: string) => {
  const { request, result } = quote;
  const { amounts, cart } = selection;
  assert.equal(request.mode, 'quote');
  assert.equal(request.shippingMethod, shippingMethod);
  assert.equal(result.outcome, 'VALID');
  assert.deepEqual(result.issues, []);
  assert.equal(result.orderId, null);
  assert.equal(result.orderNumber, null);
  assert.deepEqual(request.scope, cart.scope);
  assert.deepEqual(result.scope, cart.scope);
  assert.deepEqual(request.lines, cart.entries.map(requestLine));
  assert.deepEqual(result.lines.map(resultLine), request.lines);
  assert.equal(result.shippingPriceMinor, request.expectedShippingPriceMinor);
  assert.equal(result.totalMinor, amounts.totalMinor + request.expectedShippingPriceMinor);
  assert.ok(result.totalVatMinor >= amounts.totalVatMinor && result.totalVatMinor <= result.totalMinor);
};
const readBrowserCarts = () =>
  Object.keys(localStorage)
    .filter((key) => key.startsWith('n1-cart-v1:'))
    .map((key) => localStorage.getItem(key));
const readBrowserGuards = () =>
  Object.keys(localStorage)
    .filter((key) => key.startsWith('n1-checkout-guard-v1:'))
    .map((key) => localStorage.getItem(key));
const browserProof = ({
  artifacts,
  browser,
  expectedBuild,
  mode,
  observedAt,
  origin,
}: {
  artifacts: Map<string, string>;
  browser: Browser;
  expectedBuild: Option.Option<string>;
  mode: 'quote' | 'place';
  observedAt: number;
  origin: string;
}) => {
  const save: Save = (name, value) => {
    artifacts.set(name, ParseResult.getOrThrow(Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Json))(value)));
  };
  return Effect.tryPromise({
    catch: () => new CheckoutProofFailure({ cause: PROOF_FAILED, code: 1 }),
    try: async () => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { height: 1000, width: 1440 } });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      page.setDefaultNavigationTimeout(60_000);
      let phase = 'home';
      const captureNetwork = async () => {
        const requests: { mode: string; path: string }[] = [];
        const responses: Schema.JsonObject[] = [];
        const blocked: string[] = [];
        const pending: Promise<void>[] = [];
        // Safety fence only: allowed exchanges reach the real server without replacement.
        await context.route('**/*', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (request.method() === 'GET' || request.method() === 'HEAD') {
            await route.continue();
            return;
          }
          const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Request))(request.postData());
          const requestMode = ParseResult.isSuccess(decoded) ? decoded.success.mode : 'read';
          const allowed =
            url.origin === origin &&
            request.method() === 'POST' &&
            (url.pathname === CART_PATH ||
              (url.pathname === STATUS_PATH && mode === 'place') ||
              (url.pathname === CHECKOUT_PATH && (requestMode === 'quote' || requestMode === mode)));
          if (!allowed) {
            blocked.push('unexpected-write');
            await route.abort('blockedbyclient');
            return;
          }
          requests.push({ mode: requestMode, path: url.pathname });
          if (requestMode === 'place' && ParseResult.isSuccess(decoded)) {
            // Cleanup identity only; never persist a browser session, address, contact or whole request.
            save('place-request.json', {
              clientRequestId: decoded.success.clientRequestId,
              scope: decoded.success.scope,
            });
          }
          await route.continue();
        });
        context.on('response', (response) => {
          const url = new URL(response.url());
          if (
            url.origin !== origin ||
            !endpoint(response, url.pathname) ||
            ![CART_PATH, CHECKOUT_PATH, STATUS_PATH].includes(url.pathname)
          ) {
            return;
          }
          pending.push(
            (async () => {
              const metadata = { path: url.pathname, status: response.status() };
              try {
                const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(CartResponse))(await response.text());
                responses.push(
                  ParseResult.isSuccess(decoded) ? { ...metadata, ...evidence(decoded.success) } : metadata,
                );
              } catch {
                responses.push(metadata);
              }
            })(),
          );
        });
        return { blocked, pending, requests, responses };
      };

      const fillAndQuote = async (tab: Page, selection: Selection): Promise<Option.Option<Quote>> => {
        assert.equal(tab.context(), context, 'Quote must use the isolated proof context');
        await tab.locator('input[name="city"]').fill('TEST Praha');
        await tab.locator('input[name="email"]').fill('stage-checkout@example.invalid');
        await tab.locator('input[name="firstName"]').fill('TEST ověření');
        await tab.locator('input[name="lastName"]').fill('pokladny (smazat)');
        await tab.locator('input[name="postalCode"]').fill('11000');
        await tab.locator('input[name="street"]').fill('TEST neodesílat 1');
        const methods = tab.locator('input[name="shippingMethod"]:enabled');
        const choose = async (index: number): Promise<Option.Option<Quote>> => {
          if (index >= (await methods.count())) {
            return Option.none();
          }
          const shipping = methods.nth(index);
          await shipping.check({ force: true });
          const shippingMethod = await shipping.inputValue();
          const pending = tab.waitForResponse(checkoutEndpoint);
          await tab.getByRole('button', { exact: true, name: 'Ověřit objednávku' }).click();
          const response = await pending;
          save('quote-response.json', { status: response.status() });
          assert.ok(response.ok(), 'Checkout quote HTTP failure');
          const result = readCheckout(await response.text());
          save('quote-response.json', { status: response.status(), ...evidence(result) });
          if (result.outcome === 'REJECTED') {
            recognizedRejection(result.issues);
            return await choose(index + 1);
          }
          const quote = {
            request: ParseResult.getOrThrow(Schema.decodeUnknownResult(Request)(response.request().postDataJSON())),
            result: ParseResult.getOrThrow(Schema.decodeUnknownResult(Result)(result)),
          };
          save('quote-request.json', {
            expectedShippingPriceMinor: quote.request.expectedShippingPriceMinor,
            mode: quote.request.mode,
          });
          validateQuote(quote, selection, shippingMethod);
          await tab.getByRole('button', { exact: true, name: 'Objednat' }).waitFor();
          return Option.some(quote);
        };
        return await choose(0);
      };
      const readStoredCart = async (response: typeof CartResponse.Type): Promise<Selection> => {
        const stored = await page.evaluate(readBrowserCarts);
        assert.equal(stored.length, 1, 'Fresh browser must contain exactly one cart');
        const cart = ParseResult.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(Cart))(stored[0]));
        const amounts = ParseResult.getOrThrow(Schema.decodeUnknownResult(Amounts)(response));
        assert.equal(cart.entries.length, 1);
        assert.equal(
          amounts.totalMinor,
          cart.entries.reduce((total, entry) => total + Math.round(entry.expectedUnitPriceMinor * entry.quantity), 0),
        );
        assert.deepEqual(amounts.issues, []);
        assert.ok(amounts.totalVatMinor >= 0 && amounts.totalVatMinor <= amounts.totalMinor);
        for (const entry of cart.entries) {
          assert.equal(entry.quantity, entry.minimumQuantity, 'Only minimum quantity may be used');
        }
        return { amounts, cart };
      };
      const selectFixture = async (): Promise<Option.Option<Fixture>> => {
        const candidates = new Set<string>();
        let attempted = 0;
        let examined = 0;
        const discover = async () => {
          for (const href of await page.locator('a[href]').evaluateAll(documentLinks)) {
            const url = new URL(href, origin);
            if (
              url.origin === origin &&
              (/^\/cs\/(?:produkt|kategorie)\//u.test(url.pathname) || url.pathname === '/cs/vyhledavani')
            ) {
              candidates.add(url.href);
            }
          }
        };
        await discover();
        candidates.add(`${origin}/cs/vyhledavani`);
        // Sequential traversal: one minimum-quantity cart, every product/variant and catalogue page once.
        const choose = async (index: number): Promise<Option.Option<Fixture>> => {
          const href = [...candidates][index];
          if (href === undefined) {
            return Option.none();
          }
          examined += 1;
          save('catalogue.json', { attempted, examined });
          phase = 'catalogue-document';
          const document = await page.goto(href);
          assert.ok(document !== null && document.ok(), 'Catalogue document HTTP failure');
          await page.locator('main').waitFor({ state: 'attached' });
          await discover();
          if (!new URL(href).pathname.startsWith('/cs/produkt/')) {
            return await choose(index + 1);
          }
          const add = page.getByRole('button', { exact: true, name: 'Přidat do košíku' });
          if ((await add.count()) !== 1 || !(await add.isEnabled())) {
            return await choose(index + 1);
          }
          const quantity = page.getByRole('spinbutton');
          const minimum = await quantity.getAttribute('aria-valuemin');
          assert.ok(minimum !== null && minimum.length > 0, 'Missing minimum quantity');
          phase = 'add-product';
          await quantity.fill(minimum);
          await add.click();
          await page.getByText('Zboží je ve vašem košíku.', { exact: true }).waitFor();
          attempted += 1;
          save('catalogue.json', { attempted, examined });
          phase = 'cart-response';
          const pending = page.waitForResponse(cartEndpoint);
          await page.goto(`${origin}/cs/kosik`);
          const http = await pending;
          assert.ok(http.ok(), 'Cart quote HTTP failure');
          const response = readCart(await http.text());
          if (response.outcome === 'VALID') {
            const selection = await readStoredCart(response);
            save('cart.json', evidence(selection.amounts));
            await page.locator('a[href="/cs/pokladna"]').click();
            await page.waitForURL(`${origin}/cs/pokladna`);
            const quote = await fillAndQuote(page, selection);
            if (Option.isSome(quote)) {
              return Option.some({ ...selection, quote: quote.value });
            }
            await page.goto(`${origin}/cs/kosik`);
          } else {
            recognizedRejection(response.issues);
          }
          phase = 'remove-product';
          await page.getByRole('button', { exact: true, name: 'Odebrat' }).click();
          await page.getByRole('button', { exact: true, name: 'Odebrat' }).waitFor({ state: 'detached' });
          return await choose(index + 1);
        };
        return await choose(0);
      };
      const placeAndRecover = async (fixture: Fixture) => {
        assert.ok(await page.evaluate(() => navigator.locks !== undefined), 'Native Web Locks required');
        const stale = await context.newPage();
        await stale.goto(`${origin}/cs/pokladna`);
        assert.ok(Option.isSome(await fillAndQuote(stale, fixture)), 'Stale tab quote refused');
        await stale.getByRole('button', { exact: true, name: 'Objednat' }).focus();
        const pending = page.waitForResponse(checkoutEndpoint);
        await page.getByRole('button', { exact: true, name: 'Objednat' }).click({ clickCount: 2 });
        const http = await pending;
        save('place-response.json', { status: http.status() });
        assert.ok(http.ok(), 'Placement uncertain/refused; use cleanup identity, DO NOT rerun place');
        const intent = ParseResult.getOrThrow(Schema.decodeUnknownResult(Request)(http.request().postDataJSON()));
        const placed = ParseResult.getOrThrow(Schema.decodeUnknownResult(Result)(readCheckout(await http.text())));
        const identity = {
          clientRequestId: intent.clientRequestId,
          orderId: placed.orderId,
          orderNumber: placed.orderNumber,
          scope: intent.scope,
        };
        save('place-response.json', identity);
        assert.equal(intent.mode, 'place');
        assert.deepEqual(intent.lines, fixture.quote.request.lines);
        assert.deepEqual(intent.scope, fixture.quote.request.scope);
        assert.deepEqual(placed.lines, fixture.quote.result.lines);
        assert.equal(placed.totalMinor, fixture.quote.result.totalMinor);
        assert.equal(placed.shippingPriceMinor, fixture.quote.result.shippingPriceMinor);
        assert.ok(['PLACED', 'REPLAYED'].includes(placed.outcome));
        assert.ok(placed.orderId !== null && placed.orderNumber !== null, 'Missing order identity');
        await page.getByRole('heading', { name: RECEIPT_HEADING }).waitFor();
        const guards = await page.evaluate(readBrowserGuards);
        assert.equal(guards.length, 1);
        assert.deepEqual(ParseResult.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(Intent))(guards[0])), {
          clientRequestId: intent.clientRequestId,
          lines: intent.lines,
          scope: intent.scope,
        });
        const recovery = page.waitForResponse(statusEndpoint);
        await page.reload();
        const recoveredHttp = await recovery;
        assert.ok(recoveredHttp.ok(), 'Reload recovery failed');
        const recovered = ParseResult.getOrThrow(Schema.decodeUnknownResult(Recovery)(await recoveredHttp.json()));
        const recoveryRequest = ParseResult.getOrThrow(
          Schema.decodeUnknownResult(Schema.Struct({ clientRequestId: Intent.fields.clientRequestId, scope: Scope }))(
            recoveredHttp.request().postDataJSON(),
          ),
        );
        assert.equal(recoveryRequest.clientRequestId, intent.clientRequestId);
        assert.equal(recovered.result.orderId, placed.orderId);
        assert.equal(recovered.result.orderNumber, placed.orderNumber);
        assert.deepEqual(recovered.result.lines, placed.lines);
        assert.equal(recovered.result.totalMinor, placed.totalMinor);
        await page.getByRole('heading', { name: RECEIPT_HEADING }).waitFor();
        await page.getByRole('heading', { exact: true, name: `Objednávka ${placed.orderNumber}` }).waitFor();
        await stale.keyboard.press('Enter');
        await stale.keyboard.press('Enter');
        await stale.getByRole('heading', { name: RECEIPT_HEADING }).waitFor();
        const stalePending = stale.waitForResponse(statusEndpoint);
        await stale.reload();
        const staleHttp = await stalePending;
        assert.ok(staleHttp.ok());
        assert.equal(
          ParseResult.getOrThrow(Schema.decodeUnknownResult(Recovery)(await staleHttp.json())).result.orderId,
          placed.orderId,
        );
        await stale.getByRole('heading', { name: RECEIPT_HEADING }).waitFor();
        return identity;
      };

      const network = await captureNetwork();
      let summary: Schema.JsonObject = { mode, state: 'failed' };
      try {
        const home = await page.goto(`${origin}/cs`);
        assert.ok(home !== null && home.ok(), 'Storefront home HTTP failure');
        const buildId = /\\"b\\":\\"(?<build>[^"\\]+)\\"/u.exec(await home.text())?.groups?.build;
        assert.ok(buildId !== undefined && /^[\w-]+$/u.test(buildId), 'Missing or invalid served build id');
        save('build.json', { buildId, observedAt });
        if (Option.isSome(expectedBuild)) {
          assert.equal(buildId, expectedBuild.value, 'Served build differs from packaged output');
        }
        const fixture = await selectFixture();
        if (Option.isNone(fixture)) {
          summary = { buildId, mode, state: NO_FIXTURE };
          return summary;
        }
        summary = {
          buildId,
          coverage: Option.isSome(expectedBuild) ? 'packaged-n1-build' : 'currently-served-n1-build',
          mode,
          quote: evidence(fixture.value.quote.result),
          state: 'quoted',
        };
        if (mode === 'place') {
          const identity = await placeAndRecover(fixture.value);
          assert.equal(
            network.requests.filter((request) => request.mode === 'place').length,
            1,
            'Duplicate UI dispatched another placement',
          );
          summary = { ...Object.fromEntries(Object.entries(summary)), ...identity, state: 'passed-cleanup-required' };
        } else {
          assert.equal(network.requests.filter((request) => request.mode === 'place').length, 0);
          summary = { ...Object.fromEntries(Object.entries(summary)), state: 'passed' };
        }
        assert.deepEqual(network.blocked, [], 'Unexpected write blocked');
        return summary;
      } catch {
        summary = {
          ...Object.fromEntries(Object.entries(summary)),
          phase,
          state: network.requests.some((request) => request.mode === 'place')
            ? 'failed-cleanup-required'
            : 'quote-broken',
        };
        return assert.fail(PROOF_FAILED);
      } finally {
        await Promise.all(network.pending);
        save('requests.json', network.requests);
        save('responses.json', network.responses);
        save('blocked.json', network.blocked);
        save(RESULT_FILE, summary);
      }
    },
  });
};
const command = Command.make(
  'stage-n1-checkout',
  {
    cleanup: Flag.Boolean('i-will-clean-up').pipe(Flag.withDefault(false)),
    expectedBuild: Flag.String('expect-build-id').pipe(Flag.optional),
    mode: Argument.ChoiceWithValue('mode', [
      ['quote', 'quote'],
      ['place', 'place'],
    ]),
    origin: Flag.String('origin').pipe(Flag.withDefault(DEFAULT_ORIGIN)),
    out: Flag.String('out').pipe(Flag.optional),
  },
  ({ cleanup, expectedBuild, mode, origin, out }) =>
    Effect.gen(function* checkoutProof() {
      const ci = yield* Config.String('CI').pipe(Config.option);
      if (mode === 'place' && (Option.isSome(ci) || !cleanup)) {
        return yield* new CheckoutProofFailure({
          cause: 'place requires --i-will-clean-up and CI unset; no order sent',
          code: 1,
        });
      }
      const runnerTemp = yield* Config.String('RUNNER_TEMP').pipe(Config.withDefault('/tmp'));
      const root = yield* Config.String('E2E_OUT_DIR').pipe(Config.withDefault(path.join(runnerTemp, 'mcp-oauth-e2e')));
      const directory = path.resolve(Option.getOrElse(out, () => path.join(root, `n1-checkout-${mode}`)));
      const modulePath = yield* Config.String('E2E_PLAYWRIGHT_MODULE').pipe(
        Config.withDefault(
          createRequire(new URL('../../apps/shell-super-app/package.json', import.meta.url)).resolve(
            '@playwright/test',
          ),
        ),
      );
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(directory, { recursive: true });
      const observedAt = yield* Clock.currentTimeMillis;
      const artifacts = new Map<string, string>();
      const playwright = yield* Effect.tryPromise({
        catch: () => new CheckoutProofFailure({ cause: PROOF_FAILED, code: 1 }),
        try: async () => {
          const loaded: unknown = await import(modulePath);
          const normalized =
            Predicate.hasProperty(loaded, 'default') && Predicate.hasProperty(loaded.default, 'chromium')
              ? { chromium: loaded.default.chromium }
              : loaded;
          assert.ok(Schema.is(Launcher)(normalized), 'Pinned Playwright has no chromium.launch');
          return normalized;
        },
      });
      const browser = yield* Effect.acquireRelease(
        Effect.tryPromise({
          catch: () => new CheckoutProofFailure({ cause: 'Checkout proof failed: browser could not start', code: 1 }),
          try: async () => await playwright.chromium.launch({ headless: true }),
        }),
        (owned) => Effect.promise(async () => await owned.close()),
      );
      const result = yield* browserProof({
        artifacts,
        browser,
        expectedBuild,
        mode,
        observedAt,
        origin: new URL(origin).origin,
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* persistEvidence() {
            for (const [name, text] of artifacts) {
              yield* fs.writeFileString(path.join(directory, name), text);
            }
            const summary = artifacts.get(RESULT_FILE);
            if (summary !== undefined) {
              yield* Console.log(summary);
            }
          }).pipe(Effect.orDie),
        ),
      );
      if (result.state === NO_FIXTURE) {
        return yield* new CheckoutProofFailure({
          cause: 'NO_PURCHASABLE_FIXTURE: no purchasable fixture on stage; checkout not proved',
          code: 3,
        });
      }
      return result;
    }).pipe(Effect.scoped),
);
NodeRuntime.runMain(
  Layer.build(
    Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(Layer.provide(NodeServices.layer)),
  ).pipe(Effect.scoped),
);

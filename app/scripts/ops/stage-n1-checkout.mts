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
} from 'effect';
import { Argument, Command, Flag } from 'effect/cli';
import type { Browser, BrowserType, Page, Response } from 'playwright-core';

const CHECKOUT_PATH = '/api/checkout';
const STATUS_PATH = '/api/checkout/status';
const RESULT_FILE = 'result.json';
const RECEIPT_HEADING = 'Objednávka byla přijata';
const endpoint = (response: Response, pathname: string) =>
  new URL(response.url()).pathname === pathname && response.request().method() === 'POST';
const ORIGIN = 'https://ontos-stage-n1.web-revolution.cz';
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
const Amounts = Schema.Struct({
  outcome: Schema.String,
  scope: Scope,
  totalMinor: Schema.Int,
  totalVatMinor: Schema.Int,
});
const Result = Schema.Struct({
  ...Amounts.fields,
  issues: Schema.Array(Schema.Json),
  lines: Schema.Array(ResultLine),
  orderId: Schema.Union([Schema.String.pipe(Schema.brand('orderId')), Schema.Null]),
  orderNumber: Schema.Union([Schema.String, Schema.Null]),
  shippingPriceMinor: Schema.Int,
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
  cause: Schema.Defect(),
}) {}

const browserProof = ({
  artifacts,
  browser,
  directory,
  expectedBuild,
  mode,
  observedAt,
}: {
  artifacts: Map<string, string>;
  browser: Browser;
  directory: string;
  expectedBuild: Option.Option<string>;
  mode: 'quote' | 'place';
  observedAt: number;
}) => {
  const passedState = mode === 'quote' ? 'passed' : 'passed-cleanup-required';
  const saveText = (name: string, text: string) => artifacts.set(name, text);
  const save = (name: string, value: Schema.Json) =>
    saveText(name, ParseResult.getOrThrow(Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Json))(value)));
  return Effect.tryPromise({
    catch: (cause) => new CheckoutProofFailure({ cause }),
    try: async () => {
      const context = await browser.newContext({
        serviceWorkers: 'block',
        viewport: { height: 1000, width: 1440 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      page.setDefaultNavigationTimeout(60_000);
      const requests: { body: string | null; path: string }[] = [];
      const blocked: string[] = [];
      const responses: { body: string; path: string; status: number }[] = [];
      const responseTasks: Promise<void>[] = [];
      // A safety fence, not a response double: every permitted exchange reaches the real stage unchanged.
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'GET' || request.method() === 'HEAD') {
          await route.continue();
          return;
        }
        const allowed =
          url.origin === ORIGIN &&
          request.method() === 'POST' &&
          (url.pathname === '/api/cart-quote' ||
            (url.pathname === STATUS_PATH && mode === 'place') ||
            (url.pathname === CHECKOUT_PATH &&
              ParseResult.getOrThrow(Schema.decodeUnknownResult(Request)(request.postDataJSON())).mode === mode));
        // Place still needs its initial quote before confirmation.
        const quote =
          url.origin === ORIGIN &&
          url.pathname === CHECKOUT_PATH &&
          request.method() === 'POST' &&
          ParseResult.getOrThrow(Schema.decodeUnknownResult(Request)(request.postDataJSON())).mode === 'quote';
        if (!allowed && !quote) {
          blocked.push(`${request.method()} ${url.pathname}`);
          await route.abort('blockedbyclient');
          return;
        }
        requests.push({ body: request.postData(), path: url.pathname });
        if (
          url.pathname === CHECKOUT_PATH &&
          ParseResult.getOrThrow(Schema.decodeUnknownResult(Request)(request.postDataJSON())).mode === 'place'
        ) {
          // Retain cleanup identity even if the response or a later assertion fails. Never retry placement here.
          saveText('place-request.json', request.postData() ?? '');
          // Native storage is persisted before dispatch, retaining the UUID even if this process dies.
          await context.storageState({ path: path.join(directory, 'placement-storage.json') });
        }
        await route.continue();
      });
      context.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin === ORIGIN && response.request().method() === 'POST') {
          const capture = async () => {
            try {
              const body = await response.text();
              responses.push({ body, path: url.pathname, status: response.status() });
            } catch (error) {
              responses.push({ body: String(error), path: url.pathname, status: response.status() });
            }
          };
          responseTasks.push(capture());
        }
      });
      let summary: Schema.JsonObject = { directory, mode, origin: ORIGIN, state: 'started' };
      try {
        const home = await page.goto(`${ORIGIN}/cs`);
        assert.ok(home !== null && home.ok(), 'Storefront home did not return success');
        const html = await home.text();
        // Next App Router serves its build id in the initial RSC payload, not __NEXT_DATA__.
        const buildId = /\\"b\\":\\"(?<build>[^"\\]+)\\"/u.exec(html)?.groups?.build;
        assert.ok(buildId !== undefined && buildId.length > 0, 'No served Next build id in the storefront document');
        save('build.json', { buildId, observedAt, origin: ORIGIN });
        const candidates = await page
          .locator('main a[href*="/produkt/"]')
          .evaluateAll((links) => [
            ...new Set(links.map((link) => link.getAttribute('href')).filter((href) => href !== null)),
          ]);
        const examined: string[] = [];
        const rejected: { response: string; url: string }[] = [];
        const choose = async (index: number): Promise<Option.Option<typeof Amounts.Type>> => {
          const href = candidates[index];
          if (href === undefined) {
            return Option.none();
          }
          await page.goto(new URL(href, ORIGIN).href);
          await page.waitForLoadState('networkidle');
          examined.push(href);
          const add = page.getByRole('button', { exact: true, name: 'Přidat do košíku' });
          if ((await add.count()) !== 1 || !(await add.isEnabled())) {
            return await choose(index + 1);
          }
          const quantity = page.getByRole('spinbutton');
          const minimum = await quantity.getAttribute('aria-valuemin');
          assert.ok(minimum !== null && minimum.length > 0, 'Purchasable product does not expose a minimum quantity');
          await quantity.fill(minimum);
          await add.click();
          await page.getByText('Zboží je ve vašem košíku.', { exact: true }).waitFor();
          const pendingCart = page.waitForResponse((response) => endpoint(response, '/api/cart-quote'));
          await page.goto(`${ORIGIN}/cs/kosik`);
          const cartHttp = await pendingCart;
          const cartBody = await cartHttp.text();
          assert.ok(cartHttp.ok(), `Cart quote HTTP ${cartHttp.status()}: ${cartBody}`);
          const amounts = ParseResult.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(Amounts))(cartBody));
          if (amounts.outcome === 'VALID') {
            save('catalogue.json', { examined, rejected, selectedUrl: href });
            return Option.some(amounts);
          }
          rejected.push({ response: cartBody, url: href });
          save('catalogue.json', { examined, rejected });
          await page.getByRole('button', { exact: true, name: 'Odebrat' }).click();
          await page.waitForLoadState('networkidle');
          return await choose(index + 1);
        };
        const choice = await choose(0);
        assert.ok(
          Option.isSome(choice),
          `No purchasable product among ${examined.length} live catalogue links; ${rejected.length} offered selections rejected by the real cart. See catalogue.json and responses.json.`,
        );
        const cartAmounts = Option.getOrThrow(choice);
        const storedCarts = await page.evaluate(() =>
          Object.keys(localStorage)
            .filter((key) => key.startsWith('n1-cart-v1:'))
            .map((key) => localStorage.getItem(key)),
        );
        assert.equal(storedCarts.length, 1, 'Fresh browser must contain exactly one cart');
        const cart = ParseResult.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(Cart))(storedCarts[0]));
        let goodsMinor = 0;
        for (const entry of cart.entries) {
          goodsMinor += Math.round(entry.expectedUnitPriceMinor * entry.quantity);
        }
        assert.equal(cartAmounts.totalMinor, goodsMinor, 'Cart goods total must match the actual stored UI lines');
        assert.equal(cart.entries.length, 1);
        for (const entry of cart.entries) {
          assert.equal(entry.quantity, entry.minimumQuantity, 'Only the minimum quantity may be used');
        }
        save('cart.json', { cart, quote: cartAmounts });
        await page.locator('a[href="/cs/pokladna"]').click();
        await page.waitForURL(`${ORIGIN}/cs/pokladna`);
        const fillAndQuote = async (tab: Page) => {
          await tab.locator('input[name="city"]').fill('TEST Praha');
          await tab.locator('input[name="email"]').fill('stage-checkout@example.invalid');
          await tab.locator('input[name="firstName"]').fill('TEST ověření');
          await tab.locator('input[name="lastName"]').fill('pokladny (smazat)');
          await tab.locator('input[name="postalCode"]').fill('11000');
          await tab.locator('input[name="street"]').fill('TEST neodesílat 1');
          const shipping = tab.locator('input[name="shippingMethod"]').first();
          await shipping.check({ force: true });
          const shippingMethod = await shipping.inputValue();
          const pending = tab.waitForResponse((response) => endpoint(response, CHECKOUT_PATH));
          await tab.getByRole('button', { exact: true, name: 'Ověřit objednávku' }).click();
          const response = await pending;
          const request = ParseResult.getOrThrow(
            Schema.decodeUnknownResult(Request)(response.request().postDataJSON()),
          );
          const body = await response.text();
          saveText('quote-request.json', response.request().postData() ?? '');
          saveText('quote-response.json', body);
          assert.ok(response.ok(), `Checkout quote HTTP ${response.status()}: ${body}`);
          const result = ParseResult.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(Result))(body));
          assert.equal(request.mode, 'quote');
          assert.equal(request.shippingMethod, shippingMethod);
          assert.equal(result.outcome, 'VALID', `Quote rejected: ${body}`);
          assert.deepEqual(result.issues, []);
          assert.equal(result.orderId, null);
          assert.equal(result.orderNumber, null);
          assert.deepEqual(request.scope, cart.scope);
          assert.deepEqual(result.scope, cart.scope);
          assert.deepEqual(
            request.lines,
            cart.entries.map(({ expectedUnitPriceMinor, productId, quantity, variantId }) =>
              variantId === undefined
                ? { expectedUnitPriceMinor, productId, quantity }
                : { expectedUnitPriceMinor, productId, quantity, variantId },
            ),
          );
          assert.deepEqual(
            result.lines.map(({ productId, quantity, unitPriceMinor, variantId }) =>
              variantId === undefined
                ? { expectedUnitPriceMinor: unitPriceMinor, productId, quantity }
                : { expectedUnitPriceMinor: unitPriceMinor, productId, quantity, variantId },
            ),
            request.lines,
          );
          assert.equal(result.shippingPriceMinor, request.expectedShippingPriceMinor);
          assert.equal(
            result.totalMinor,
            cartAmounts.totalMinor + request.expectedShippingPriceMinor,
            'Checkout total must equal cart goods plus offered shipping',
          );
          assert.ok(
            result.totalVatMinor >= cartAmounts.totalVatMinor && result.totalVatMinor <= result.totalMinor,
            'Checkout VAT must include goods VAT and cannot exceed gross',
          );
          await tab.getByRole('button', { exact: true, name: 'Objednat' }).waitFor();
          return { request, result };
        };
        const quote = await fillAndQuote(page);
        await page.screenshot({ fullPage: true, path: path.join(directory, 'quote.png') });
        if (Option.isSome(expectedBuild)) {
          assert.equal(buildId, expectedBuild.value, 'Served build id differs from expectation');
        }
        summary = {
          buildId,
          directory,
          mode,
          quote: {
            request: Schema.encodeUnknownResult(Schema.fromJsonString(Request))(quote.request).pipe(
              ParseResult.getOrThrow,
            ),
            response: Schema.encodeUnknownResult(Schema.fromJsonString(Result))(quote.result).pipe(
              ParseResult.getOrThrow,
            ),
          },
          state: 'quoted',
        };
        if (mode === 'place') {
          assert.ok(await page.evaluate(() => navigator.locks !== undefined), 'Native Web Locks required');
          // Keep a real, already-verified stale checkout tab for the duplicate attempt AFTER reload recovery.
          const stale = await context.newPage();
          stale.setDefaultTimeout(30_000);
          await stale.goto(`${ORIGIN}/cs/pokladna`);
          await fillAndQuote(stale);
          await stale.getByRole('button', { exact: true, name: 'Objednat' }).focus();
          const placement = page.waitForResponse((response) => endpoint(response, CHECKOUT_PATH));
          // Two physical clicks exercise the mounted form's synchronous busy guard; only one may confirm.
          await page.getByRole('button', { exact: true, name: 'Objednat' }).click({ clickCount: 2 });
          const placedHttp = await placement;
          const intent = ParseResult.getOrThrow(
            Schema.decodeUnknownResult(Request)(placedHttp.request().postDataJSON()),
          );
          const placedBody = await placedHttp.text();
          saveText('place-response.json', placedBody);
          assert.ok(
            placedHttp.ok(),
            `Placement uncertain/refused HTTP ${placedHttp.status()}. Use place-request.json to find the order; DO NOT rerun place.`,
          );
          const placed = ParseResult.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(Result))(placedBody));
          summary = {
            buildId,
            clientRequestId: intent.clientRequestId,
            contact: 'TEST ověření pokladny (smazat)',
            directory,
            lines: intent.lines,
            mode,
            orderId: placed.orderId,
            orderNumber: placed.orderNumber,
            scope: intent.scope,
            state: 'placed-cleanup-required',
          };
          save(RESULT_FILE, summary);
          assert.equal(intent.mode, 'place');
          assert.deepEqual(intent.lines, quote.request.lines, 'Placement must preserve the verified cart lines');
          assert.deepEqual(intent.scope, quote.request.scope);
          assert.deepEqual(placed.lines, quote.result.lines);
          assert.equal(placed.totalMinor, quote.result.totalMinor);
          assert.equal(placed.shippingPriceMinor, quote.result.shippingPriceMinor);
          assert.ok(['PLACED', 'REPLAYED'].includes(placed.outcome));
          assert.ok(placed.orderId !== null && placed.orderNumber !== null, 'Placement missing order identity');
          await page.getByRole('heading', { name: RECEIPT_HEADING }).waitFor();
          const guards = await page.evaluate(() =>
            Object.keys(localStorage)
              .filter((key) => key.startsWith('n1-checkout-guard-v1:'))
              .map((key) => localStorage.getItem(key)),
          );
          assert.equal(guards.length, 1, 'Receipt must retain the native persisted intent');
          assert.deepEqual(
            ParseResult.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(Intent))(guards[0])),
            {
              clientRequestId: intent.clientRequestId,
              lines: intent.lines,
              scope: intent.scope,
            },
          );
          save('guard.json', guards);
          const recoveryResponse = page.waitForResponse((response) => endpoint(response, STATUS_PATH));
          await page.reload();
          const recoveryHttp = await recoveryResponse;
          assert.ok(recoveryHttp.ok(), 'Reload recovery HTTP failed');
          const recovered = ParseResult.getOrThrow(Schema.decodeUnknownResult(Recovery)(await recoveryHttp.json()));
          assert.equal(
            ParseResult.getOrThrow(
              Schema.decodeUnknownResult(
                Schema.Struct({ clientRequestId: Intent.fields.clientRequestId, scope: Scope }),
              )(recoveryHttp.request().postDataJSON()),
            ).clientRequestId,
            intent.clientRequestId,
          );
          assert.equal(recovered.result.orderId, placed.orderId);
          assert.equal(recovered.result.orderNumber, placed.orderNumber);
          assert.deepEqual(recovered.result.lines, placed.lines);
          assert.equal(recovered.result.totalMinor, placed.totalMinor);
          await page.getByRole('heading', { name: RECEIPT_HEADING }).waitFor();
          await page.getByRole('heading', { exact: true, name: `Objednávka ${placed.orderNumber}` }).waitFor();
          await page.screenshot({ fullPage: true, path: path.join(directory, 'recovered.png') });
          // A stale real form/submit focus, not a replayed HTTP call or a direct hook invocation.
          await stale.keyboard.press('Enter');
          await stale.keyboard.press('Enter');
          await stale.waitForLoadState('networkidle');
          const staleRecovery = stale.waitForResponse((response) => endpoint(response, STATUS_PATH));
          await stale.reload();
          const staleHttp = await staleRecovery;
          assert.ok(staleHttp.ok());
          assert.equal(
            ParseResult.getOrThrow(Schema.decodeUnknownResult(Recovery)(await staleHttp.json())).result.orderId,
            placed.orderId,
          );
          await stale.getByRole('heading', { name: RECEIPT_HEADING }).waitFor();
          await stale.waitForLoadState('networkidle');
          const placements = requests.filter(
            (request) =>
              request.path === CHECKOUT_PATH &&
              ParseResult.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(Request))(request.body)).mode ===
                'place',
          );
          assert.equal(placements.length, 1, 'Duplicate UI attempt dispatched another placement');
          summary = {
            ...Object.fromEntries(Object.entries(summary)),
            browserObservedOrders: 1,
            doubleSubmit:
              'initial double click plus two Enter presses in previously verified tab after primary reload; one placement request, same recovered order in both tabs',
            recovery: ParseResult.getOrThrow(Schema.encodeUnknownResult(Schema.fromJsonString(Recovery))(recovered)),
            state: passedState,
          };
        }
        await page.waitForLoadState('networkidle');
        assert.deepEqual(blocked, [], 'Unexpected write blocked by safety fence');
        if (mode === 'quote') {
          assert.equal(requests.filter((request) => request.path === CHECKOUT_PATH).length, 1);
        }
        summary = {
          ...Object.fromEntries(Object.entries(summary)),
          state: passedState,
        };
        return summary;
      } finally {
        await Promise.all(responseTasks);
        const submitted = requests.filter(
          (request) =>
            request.path === CHECKOUT_PATH &&
            ParseResult.getOrThrow(Schema.decodeUnknownResult(Schema.fromJsonString(Request))(request.body)).mode ===
              'place',
        );
        let finalState = summary.state;
        if (finalState !== passedState) {
          finalState = submitted.length > 0 ? 'failed-cleanup-required' : 'failed';
        }
        summary = { ...Object.fromEntries(Object.entries(summary)), state: finalState, submittedPlacements: submitted };
        save('requests.json', requests);
        save('responses.json', responses);
        save('blocked.json', blocked);
        save(RESULT_FILE, summary);
        await page.screenshot({ fullPage: true, path: path.join(directory, 'final.png') });
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
    out: Flag.String('out').pipe(Flag.optional),
  },
  ({ cleanup, expectedBuild, mode, out }) =>
    Effect.gen(function* checkoutProof() {
      const ci = yield* Config.String('CI').pipe(Config.option);
      if (mode === 'place' && (Option.isSome(ci) || !cleanup)) {
        return yield* new CheckoutProofFailure({
          cause: 'place requires --i-will-clean-up and CI must be unset; no browser opened, no order sent',
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
        catch: (cause) => new CheckoutProofFailure({ cause }),
        try: async () => {
          const loaded: unknown = await import(modulePath);
          const normalized =
            Predicate.hasProperty(loaded, 'default') && Predicate.hasProperty(loaded.default, 'chromium')
              ? { chromium: loaded.default.chromium }
              : loaded;
          assert.ok(Schema.is(Launcher)(normalized), 'Pinned Playwright module has no chromium.launch capability');
          return normalized;
        },
      });
      const browser = yield* Effect.acquireRelease(
        Effect.tryPromise({
          catch: (cause) => new CheckoutProofFailure({ cause }),
          try: async () => await playwright.chromium.launch({ headless: true }),
        }),
        (owned) => Effect.promise(async () => await owned.close()),
      );
      return yield* browserProof({ artifacts, browser, directory, expectedBuild, mode, observedAt }).pipe(
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
    }).pipe(Effect.scoped),
);

NodeRuntime.runMain(
  Layer.build(
    Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(Layer.provide(NodeServices.layer)),
  ).pipe(Effect.scoped),
);

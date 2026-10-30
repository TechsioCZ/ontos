import { Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import {
  READINESS_ROWS,
  ReadinessFailure,
  checkReadinessHtml,
  configureReadiness,
  parseReadinessArgs,
  verifyReadiness,
} from '../ops/stage-demo-readiness.mjs';
import type { ReadinessResponse, ReadinessTransport } from '../ops/stage-demo-readiness.mjs';

const SIGN_OUT_PATH = '/auth/sign-out';
const SELECTED_ROW = 'finance:selected-company';
const INVOICE_NUMBER = 'INV-TEST-001';
const CUSTOMER_NAME = 'Fixture customer';
const PRODUCT_ROUTE = 'storefront-product';
const ROWS_FLAG = '--rows';
const CAP_FLAG = '--max-requests';
const ANONYMOUS_HOME = 'home:anonymous';
const fixturePassword = 'fixture'.repeat(2);
// Sanitized source-shaped HTML fixtures, NOT recorded live captures.
// The evidence JSON explicitly retains no raw bodies. Keep these literals local: no fetch/browser.
const selectedHtml = `<!doctype html><html><body>
<select name="legalEntity"><option value="other">Other</option><option value="fixture-company" selected="">Fixture</option></select>
<main><h1>Finance</h1><table><tbody><tr><td>INV-TEST-001</td><td>Fixture customer</td></tr></tbody></table></main>
<script>{"state":"unavailable","selectedLegalEntityId":"other"}</script></body></html>`;
const companylessHtml = `<select name="legalEntity"><option value="tenant" selected="">Tenant</option></select>
<main><h1>Domů</h1><p>Není vybraná firma. Pro práci s jejími daty vyberte firmu v nabídce vlevo.</p></main>`;
const unavailableHtml = `<main><p aria-live="polite">Přihlášené prostředí je dočasně nedostupné. Znovu načtěte stránku a zkuste to znovu.</p></main>`;
const loginHtml = '<main><h1>Přihlášení</h1><form><input type="email"/><input type="password"/></form></main>';
const storefrontHtml = `<main><h1>Sortiment</h1><div data-akros-product-listing="catalog"><article>
<a href="/produkt/fixture-product"><img src="/fixture.webp" alt="Fixture product"/></a><p>Fixture product</p>
</article></div></main>`;
const productHtml = `<main><h1 id="product-title">Fixture product</h1><section id="product-variants">
<div class="akros-variant-table__order"><input aria-label="Množství Fixture variant" value="1"/><button>Koupit (ks)</button></div>
</section></main>`;
const htmlHeaders = () => new Headers({ 'content-type': 'text/html; charset=utf-8' });
const selectedRow = {
  id: SELECTED_ROW,
  path: '/cs/finance',
  persona: 'selected-company',
  primaryText: [INVOICE_NUMBER, CUSTOMER_NAME],
  route: 'finance',
  surface: 'shell',
};
const oracle = (html: string, row = selectedRow, status = 200, headers = htmlHeaders()) =>
  checkReadinessHtml({ companyId: 'fixture-company', headers, html, row, status });
const args = (rows: string, cap: number) => [ROWS_FLAG, rows, CAP_FLAG, String(cap)];
const env = {
  STAGE_READINESS_COMPANY_ID: 'fixture-company',
  STAGE_READINESS_COMPANYLESS_EMAIL: 'companyless@example.test',
  STAGE_READINESS_COMPANYLESS_PASSWORD: fixturePassword,
  STAGE_READINESS_INVOICE_ID: 'fixture-invoice',
  STAGE_READINESS_PRIMARY_TEXT: JSON.stringify({
    'home:companyless': ['Není vybraná firma.'],
    [SELECTED_ROW]: [INVOICE_NUMBER, CUSTOMER_NAME],
  }),
  STAGE_READINESS_SELECTED_EMAIL: 'selected@example.test',
  STAGE_READINESS_SELECTED_PASSWORD: fixturePassword,
  STAGE_SHELL_URL: 'https://shell.example.test',
  STAGE_STOREFRONT_URL: 'https://storefront.example.test',
};
const response = (html: string, status = 200, headers = htmlHeaders()): ReadinessResponse => ({
  body: Effect.succeed(html),
  headers,
  status,
});
const issuedResponse = () =>
  response('', 200, new Headers({ 'set-cookie': 'ontos.session=fixture; HttpOnly; Path=/' }));
const fixture = (selectedArgs = args(SELECTED_ROW, 3), respond?: ReadinessTransport) => {
  const calls: { init: RequestInit; url: string }[] = [];
  const transport: ReadinessTransport = (url, init) =>
    Effect.suspend(() => {
      calls.push({ init, url });
      return respond
        ? respond(url, init)
        : Effect.succeed(url.endsWith('/sign-in') ? issuedResponse() : response(selectedHtml));
    });
  return {
    calls,
    run: configureReadiness(selectedArgs, env).pipe(Effect.flatMap((config) => verifyReadiness(config, transport))),
  };
};

it('accepts populated selected-company content, ignoring unavailable states serialized in scripts', () => {
  expect(oracle(selectedHtml)).toEqual([]);
});

it.each([
  unavailableHtml,
  '<main><h1>Application error</h1></main>',
  '<main><h1>Something went wrong</h1></main>',
  '<main></main><script>INV-TEST-001 Fixture customer</script>',
  '<nav>INV-TEST-001 Fixture customer</nav><main><div></div></main>',
  selectedHtml.replace('value="fixture-company" selected', 'value="wrong-company" selected'),
  selectedHtml.replace(' selected=""', ''),
  selectedHtml.replace(INVOICE_NUMBER, ''),
])('rejects an HTTP 200 outage, empty shell, wrong company or missing primary record (%#)', (html) => {
  expect(oracle(html).length).toBeGreaterThan(0);
});

it.each([
  'hidden',
  'hidden="until-found"',
  'aria-hidden="true"',
  'style="display: none"',
  'style="visibility: hidden"',
  'style="DISPLAY : none !important"',
])('ignores explicitly hidden primary descendants and outage text (%s)', (attributes) => {
  const hiddenRecord = selectedHtml
    .replace('<table>', `<div ${attributes}><div><table>`)
    .replace('</table>', '</table></div></div><p>No invoices loaded</p>');
  expect(oracle(hiddenRecord)).toContain('Missing expected populated primary-content tokens');
  expect(
    oracle(selectedHtml.replace('</main>', `<div ${attributes}><div>Something went wrong</div></div></main>`)),
  ).toEqual([]);
  expect(oracle(selectedHtml.replace('<main>', `<main ${attributes}>`))).toContain(
    'Missing populated main content (empty/unauthorized shell)',
  );
});

it('inspects the intentionally hidden native company selector independently of primary visibility', () => {
  const html = selectedHtml.replace('<select ', '<div hidden><select ').replace('</select>', '</select></div>');
  expect(oracle(html)).toEqual([]);
  expect(oracle(html.replace('value="fixture-company" selected', 'value="wrong-company" selected'))).toContain(
    'Selected legal entity does not match the expected company',
  );
});

it.each([
  ['O&#x27;Reilly', "O'Reilly"],
  ['O&#39;Reilly', "O'Reilly"],
  ['&quot;Fixture&quot; &amp; Co &lt;West&gt;', '"Fixture" & Co <West>'],
  ['&copy; Fixture &eacute; &ndash; &#x1F600;', '© Fixture é – 😀'],
  ['Fixture&nbsp;customer', CUSTOMER_NAME],
  ['Literal &amp;#x27; text', 'Literal &#x27; text'],
])('matches visible customer text after standard HTML entity decoding (%s)', (encoded, visible) => {
  expect(
    oracle(selectedHtml.replace(CUSTOMER_NAME, encoded), {
      ...selectedRow,
      primaryText: [INVOICE_NUMBER, visible],
    }),
  ).toEqual([]);
});

it('requires HTML and a successful status independently of primary content', () => {
  expect(oracle(selectedHtml, selectedRow, 503)).toContain('Unexpected HTTP 503');
  expect(oracle(selectedHtml, selectedRow, 200, new Headers())).toContain('Expected HTML content-type');
});

it('accepts explicit companyless content but never a wrong selected company or an outage', () => {
  const row = { ...selectedRow, id: 'home:companyless', persona: 'companyless', primaryText: ['Není vybraná firma.'] };
  expect(oracle(companylessHtml, row)).toEqual([]);
  expect(oracle(selectedHtml, row).length).toBeGreaterThan(0);
  expect(oracle(unavailableHtml, row).length).toBeGreaterThan(0);
});

it.each(['anonymous', 'expired'])('requires native login denial, not a blank 200 shell, for %s', (persona) => {
  const row = { ...selectedRow, persona };
  expect(oracle('', row, 302, new Headers({ location: '/cs/login?reason=expired' }))).toEqual([]);
  expect(oracle(loginHtml, row)).toEqual([]);
  expect(oracle('<main></main>', row).length).toBeGreaterThan(0);
  expect(oracle(selectedHtml, row).length).toBeGreaterThan(0);
  expect(oracle('', row, 302, new Headers({ location: 'https://other.example.test/cs/login' })).length).toBeGreaterThan(
    0,
  );
  expect(oracle('', row, 302, new Headers({ location: '/cs' })).length).toBeGreaterThan(0);
});

it.each(['storefront-home', 'storefront-category', PRODUCT_ROUTE])('requires product markup for %s', (route) => {
  const row = { ...selectedRow, persona: 'anonymous', route, surface: 'storefront' };
  expect(oracle(route === PRODUCT_ROUTE ? productHtml : storefrontHtml, row)).toEqual([]);
  expect(oracle('<main><h1>Obchod</h1></main>', row).length).toBeGreaterThan(0);
  expect(oracle(unavailableHtml, row).length).toBeGreaterThan(0);
});

it('accepts populated single-product purchase controls without a variant section', () => {
  const row = { ...selectedRow, persona: 'anonymous', route: PRODUCT_ROUTE, surface: 'storefront' };
  expect(
    oracle(
      productHtml
        .replace('<section id="product-variants">', '<section>')
        .replace('akros-variant-table__order', 'akros-purchase-form'),
      row,
    ),
  ).toEqual([]);
});

it.each([
  '<h1 id="product-title"></h1><section id="product-variants"><form><input name="quantity" value="1"/></form></section>',
  '<h1 id="product-title">&nbsp;</h1><section id="product-variants"><form><input name="quantity" value="1"/></form></section>',
  '<h1 id="product-title">Fixture product</h1><section id="product-variants"></section>',
  '<h1 id="product-title">Fixture product</h1><section id="product-variants"><form></form></section>',
  '<h1 id="product-title">Fixture product</h1><p>Product missing</p><form action="/search"><input name="q"/></form>',
  '<h1 id="product-title"></h1><p>Product missing</p><form action="/search"></form>',
  '<h1 id="product-title">Fixture product</h1><section id="product-variants"><form action="/search"><input name="q"/></form></section>',
  '<h1 id="product-title">Fixture product</h1><section id="product-variants" hidden><form><input name="quantity" value="1"/></form></section>',
])('rejects empty product titles, empty variants and unrelated search forms (%#)', (markup) => {
  const row = { ...selectedRow, persona: 'anonymous', route: PRODUCT_ROUTE, surface: 'storefront' };
  expect(oracle(`<main>${markup}</main>`, row)).toContain('Missing product title and product purchase/variant markup');
});

it.each([
  productHtml.replace('Fixture product', ''),
  productHtml.replace('Fixture product', '&nbsp;'),
  productHtml.replace('id="product-title"', 'id="product-title" hidden'),
  productHtml.replace('value="1"', 'value=""'),
  productHtml.replace('Koupit (ks)', ''),
  productHtml.replace('class="akros-variant-table__order"', 'class="akros-variant-table__order" hidden'),
])('requires title text and populated visible purchase controls independently (%#)', (html) => {
  const row = { ...selectedRow, persona: 'anonymous', route: PRODUCT_ROUTE, surface: 'storefront' };
  expect(oracle(html, row)).toContain('Missing product title and product purchase/variant markup');
});

it.effect.each([
  [],
  [ROWS_FLAG, ANONYMOUS_HOME],
  args('unknown:anonymous', 1),
  args('home:anonymous,home:anonymous', 2),
  [CAP_FLAG, '0', ROWS_FLAG, ANONYMOUS_HOME],
  [CAP_FLAG, '1.5', ROWS_FLAG, ANONYMOUS_HOME],
  [...args(ANONYMOUS_HOME, 1), '--unexpected', 'yes'],
  [...args(ANONYMOUS_HOME, 1), CAP_FLAG, '2'],
])('refuses unbounded or ambiguous command arguments (%#)', (input) =>
  Effect.gen(function* rejectsInvalidArgs() {
    const error = yield* Effect.flip(parseReadinessArgs(input));
    expect(error).toBeInstanceOf(ReadinessFailure);
  }),
);

it.effect('preflights auth/cleanup cost, credentials, target origins and fixture-specific tokens', () =>
  Effect.gen(function* preflight() {
    const invalid = [
      configureReadiness(args(SELECTED_ROW, 2), env),
      configureReadiness(args(SELECTED_ROW, 3), { ...env, STAGE_READINESS_SELECTED_PASSWORD: '' }),
      configureReadiness(args(SELECTED_ROW, 3), { ...env, STAGE_READINESS_PRIMARY_TEXT: '{}' }),
      configureReadiness(args(ANONYMOUS_HOME, 1), { ...env, STAGE_SHELL_URL: 'https://shell.example.test/path' }),
    ];
    for (const check of invalid) {
      expect(yield* Effect.flip(check)).toBeInstanceOf(ReadinessFailure);
    }
    const config = yield* configureReadiness(args('finance:selected-company,home:companyless,home:expired', 9), env);
    expect(config.plannedRequests).toBe(9);
    expect(READINESS_ROWS).toHaveLength(31);
  }),
);

it.effect('records TTFB separately from complete body consumption and keeps the fixed 1500ms budget', () =>
  Effect.gen(function* completeBodyTiming() {
    const test = fixture(args(SELECTED_ROW, 3), (url) => {
      if (url.endsWith('/sign-in')) {
        return Effect.succeed(issuedResponse());
      }
      return url.endsWith('/sign-out')
        ? Effect.succeed(response(''))
        : Effect.sleep('100 millis').pipe(
            Effect.as({ ...response(selectedHtml), body: Effect.sleep('1401 millis').pipe(Effect.as(selectedHtml)) }),
          );
    });
    const fiber = yield* Effect.forkChild(test.run);
    yield* TestClock.adjust('1501 millis');
    const report = yield* Fiber.join(fiber);
    expect(report.documentBudgetMs).toBe(1500);
    expect(report.results[1]).toMatchObject({
      documentBudgetPassed: false,
      functional: true,
      responseEndMs: 1501,
      status: 200,
      ttfbMs: 100,
    });
    expect(report.failures).toHaveLength(1);
    expect(report.requestCount).toBe(3);
    expect(report.freshDataCompletion).toContain('unavailable');
    expect(test.calls.at(-1)?.url).toContain(SIGN_OUT_PATH);
    expect(JSON.stringify(report)).not.toContain(fixturePassword);
    expect(JSON.stringify(report)).not.toContain('ontos.session');
  }),
);

it.effect('releases the issued session after failed sign-in body consumption', () =>
  Effect.gen(function* signInBodyFailure() {
    const test = fixture(args(SELECTED_ROW, 3), (url) =>
      Effect.succeed(
        url.endsWith('/sign-in')
          ? { ...issuedResponse(), body: Effect.fail(new ReadinessFailure({ message: 'body failed' })) }
          : response(''),
      ),
    );
    const report = yield* test.run;
    expect(report.failures).toContainEqual({ error: 'body failed', label: 'selected-company' });
    expect(test.calls.at(-1)?.url).toContain(SIGN_OUT_PATH);
    expect(new Headers(test.calls.at(-1)?.init.headers).get('cookie')).toBe('ontos.session=fixture');
    expect(test.calls).toHaveLength(2);
  }),
);

it.effect('signs out on functional failure and records cleanup failures without exceeding the cap', () =>
  Effect.gen(function* failedOraclesAndCleanup() {
    const test = fixture(args(SELECTED_ROW, 3), (url) =>
      Effect.succeed(
        url.endsWith('/sign-in') ? issuedResponse() : response(unavailableHtml, url.endsWith('/sign-out') ? 503 : 200),
      ),
    );
    const report = yield* test.run;
    expect(report.results[1]?.functional).toBe(false);
    expect(report.failures.some((failure) => failure.label === 'sign-out')).toBe(true);
    expect(report.requestCount).toBe(3);
  }),
);

it.effect('aborts and signs out exactly once when cancelled after sign-in', () =>
  Effect.gen(function* interruptedPass() {
    const started = yield* Deferred.make<boolean>();
    const test = fixture(args(SELECTED_ROW, 3), (url) =>
      url.endsWith('/cs/finance')
        ? Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never))
        : Effect.succeed(url.endsWith('/sign-in') ? issuedResponse() : response('')),
    );
    const fiber = yield* Effect.forkChild(test.run);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(test.calls.filter((call) => call.url.endsWith('/sign-out'))).toHaveLength(1);
    expect(test.calls[1]?.init.signal?.aborted).toBe(true);
  }),
);

it.effect('bounds a stalled native sign-out body independently to ten seconds', () =>
  Effect.gen(function* boundedSignOut() {
    const test = fixture(args(SELECTED_ROW, 3), (url) => {
      if (url.endsWith('/sign-in')) {
        return Effect.succeed(issuedResponse());
      }
      if (url.endsWith('/sign-out')) {
        return Effect.succeed({ ...response(''), body: Effect.never });
      }
      return Effect.succeed(response(selectedHtml));
    });
    const fiber = yield* Effect.forkChild(test.run);
    yield* TestClock.adjust('10 seconds');
    const report = yield* Fiber.join(fiber);
    expect(report.failures).toContainEqual({ error: 'Request/body timeout', label: 'sign-out' });
    expect(test.calls.at(-1)?.init.signal?.aborted).toBe(true);
  }),
);

it.effect('probes expired authority only after native session revocation, with no redirect following', () =>
  Effect.gen(function* expiredPersona() {
    const test = fixture(args('home:expired', 3), (url) => {
      if (url.endsWith('/sign-in')) {
        return Effect.succeed(issuedResponse());
      }
      if (url.endsWith('/sign-out')) {
        return Effect.succeed(response(''));
      }
      return Effect.succeed(response('', 302, new Headers({ location: '/cs/login?reason=expired' })));
    });
    const report = yield* test.run;
    expect(test.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/shell-super-app-api/auth/sign-in',
      '/shell-super-app-api/auth/sign-out',
      '/cs',
    ]);
    expect(test.calls.every((call) => call.init.redirect === 'manual')).toBe(true);
    expect(new Headers(test.calls[2]?.init.headers).get('cookie')).toBe('ontos.session=fixture');
    expect(report.failures).toEqual([]);
    expect(report.requestCount).toBe(3);
  }),
);

it.effect('retains known status and TTFB but never invents responseEnd after document body failure', () =>
  Effect.gen(function* incompleteDocument() {
    const test = fixture(args(SELECTED_ROW, 3), (url) => {
      if (url.endsWith('/sign-in')) {
        return Effect.succeed(issuedResponse());
      }
      if (url.endsWith('/sign-out')) {
        return Effect.succeed(response(''));
      }
      return Effect.succeed({
        ...response(selectedHtml),
        body: Effect.fail(new ReadinessFailure({ message: 'incomplete document body' })),
      });
    });
    const report = yield* test.run;
    expect(report.results[1]).toMatchObject({ label: SELECTED_ROW, status: 200, ttfbMs: 0 });
    expect(report.results[1]).not.toHaveProperty('responseEndMs');
    expect(report.failures).toContainEqual({ error: 'incomplete document body', label: SELECTED_ROW });
    expect(report.requestCount).toBe(3);
    expect(test.calls.at(-1)?.url).toContain(SIGN_OUT_PATH);
  }),
);

it('does not mistake promotional links and a hero image for populated product cards', () => {
  const row = { ...selectedRow, persona: 'anonymous', route: 'storefront-home', surface: 'storefront' };
  expect(
    oracle('<main><h1>Obchod</h1><img src="/hero.webp"/><a href="/produkt/fixture">Promo</a></main>', row).length,
  ).toBeGreaterThan(0);
});

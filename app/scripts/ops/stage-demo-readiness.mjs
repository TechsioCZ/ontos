// Supplemental, opt-in HTTP readiness checks. No default target, retries, redirects or catalog crawl.
// See .codex/plans/latency3-route-matrix.matrix.md for configuration and coverage limits.
import { createRequire } from 'node:module';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Clock, Config, Console, Data, Duration, Effect, Redacted, Ref, Schema } from 'effect';

import { Command, Flag } from 'effect/cli';

import { SignInPayloadSchema } from '../../apps/shell-super-app/shared/api.ts';
import { DOCUMENT_ACCEPTANCE_MS } from './stage-demo-verify.mjs';

/** @typedef {{id: string, path: string, persona: string, primaryText?: readonly string[], route: string, surface: string}} ReadinessRow */
/** @typedef {{email: string, password: string}} Credentials */
/** @typedef {{companyId: string | undefined, credentials: Record<string, Credentials>, maxRequests: number, plannedRequests: number, rows: ReadinessRow[], shellUrl: string | undefined, storefrontUrl: string | undefined}} ReadinessConfig */
/** @typedef {{documentBudgetPassed?: boolean, functional?: boolean, label: string, responseEndMs?: number, status?: number, ttfbMs?: number}} ReadinessTiming */
/** @typedef {{error: string, label: string}} FailureRecord */
const CAP_FLAG = '--max-requests';
const ROWS_FLAG = '--rows';
const SELECTED = 'selected-company';
const AUTH_PATH = '/shell-super-app-api/auth/';
const PERSONAS = ['anonymous', 'companyless', SELECTED, 'expired'];
const SHELL_ROUTES = [
  ['home', '/cs'],
  ['crm', '/cs/crm/klienti'],
  ['finance', '/cs/finance'],
  ['finance-plan', '/cs/finance?tab=plan'],
  ['invoice-detail', '/cs/finance'],
  ['people-roles', '/cs/sprava/lide-a-role'],
  ['operations', '/cs/provoz/majetek'],
];

/** Finite IDs; no discovery requests. @type {ReadinessRow[]} */
export const READINESS_ROWS = [
  ...SHELL_ROUTES.flatMap(([route, path]) =>
    PERSONAS.map((persona) => ({ id: `${route}:${persona}`, path, persona, route, surface: 'shell' })),
  ),
  ...[
    ['storefront-home', '/'],
    ['storefront-category', '/kategorie/srouby'],
    ['storefront-product', '/produkt/podlozky-ploche-din-125a-a2'],
  ].map(([route, path]) => ({ id: `${route}:anonymous`, path, persona: 'anonymous', route, surface: 'storefront' })),
];

export class ReadinessFailure extends Data.TaggedError('ReadinessFailure') {
  /** @param {{message: string}} fields Safe operator-facing failure. */
  constructor(fields) {
    super(fields);
    this.message = fields.message;
  }
}
/** @param {string} message Safe diagnostic, never credentials or response bodies. */
const fail = (message) => new ReadinessFailure({ message });
/** @param {string | undefined} value Input. @param {string} label Setting name. */
const requireValue = (value, label) =>
  value !== undefined && value.trim() !== '' ? Effect.succeed(value) : Effect.fail(fail(`${label} is required`));

/** Refuse unbounded or unknown selections before HTTP. @param {string[]} args CLI arguments. */
export const parseReadinessArgs = (args) =>
  Effect.gen(function* parseArgs() {
    /** @type {Map<string, string>} */
    const flags = new Map();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      if (![ROWS_FLAG, CAP_FLAG].includes(key) || flags.has(key)) {
        return yield* Effect.fail(fail('Only one --rows and one --max-requests are accepted'));
      }
      flags.set(key, yield* requireValue(args[index + 1], key));
    }
    const cap = flags.get(CAP_FLAG);
    if (cap === undefined || !/^[1-9]\d*$/u.test(cap) || !Number.isSafeInteger(Number(cap))) {
      return yield* Effect.fail(fail('An explicit positive integer --max-requests is required'));
    }
    const ids = (yield* requireValue(flags.get(ROWS_FLAG), ROWS_FLAG)).split(',');
    const found = ids.map((id) => READINESS_ROWS.find((row) => row.id === id));
    const rows = found.filter((row) => row !== undefined);
    if (rows.length !== ids.length || new Set(ids).size !== ids.length) {
      return yield* Effect.fail(fail('--rows must contain unique known row IDs'));
    }
    return { maxRequests: Number(cap), rows };
  });

/** @param {string | undefined} value Origin input. @param {string} label Setting name. */
const originOf = (value, label) =>
  Effect.gen(function* validateOrigin() {
    const input = yield* requireValue(value, label);
    const url = yield* Effect.try({ catch: () => fail(`${label} is not a URL`), try: () => new URL(input) });
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      url.href !== `${url.origin}/`
    ) {
      return yield* Effect.fail(
        fail(`${label} must be an HTTP(S) origin without credentials, path, query or fragment`),
      );
    }
    return url.origin;
  });

/** Validate selection and reserve cleanup cost. @param {string[]} args CLI arguments. @param {Record<string, string | undefined>} env Settings. @returns {Effect.Effect<ReadinessConfig, ReadinessFailure>} Validated configuration. */
export const configureReadiness = (args, env) =>
  Effect.gen(function* configure() {
    const selection = yield* parseReadinessArgs(args);
    const shellRows = selection.rows.filter((row) => row.surface === 'shell');
    const personas = new Set(shellRows.map((row) => row.persona).filter((persona) => persona !== 'anonymous'));
    const plannedRequests = selection.rows.length + personas.size * 2;
    if (plannedRequests > selection.maxRequests) {
      return yield* Effect.fail(
        fail(
          `Selected rows need ${plannedRequests} requests including native sign-out; cap is ${selection.maxRequests}`,
        ),
      );
    }
    const shellUrl = shellRows.length > 0 ? yield* originOf(env.STAGE_SHELL_URL, 'STAGE_SHELL_URL') : undefined;
    const storefrontUrl = selection.rows.some((row) => row.surface === 'storefront')
      ? yield* originOf(env.STAGE_STOREFRONT_URL, 'STAGE_STOREFRONT_URL')
      : undefined;
    /** @type {Record<string, Credentials>} */
    const credentials = {};
    for (const persona of personas) {
      const prefix = persona === 'companyless' ? 'STAGE_READINESS_COMPANYLESS' : 'STAGE_READINESS_SELECTED';
      credentials[persona] = {
        email: yield* requireValue(env[`${prefix}_EMAIL`], `${prefix}_EMAIL`),
        password: yield* requireValue(env[`${prefix}_PASSWORD`], `${prefix}_PASSWORD`),
      };
    }
    const companyId = personas.has(SELECTED)
      ? yield* requireValue(env.STAGE_READINESS_COMPANY_ID, 'STAGE_READINESS_COMPANY_ID')
      : undefined;
    const markers = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(Schema.String))),
    )(env.STAGE_READINESS_PRIMARY_TEXT ?? '{}').pipe(
      Effect.mapError(() => fail('STAGE_READINESS_PRIMARY_TEXT must map row IDs to string arrays')),
    );
    /** @type {ReadinessRow[]} */
    const rows = [];
    for (const row of selection.rows) {
      const primaryText = markers[row.id] ?? [];
      const authenticated = row.persona === SELECTED || row.persona === 'companyless';
      if (authenticated && (primaryText.length === 0 || primaryText.some((text) => text.trim() === ''))) {
        return yield* Effect.fail(
          fail(`STAGE_READINESS_PRIMARY_TEXT needs nonempty visible primary-content tokens for ${row.id}`),
        );
      }
      const path =
        row.route === 'invoice-detail'
          ? `/cs/finance?resourceId=${encodeURIComponent(yield* requireValue(env.STAGE_READINESS_INVOICE_ID, 'STAGE_READINESS_INVOICE_ID'))}`
          : row.path;
      rows.push({ ...row, path, primaryText: authenticated ? primaryText : [] });
    }
    return { ...selection, companyId, credentials, plannedRequests, rows, shellUrl, storefrontUrl };
  });

// Reuse the Shell workspace's declared parser dependency; do not depend on a hoisted/transitive package.
/** @type {(id: 'happy-dom') => typeof import('../../apps/shell-super-app/node_modules/happy-dom/lib/index.js')} */
const requireParser = createRequire(new URL('../../apps/shell-super-app/package.json', import.meta.url));
const { Window } = requireParser('happy-dom');
const parserWindow = new Window({
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptFileLoading: true,
    enableJavaScriptEvaluation: false,
    navigation: { disableChildFrameNavigation: true, disableMainFrameNavigation: true },
  },
});
const parser = new parserWindow.DOMParser();
/** @typedef {import('../../apps/shell-super-app/node_modules/happy-dom/lib/index.js').Element} HtmlElement */
/** @typedef {import('../../apps/shell-super-app/node_modules/happy-dom/lib/index.js').Node} HtmlNode */

// DOMParser creates an inert document: no scripts, stylesheets, frames or other resources are loaded.
// These remain HTML oracles, not computed CSS, browser paint or hydration measurements.
/** @param {HtmlNode | null} node Parsed element or text node. @returns {string} Decoded normalized text. */
const textOf = (node) => {
  if (node === null || ![1, 3].includes(node.nodeType)) {
    return '';
  }
  // Preserve boundaries between adjacent table cells/blocks without decoding entities twice.
  const text = node.nodeType === 3 ? node.textContent : [...node.childNodes].map(textOf).join(' ');
  return text.replaceAll(/\s+/gu, ' ').trim();
};
/** @param {HtmlElement} element Parsed element. */
const explicitlyHidden = (element) =>
  element.hasAttribute('hidden') ||
  element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true' ||
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/iu.test(
    element.getAttribute('style') ?? '',
  );
/** @param {string} html Raw document. */
const primaryDocument = (html) => {
  const document = parser.parseFromString(html, 'text/html');
  // Authority is intentionally inspected before removing hidden native selectors.
  const select = document.querySelector('select[name="legalEntity"]');
  const actualCompany =
    select === null ? undefined : (select.querySelector('option[selected]')?.getAttribute('value') ?? '');
  for (const element of document.querySelectorAll('head, script, style, template')) {
    element.remove();
  }
  for (const element of document.querySelectorAll('*')) {
    if (explicitlyHidden(element)) {
      element.remove();
    }
  }
  return { actualCompany, main: document.querySelector('main') };
};
/** @param {HtmlElement | null} main Visible primary markup. */
const hasProductPurchase = (main) =>
  [...(main?.querySelectorAll('#product-variants .akros-variant-table__order, .akros-purchase-form') ?? [])].some(
    (controls) =>
      [...controls.querySelectorAll('input[value]')].some(
        (input) => (input.getAttribute('value') ?? '').trim() !== '',
      ) && [...controls.querySelectorAll('button')].some((button) => textOf(button) !== ''),
  );

/** @param {HtmlElement | null} main Visible primary markup. */
const hasProductListing = (main) => {
  const listing = main?.querySelector(
    '[data-akros-product-listing="catalog"], [data-akros-product-listing="featured"]',
  );
  return [...(listing?.querySelectorAll('article') ?? [])].some(
    (card) => card.querySelector('a[href^="/produkt/"]') !== null && card.querySelector('img') !== null,
  );
};

/** @param {ReadinessRow} row Selection. @param {string | undefined} actualCompany Native selector value. @param {HtmlElement | null} main Visible primary markup. @param {string} text Primary text. @param {string | undefined} companyId Expected company. */
const checkPrimaryHtml = (row, actualCompany, main, text, companyId) => {
  const errors = [];
  if (row.surface === 'shell') {
    if (row.persona === SELECTED && (actualCompany !== companyId || companyId === undefined || companyId === '')) {
      errors.push('Selected legal entity does not match the expected company');
    }
    if (row.persona === 'companyless' && (actualCompany === undefined || !['', 'tenant'].includes(actualCompany))) {
      errors.push('Expected explicit companyless selector, not a selected company');
    }
    if (
      row.primaryText === undefined ||
      row.primaryText.length === 0 ||
      !row.primaryText.every((token) => text.includes(token))
    ) {
      errors.push('Missing expected populated primary-content tokens');
    }
  } else if (row.route === 'storefront-product') {
    if (textOf(main?.querySelector('h1#product-title') ?? null) === '' || !hasProductPurchase(main)) {
      errors.push('Missing product title and product purchase/variant markup');
    }
  } else if (!hasProductListing(main)) {
    errors.push('Missing populated product links and images');
  }
  return errors;
};

/** Fail closed on missing functional HTML. @param {{companyId?: string, headers?: Headers, html: string, row: ReadinessRow, status: number}} input Consumed document. */
export const checkReadinessHtml = ({ companyId, headers = new Headers(), html, row, status }) => {
  const errors = [];
  const { actualCompany, main } = primaryDocument(html);
  const text = textOf(main);
  const denied = row.surface === 'shell' && ['anonymous', 'expired'].includes(row.persona);
  if (denied && [302, 303, 307, 308].includes(status)) {
    const location = headers.get('location');
    // Relative native login redirect only; never silently accept an external or unrelated redirect.
    if (location === null || !/^\/cs\/login(?:[?#]|$)/u.test(location)) {
      errors.push('Expected native /cs/login denial redirect');
    }
    return errors;
  }
  if (status !== 200) {
    errors.push(`Unexpected HTTP ${status}`);
  }
  if (headers.get('content-type')?.includes('text/html') !== true) {
    errors.push('Expected HTML content-type');
  }
  if (text === '') {
    errors.push('Missing populated main content (empty/unauthorized shell)');
  }
  if (
    /unavailable|temporarily unavailable|dočasně nedostup|dočasně nedostupné|něco se pokazilo|something went wrong|internal server error|application error|znovu načtěte stránku/iu.test(
      text,
    )
  ) {
    errors.push('Unavailable/error page is not functional readiness');
  }
  if (denied) {
    if (
      main === null ||
      main.querySelector('form') === null ||
      main.querySelector('input[type="password"]') === null ||
      actualCompany !== undefined
    ) {
      errors.push('Expected native login form, not an unauthorized application shell');
    }
    return errors;
  }
  return [...errors, ...checkPrimaryHtml(row, actualCompany, main, text, companyId)];
};

/** @typedef {{status: number, headers: Headers, body: Effect.Effect<string, ReadinessFailure>}} ReadinessResponse */
/** @typedef {(url: string, init: RequestInit) => Effect.Effect<ReadinessResponse, ReadinessFailure>} ReadinessTransport */
/** Native Promise use stays inside this private HTTP edge. @type {ReadinessTransport} */
const fetchTransport = (url, init) =>
  Effect.tryPromise({
    catch: () => fail('HTTP transport failed'),
    try: fetch.bind(globalThis, url, init),
  }).pipe(
    Effect.map((response) => ({
      body: Effect.tryPromise({ catch: () => fail('HTTP body consumption failed'), try: response.text.bind(response) }),
      headers: response.headers,
      status: response.status,
    })),
  );
/** @param {bigint} start Monotonic request start. */
const millisSince = (start) =>
  Clock.monotonicTimeNanos.pipe(Effect.map((now) => Duration.toMillis(Duration.nanos(now - start))));

/** @param {AbortController} controller Owned request. */
const abortRequest = (controller) => Effect.sync(() => controller.abort());
/** @param {ReadinessResponse} response Issued session headers. */
const cookieFrom = (response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
/** @param {FailureRecord[]} failures Report sink. */
const recordInto = (failures) => {
  /** @param {string} label Request ID. */
  const forLabel = (label) => {
    /** @param {ReadinessFailure} failure Safe typed failure. */
    const retain = (failure) =>
      Effect.sync(() => {
        failures.push({ error: failure.message, label });
      });
    return retain;
  };
  return forLabel;
};

/** @param {ReadinessConfig} config Validated settings. @param {ReadinessTransport} transport HTTP edge. */
const makeReadinessPass = (config, transport) => {
  /** @type {ReadinessTiming[]} */
  const results = [];
  /** @type {FailureRecord[]} */
  const failures = [];
  const counter = { requestCount: 0 };
  /** @param {string} label Request ID. @param {string} url Target. @param {RequestInit} [init] Options. @param {(response: ReadinessResponse) => Effect.Effect<void>} [receiveHeaders] Session acquisition. @param {number} [timeoutMs] Deadline. */
  const request = (label, url, init = {}, receiveHeaders = () => Effect.void, timeoutMs = 60_000) =>
    Effect.scoped(
      Effect.gen(function* boundedRequest() {
        if (counter.requestCount >= config.maxRequests) {
          return yield* Effect.fail(fail('Request cap exhausted'));
        }
        counter.requestCount += 1;
        /** @type {ReadinessTiming} */
        const timing = { label };
        results.push(timing);
        const start = yield* Clock.monotonicTimeNanos;
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          abortRequest,
        );
        const response = yield* Effect.uninterruptibleMask((restore) =>
          restore(transport(url, { ...init, redirect: 'manual', signal: controller.signal })).pipe(
            Effect.tap(receiveHeaders),
          ),
        );
        timing.status = response.status;
        timing.ttfbMs = yield* millisSince(start);
        const html = yield* response.body;
        const responseEndMs = yield* millisSince(start);
        timing.responseEndMs = responseEndMs;
        return { ...response, html, responseEndMs };
      }),
    ).pipe(
      Effect.interruptible,
      Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(fail('Request/body timeout')) }),
    );
  const recordError = recordInto(failures);
  /** @param {Ref.Ref<string>} session Owned session. */
  const signOut = (session) =>
    Ref.get(session).pipe(
      Effect.flatMap((cookie) =>
        cookie === ''
          ? Effect.void
          : request(
              'sign-out',
              `${config.shellUrl}${AUTH_PATH}sign-out`,
              { headers: { cookie, origin: config.shellUrl }, method: 'POST' },
              undefined,
              10_000,
            ).pipe(
              Effect.flatMap((response) =>
                response.status === 200
                  ? Ref.set(session, '')
                  : Effect.fail(fail(`Native sign-out answered ${response.status}`)),
              ),
              Effect.catchTag('ReadinessFailure', recordError('sign-out')),
            ),
      ),
    );
  /** @param {ReadinessRow} row Selected row. @param {string} cookie Owned cookie. */
  const probeRow = (row, cookie) =>
    request(row.id, `${row.surface === 'shell' ? config.shellUrl : config.storefrontUrl}${row.path}`, {
      headers: cookie === '' ? {} : { cookie },
    }).pipe(
      Effect.map((response) => {
        const errors = checkReadinessHtml({ row, ...response, companyId: config.companyId });
        const documentBudgetPassed = response.responseEndMs <= DOCUMENT_ACCEPTANCE_MS;
        const timing = results.at(-1);
        if (timing !== undefined) {
          timing.functional = errors.length === 0;
          timing.documentBudgetPassed = documentBudgetPassed;
        }
        for (const error of errors) {
          failures.push({ error, label: row.id });
        }
        if (!documentBudgetPassed) {
          failures.push({ error: `Complete response exceeds ${DOCUMENT_ACCEPTANCE_MS}ms`, label: row.id });
        }
        return response;
      }),
      Effect.catchTag('ReadinessFailure', recordError(row.id)),
    );
  return { counter, failures, probeRow, recordError, request, results, signOut };
};

/** Sequential owned sessions; count auth and cleanup. @param {ReadinessConfig} config Validated settings. @param {ReadinessTransport} [transport] HTTP edge. */
export const verifyReadiness = (config, transport = fetchTransport) =>
  Effect.gen(function* readinessPass() {
    const { counter, failures, probeRow, recordError, request, results, signOut } = makeReadinessPass(
      config,
      transport,
    );
    for (const persona of PERSONAS) {
      const rows = config.rows.filter((row) => row.persona === persona);
      if (rows.length === 0) {
        continue;
      }
      const pass =
        persona === 'anonymous'
          ? Effect.forEach(rows, (row) => probeRow(row, ''), { concurrency: 1, discard: true })
          : Effect.scoped(
              Effect.gen(function* ownedPersona() {
                const session = yield* Effect.acquireRelease(Ref.make(''), signOut);
                const credential = config.credentials[persona];
                const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(SignInPayloadSchema)))(
                  {
                    ...credential,
                    password: Redacted.make(credential.password),
                  },
                ).pipe(Effect.mapError(() => fail('Invalid sign-in credentials')));
                const response = yield* request(
                  `sign-in:${persona}`,
                  `${config.shellUrl}${AUTH_PATH}sign-in`,
                  {
                    body,
                    headers: { 'content-type': 'application/json', origin: config.shellUrl },
                    method: 'POST',
                  },
                  (received) => Ref.set(session, cookieFrom(received)),
                );
                const cookie = yield* Ref.get(session);
                if (response.status !== 200 || cookie === '') {
                  return yield* Effect.fail(fail('Native sign-in failed or returned no session cookie'));
                }
                if (persona === 'expired') {
                  // Revoke a genuinely issued session rather than mislabelling a fabricated cookie as expired.
                  yield* signOut(session);
                  if ((yield* Ref.get(session)) !== '') {
                    return yield* Effect.fail(fail('Cannot probe expired persona: native revocation failed'));
                  }
                }
                return yield* Effect.forEach(rows, (row) => probeRow(row, cookie), { concurrency: 1, discard: true });
              }),
            ).pipe(Effect.catchTag('ReadinessFailure', recordError(persona)));
      yield* pass;
    }
    return {
      documentBudgetMs: DOCUMENT_ACCEPTANCE_MS,
      failures,
      freshDataCompletion: 'unavailable: HTTP-only; no browser or background reads',
      intentRequestCost: 'unavailable: no in-app navigation or speculative requests executed',
      plannedRequests: config.plannedRequests,
      requestCount: counter.requestCount,
      results,
      usablePrimaryContentMs: 'unavailable: HTML oracle is not a browser paint/hydration measurement',
    };
  });

const ReportSchema = Schema.fromJsonString(
  Schema.Struct({
    documentBudgetMs: Schema.Number,
    failures: Schema.Array(Schema.Struct({ error: Schema.String, label: Schema.String })),
    freshDataCompletion: Schema.String,
    intentRequestCost: Schema.String,
    plannedRequests: Schema.Number,
    requestCount: Schema.Number,
    results: Schema.Array(
      Schema.Struct({
        documentBudgetPassed: Schema.optionalKey(Schema.Boolean),
        functional: Schema.optionalKey(Schema.Boolean),
        label: Schema.String,
        responseEndMs: Schema.optionalKey(Schema.Number),
        status: Schema.optionalKey(Schema.Number),
        ttfbMs: Schema.optionalKey(Schema.Number),
      }),
    ),
    usablePrimaryContentMs: Schema.String,
  }),
);

/** @param {string[]} args CLI arguments. @param {Record<string, string | undefined>} env Environment. */
export const readinessFromConfig = (args, env) =>
  configureReadiness(args, env).pipe(
    Effect.flatMap((config) => verifyReadiness(config)),
    Effect.tap((report) => Schema.encodeEffect(ReportSchema)(report).pipe(Effect.flatMap(Console.log))),
    Effect.flatMap((report) =>
      report.failures.length > 0 ? Effect.fail(fail('Supplemental readiness FAILED')) : Effect.void,
    ),
  );

const environment = Config.all({
  STAGE_READINESS_COMPANY_ID: Config.String('STAGE_READINESS_COMPANY_ID').pipe(Config.withDefault('')),
  STAGE_READINESS_COMPANYLESS_EMAIL: Config.String('STAGE_READINESS_COMPANYLESS_EMAIL').pipe(Config.withDefault('')),
  STAGE_READINESS_COMPANYLESS_PASSWORD: Config.Redacted('STAGE_READINESS_COMPANYLESS_PASSWORD').pipe(
    Config.withDefault(Redacted.make('')),
    Config.map(Redacted.value),
  ),
  STAGE_READINESS_INVOICE_ID: Config.String('STAGE_READINESS_INVOICE_ID').pipe(Config.withDefault('')),
  STAGE_READINESS_PRIMARY_TEXT: Config.String('STAGE_READINESS_PRIMARY_TEXT').pipe(Config.withDefault('{}')),
  STAGE_READINESS_SELECTED_EMAIL: Config.String('STAGE_READINESS_SELECTED_EMAIL').pipe(Config.withDefault('')),
  STAGE_READINESS_SELECTED_PASSWORD: Config.Redacted('STAGE_READINESS_SELECTED_PASSWORD').pipe(
    Config.withDefault(Redacted.make('')),
    Config.map(Redacted.value),
  ),
  STAGE_SHELL_URL: Config.String('STAGE_SHELL_URL').pipe(Config.withDefault('')),
  STAGE_STOREFRONT_URL: Config.String('STAGE_STOREFRONT_URL').pipe(Config.withDefault('')),
});
const command = Command.make(
  'stage-demo-readiness',
  {
    maxRequests: Flag.Int('max-requests'),
    rows: Flag.String('rows'),
  },
  ({ maxRequests, rows }) =>
    environment.pipe(
      Effect.flatMap((env) => readinessFromConfig([ROWS_FLAG, rows, CAP_FLAG, String(maxRequests)], env)),
    ),
);

if (import.meta.main) {
  NodeRuntime.runMain(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}

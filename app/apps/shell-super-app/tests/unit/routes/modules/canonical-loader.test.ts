import { createMemoryHistory, createRouter, isNotFound, isRedirect } from '@modern-js/plugin-tanstack/runtime';
import type { AnyRedirect } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ResolvedModuleTargetSchema,
  ShellTargetForbiddenProblemSchema,
  ShellTargetNotFoundProblemSchema,
} from '../../../../shared/browser-api.ts';
import {
  canonicalPathFromRequest,
  legacyCanonicalRedirects,
  loader,
} from '../../../../src/routes/[lang]/canonical-page-model.ts';
import { routeTree } from '../../../../src/modern-tanstack/index/router.gen.ts';
import {
  adaSignedIn,
  makeShellBff,
  shellCompositionRevision,
  signedInShellReads,
} from '../../../support/shell-bff-double.ts';
import type { ShellBffScript } from '../../../support/shell-bff-double.ts';

const target = Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
  appId: 'future-module',
  componentKey: 'future.module.order-detail',
  compositionRevision: shellCompositionRevision,
  entrypointKey: 'future.module.page.order-detail',
  federation: {
    expose: './OrderDetail',
    manifest: { sha256: 'a'.repeat(64), url: 'https://assets.example.test/future/release-a/mf-manifest.json' },
    remoteName: 'futureModuleReleaseA',
  },
  moduleId: 'future.module',
  routeParameters: { orderId: 'order 42' },
  writable: false,
});

const problem = { detail: 'redacted', title: 'redacted', type: 'about:blank' } as const;
const targetForbidden = Schema.decodeUnknownSync(ShellTargetForbiddenProblemSchema)({
  ...problem,
  _tag: 'ShellTargetForbiddenProblem',
  status: 403,
});
const targetNotFound = Schema.decodeUnknownSync(ShellTargetNotFoundProblemSchema)({
  ...problem,
  _tag: 'ShellTargetNotFoundProblem',
  status: 404,
});

const requestFor = (pathname: string) =>
  new Request(`https://shell.example.test${pathname}`, { headers: { cookie: 'session=test-session' } });

const resolveRedirectResponse = (redirect: AnyRedirect, request: Request): Response => {
  const url = new URL(request.url);
  const router = createRouter({
    context: { request },
    history: createMemoryHistory({ initialEntries: [`${url.pathname}${url.search}`] }),
    isServer: true,
    routeTree,
  });
  return router.resolveRedirect(redirect);
};

/** The Shell BFF of a signed-in Ada that approves the future module target unless a test scripts otherwise. */
const canonicalBff = (overrides: ShellBffScript = {}) =>
  makeShellBff({
    ...signedInShellReads(adaSignedIn),
    resolveModuleTarget: () => Effect.succeed(target),
    ...overrides,
  });
const targetRequests = (bff: ReturnType<typeof canonicalBff>) =>
  bff.requests.filter((received) => received.endpoint === 'resolveModuleTarget').map((received) => received.body);

it.each([
  ['/en/future/orders/order%2042/?moduleId=attacker#identity', 'en', '/future/orders/order%2042'],
  ['/cs/future/orders/order%2042', 'cs', '/future/orders/order%2042'],
  ['/en/future/orders/encoded%2Fsegment', 'en', '/future/orders/encoded%2Fsegment'],
] as const)('preserves encoded canonical segments from %s for server validation', (pathname, language, expected) => {
  expect(canonicalPathFromRequest(requestFor(pathname), language)).toBe(expected);
});

it.live('resolves a newly admitted canonical page without a generated Shell connector', () => {
  const bff = canonicalBff();
  return Effect.gen(function* resolvesNewCanonicalPage() {
    const model = yield* Effect.tryPromise({
      catch: isNotFound,
      try: () =>
        loader({ params: { lang: 'cs' }, request: requestFor('/cs/future/orders/order%2042/?moduleId=attacker') }),
    });

    expect(targetRequests(bff)).toEqual([
      { canonicalPath: '/future/orders/order%2042', compositionRevision: shellCompositionRevision },
    ]);
    expect(model).toMatchObject({ routeParams: { orderId: 'order 42' }, state: 'resolved', target });
  }).pipe(Effect.provide(bff.browser));
});

it.live('retains denial and never exposes a remote target for a canonical path', () => {
  const bff = canonicalBff({ resolveModuleTarget: () => Effect.fail(targetForbidden) });
  return Effect.gen(function* retainsDeniedCanonicalPage() {
    const model = yield* Effect.tryPromise({
      catch: isNotFound,
      try: () => loader({ params: { lang: 'en' }, request: requestFor('/en/future/orders/private') }),
    });
    expect(model).toMatchObject({ state: 'forbidden' });
    expect(model).not.toHaveProperty('target');
  }).pipe(Effect.provide(bff.browser));
});

it.live.each(['/cs/previously-unknown/page', '/cs/sprava/lide'])(
  'keeps Shell not-found recovery for an unregistered canonical target %s',
  (pathname) => {
    const bff = canonicalBff({ resolveModuleTarget: () => Effect.fail(targetNotFound) });
    return Effect.gen(function* reportsShellNotFound() {
      const model = yield* Effect.promise(() => loader({ params: { lang: 'cs' }, request: requestFor(pathname) }));
      expect(model).toMatchObject({ shell: { state: 'authenticated' }, state: 'not_found' });
      expect(model).not.toHaveProperty('target');
      expect(targetRequests(bff)).toEqual([
        { canonicalPath: pathname.slice(3), compositionRevision: shellCompositionRevision },
      ]);
    }).pipe(Effect.provide(bff.browser));
  },
);

it.live.each([
  ['/xx/future/orders/private', 'xx'],
  ['/cs/future/orders/private', 'en'],
  ['/cs/favicon.ico', 'cs'],
  ['/en/favicon.ico', 'en'],
] as const)(
  'rejects non-page assets and unsupported localized prefixes %s before target resolution',
  ([pathname, language]) => {
    const bff = canonicalBff();
    return Effect.gen(function* rejectsUntrustedLocalePrefix() {
      expect(
        yield* Effect.flip(
          Effect.tryPromise({
            catch: isNotFound,
            try: () => loader({ params: { lang: language }, request: requestFor(pathname) }),
          }),
        ),
      ).toBe(true);
      // Neither the session behind the Shell model nor a target was read.
      expect(bff.requests).toEqual([]);
    }).pipe(Effect.provide(bff.browser));
  },
);

it.live('the generated catchall renders shell recovery for an unknown target', () => {
  const bff = canonicalBff({ resolveModuleTarget: () => Effect.fail(targetNotFound) });
  return Effect.gen(function* reportsGeneratedRouteNotFound() {
    const pathname = '/cs/previously-unknown/page';
    const router = createRouter({
      context: { request: requestFor(pathname) },
      history: createMemoryHistory({ initialEntries: [pathname] }),
      isServer: true,
      routeTree,
    });
    yield* Effect.promise(() => router.load());

    expect(targetRequests(bff)).toEqual([
      { canonicalPath: '/previously-unknown/page', compositionRevision: shellCompositionRevision },
    ]);
    expect(router._serverResult).toMatchObject({ status: 200, type: 'render' });
  }).pipe(Effect.provide(bff.browser));
});

it.live.each([
  ['/siampark/overview', '/nemovitosti/prehled'],
  ['/siampark/properties', '/nemovitosti'],
  ['/siampark/occupancy', '/najmy'],
  ['/siampark/agreements', '/smlouvy'],
  ['/siampark/finance', '/finance'],
  ['/siampark/work', '/ukoly'],
  ['/siampark/relationships', '/aktivity'],
  ['/siampark/provoz/prehled', '/provoz/prehled'],
  ['/siampark/provoz/agenda', '/provoz/agenda'],
  ['/siampark/provoz/majetek', '/provoz/majetek'],
  ['/siampark/provoz/meridla', '/provoz/meridla'],
  ['/siampark/provoz/nakupy', '/provoz/nakupy'],
  ['/siampark/provoz/bezpecnost', '/provoz/bezpecnost'],
  ['/siampark/provoz/dokumenty', '/provoz/dokumenty'],
  ['/provoz/ukoly', '/ukoly'],
  ['/profil', '/profile'],
] as const)('redirects the legacy path %s to %s and keeps the query string', ([legacyPath, domainPath]) => {
  const bff = canonicalBff();
  return Effect.gen(function* redirectsLegacyPath() {
    const request = requestFor(`/cs${legacyPath}/?resourceId=abc%20123&tab=detail`);
    const thrown = yield* Effect.flip(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => loader({ params: { lang: 'cs' }, request }),
      }),
    );
    expect(isRedirect(thrown)).toBe(true);
    if (!isRedirect(thrown)) {
      expect.unreachable('Expected the canonical loader to throw a native redirect Response');
    }
    const response = resolveRedirectResponse(thrown, request);
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe(`/cs${domainPath}?resourceId=abc%20123&tab=detail`);
    expect(bff.requests).toEqual([]);
  }).pipe(Effect.provide(bff.browser));
});

it('maps every legacy path exactly once', () => {
  expect(legacyCanonicalRedirects.get('/siampark/work')).toBe('/ukoly');
  expect(legacyCanonicalRedirects.has('/siampark')).toBe(false);
  expect(legacyCanonicalRedirects.has('/siampark/integrations')).toBe(false);
});

it.live('redirects a legacy path without a query string to the bare domain path', () => {
  const bff = canonicalBff();
  return Effect.gen(function* redirectsBareLegacyPath() {
    const request = requestFor('/en/siampark/finance');
    const thrown = yield* Effect.flip(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => loader({ params: { lang: 'en' }, request }),
      }),
    );
    if (!isRedirect(thrown)) {
      expect.unreachable('Expected the canonical loader to throw a native redirect Response');
    }
    const response = resolveRedirectResponse(thrown, request);
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toBe('/en/finance');
    expect(bff.requests).toEqual([]);
  }).pipe(Effect.provide(bff.browser));
});

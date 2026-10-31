import { createMemoryHistory, createRouter, isNotFound, isRedirect } from '@modern-js/plugin-tanstack/runtime';
import type { AnyRedirect } from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';

import {
  canonicalPathFromRequest,
  legacyCanonicalRedirects,
  loader,
} from '../../../../src/routes/[lang]/canonical-page-model.ts';
import { routeTree } from '../../../../src/modern-tanstack/index/router.gen.ts';

const { loadHomePageModelMock, resolveModuleTargetMock } = rstest.hoisted(() => ({
  loadHomePageModelMock: rstest.fn(),
  resolveModuleTargetMock: rstest.fn(),
}));

rstest.mock('../../../../src/api/auth-client.ts', () => ({
  resolveModuleTarget: resolveModuleTargetMock,
}));

rstest.mock('../../../../src/routes/[lang]/home-page-model.ts', () => ({
  loadHomePageModel: loadHomePageModelMock,
}));

const authenticatedShell = {
  compositionRevision: 'c'.repeat(64),
  contextState: 'authenticated' as const,
  identity: {
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    legalEntityId: 'legal-1',
    legalName: 'Alpha company',
    principalId: 'principal-1',
    tenantId: 'tenant-1',
  },
  legalEntities: { items: [], state: 'available' as const },
  navigation: { items: [], state: 'available' as const },
  selectedLegalEntityId: 'legal-1',
  state: 'authenticated' as const,
  tenants: { items: [], state: 'available' as const },
};

const target = {
  appId: 'future-module',
  componentKey: 'future.module.order-detail',
  compositionRevision: 'c'.repeat(64),
  entrypointKey: 'future.module.page.order-detail',
  federation: {
    expose: './OrderDetail',
    manifest: { sha256: 'a'.repeat(64), url: 'https://assets.example.test/future/release-a/mf-manifest.json' },
    remoteName: 'futureModuleReleaseA',
  },
  moduleId: 'future.module',
  routeParameters: { orderId: 'order 42' },
  writable: false,
};

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

beforeEach(() => {
  loadHomePageModelMock.mockReturnValue(Effect.succeed(authenticatedShell));
  resolveModuleTargetMock.mockReturnValue(Effect.succeed(target));
});

it.each([
  ['/en/future/orders/order%2042/?moduleId=attacker#identity', 'en', '/future/orders/order%2042'],
  ['/cs/future/orders/order%2042', 'cs', '/future/orders/order%2042'],
  ['/en/future/orders/encoded%2Fsegment', 'en', '/future/orders/encoded%2Fsegment'],
] as const)('preserves encoded canonical segments from %s for server validation', (pathname, language, expected) => {
  expect(canonicalPathFromRequest(requestFor(pathname), language)).toBe(expected);
});

it.effect('resolves a newly admitted canonical page without a generated Shell connector', () =>
  Effect.gen(function* resolvesNewCanonicalPage() {
    const model = yield* Effect.tryPromise({
      catch: isNotFound,
      try: () =>
        loader({ params: { lang: 'cs' }, request: requestFor('/cs/future/orders/order%2042/?moduleId=attacker') }),
    });

    expect(resolveModuleTargetMock).toHaveBeenCalledWith(
      { canonicalPath: '/future/orders/order%2042', compositionRevision: 'c'.repeat(64) },
      expect.any(Object),
    );
    expect(model).toMatchObject({ routeParams: { orderId: 'order 42' }, state: 'resolved', target });
  }),
);

it.effect('retains denial and never exposes a remote target for a canonical path', () =>
  Effect.gen(function* retainsDeniedCanonicalPage() {
    resolveModuleTargetMock.mockReturnValueOnce(Effect.fail({ _tag: 'ShellTargetForbiddenProblem' }));
    const model = yield* Effect.tryPromise({
      catch: isNotFound,
      try: () => loader({ params: { lang: 'en' }, request: requestFor('/en/future/orders/private') }),
    });
    expect(model).toMatchObject({ state: 'forbidden' });
    expect(model).not.toHaveProperty('target');
  }),
);

it.effect.each(['/cs/previously-unknown/page', '/cs/sprava/lide'])(
  'keeps Shell not-found recovery for an unregistered canonical target %s',
  (pathname) =>
    Effect.gen(function* reportsShellNotFound() {
      resolveModuleTargetMock.mockReturnValueOnce(Effect.fail({ _tag: 'ShellTargetNotFoundProblem' }));
      const model = yield* Effect.promise(() => loader({ params: { lang: 'cs' }, request: requestFor(pathname) }));
      expect(model).toMatchObject({ shell: authenticatedShell, state: 'not_found' });
      expect(model).not.toHaveProperty('target');
      expect(resolveModuleTargetMock).toHaveBeenCalledWith(
        { canonicalPath: pathname.slice(3), compositionRevision: authenticatedShell.compositionRevision },
        expect.any(Object),
      );
    }),
);

it.effect.each([
  ['/xx/future/orders/private', 'xx'],
  ['/cs/future/orders/private', 'en'],
] as const)(
  'rejects an unsupported or mismatched localized prefix %s before target resolution',
  ([pathname, language]) =>
    Effect.gen(function* rejectsUntrustedLocalePrefix() {
      expect(
        yield* Effect.flip(
          Effect.tryPromise({
            catch: isNotFound,
            try: () => loader({ params: { lang: language }, request: requestFor(pathname) }),
          }),
        ),
      ).toBe(true);
      expect(loadHomePageModelMock).not.toHaveBeenCalled();
      expect(resolveModuleTargetMock).not.toHaveBeenCalled();
    }),
);

it.effect('the generated catchall renders shell recovery for an unknown target', () =>
  Effect.gen(function* reportsGeneratedRouteNotFound() {
    resolveModuleTargetMock.mockReturnValueOnce(Effect.fail({ _tag: 'ShellTargetNotFoundProblem' }));
    const pathname = '/cs/previously-unknown/page';
    const router = createRouter({
      context: { request: requestFor(pathname) },
      history: createMemoryHistory({ initialEntries: [pathname] }),
      isServer: true,
      routeTree,
    });
    yield* Effect.promise(() => router.load());

    expect(resolveModuleTargetMock).toHaveBeenCalledWith(
      { canonicalPath: '/previously-unknown/page', compositionRevision: 'c'.repeat(64) },
      expect.any(Object),
    );
    expect(router._serverResult).toMatchObject({ status: 200, type: 'render' });
  }),
);

it.effect.each([
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
] as const)('redirects the legacy path %s to %s and keeps the query string', ([legacyPath, domainPath]) =>
  Effect.gen(function* redirectsLegacyPath() {
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
    expect(resolveModuleTargetMock).not.toHaveBeenCalled();
  }),
);

it('maps every legacy path exactly once', () => {
  expect(legacyCanonicalRedirects.get('/siampark/work')).toBe('/ukoly');
  expect(legacyCanonicalRedirects.has('/siampark')).toBe(false);
  expect(legacyCanonicalRedirects.has('/siampark/integrations')).toBe(false);
});

it.effect('redirects a legacy path without a query string to the bare domain path', () =>
  Effect.gen(function* redirectsBareLegacyPath() {
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
  }),
);

import { createMemoryHistory, createRouter, isNotFound } from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';

import { canonicalPathFromRequest, loader } from '../../../../src/routes/[lang]/canonical-page-model.ts';
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

it.effect('reports unknown canonical targets through native TanStack not-found handling', () =>
  Effect.gen(function* reportsNativeNotFound() {
    resolveModuleTargetMock.mockReturnValueOnce(Effect.fail({ _tag: 'ShellTargetNotFoundProblem' }));
    const nativeNotFound = yield* Effect.flip(
      Effect.tryPromise({
        catch: isNotFound,
        try: () => loader({ params: { lang: 'en' }, request: requestFor('/en/previously-unknown/page') }),
      }),
    );
    expect(nativeNotFound).toBe(true);
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

it.effect('the generated native catchall returns HTTP 404 for an unknown approved target', () =>
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
    expect(router._serverResult).toMatchObject({ status: 404, type: 'render' });
  }),
);

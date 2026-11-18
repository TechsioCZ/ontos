import { createMemoryHistory, createRouter, isNotFound } from '@modern-js/plugin-tanstack/runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ResolvedModuleTargetSchema,
  ShellTargetForbiddenProblemSchema,
  ShellTargetNotFoundProblemSchema,
} from '../../../../shared/browser-api.ts';
import { canonicalPathFromRequest, loader } from '../../../../src/routes/[lang]/canonical-page-model.ts';
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

it.live('reports unknown canonical targets through native TanStack not-found handling', () => {
  const bff = canonicalBff({ resolveModuleTarget: () => Effect.fail(targetNotFound) });
  return Effect.gen(function* reportsNativeNotFound() {
    const nativeNotFound = yield* Effect.flip(
      Effect.tryPromise({
        catch: isNotFound,
        try: () => loader({ params: { lang: 'en' }, request: requestFor('/en/previously-unknown/page') }),
      }),
    );
    expect(nativeNotFound).toBe(true);
    expect(targetRequests(bff)).toEqual([
      { canonicalPath: '/previously-unknown/page', compositionRevision: shellCompositionRevision },
    ]);
  }).pipe(Effect.provide(bff.browser));
});

it.live.each([
  ['/xx/future/orders/private', 'xx'],
  ['/cs/future/orders/private', 'en'],
] as const)(
  'rejects an unsupported or mismatched localized prefix %s before target resolution',
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

it.live('the generated native catchall returns HTTP 404 for an unknown approved target', () => {
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
    expect(router._serverResult).toMatchObject({ status: 404, type: 'render' });
  }).pipe(Effect.provide(bff.browser));
});

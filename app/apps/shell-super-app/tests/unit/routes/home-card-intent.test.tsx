// @rstest-environment happy-dom
// Home cards prepare their destinations through the production scheduler, native router and request cache, served
// in process.
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { browserNetwork, networkIdle, serveApi } from '@app/shared-contracts/testing/http-double';
import { HttpApi } from '@modern-js/bff-effect/effect-client';
import { HttpApiBuilder, HttpRouter, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { I18nNavigationProvider } from '@modern-js/plugin-i18n/runtime';
import type { I18nRouterAdapter } from '@modern-js/plugin-i18n/runtime';
import { Link as NativeLink } from '@modern-js/plugin-tanstack/runtime';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Deferred, Effect, Layer } from 'effect';
import { afterEach, beforeAll, expect, it } from 'effect-rstest';

import { DocumentGatewayApiGroup } from '../../../shared/document-gateway-api.ts';
import { browserRuntime } from '../../../src/runtime/browser-effect-runtime.ts';
import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';
import { warmDocumentGatewayAssertions } from '../../../src/routes/document-gateway-assertions.ts';
import { staffRoutePreloads } from '../../../src/routes/route-preload-scheduler.ts';
import { ShellRouteLink } from '../../../src/routes/shell-frame.tsx';
import { StaffRoutePreloadContext } from '../../../src/routes/use-idle-route-preload.ts';
import { ShellI18n, shellLocaleCopy } from '../../support/shell-i18n.tsx';

const destinations = ['/finance', '/ukoly', '/prodej/prilezitosti'];
const revision = 'a'.repeat(64);
const audience = 'home-card-fixture';
const token = 'home-card-fixture-token';
const base = `/shell-super-app-api/module-api/${audience}/build/fixture`;
const manifestKey = 'ontos.page-reads.v1:/en';

beforeAll(() => {
  installBrowserRequestCache();
});
afterEach(() => {
  cleanup();
  browserRuntime.runSync(staffRoutePreloads.invalidate);
  return browserRuntime.runPromise(staffRoutePreloads.awaitIdle);
});

/** The Shell issues one assertion for the fixture module; the module answers its reads once released. */
const shellAndModule = (release: Deferred.Deferred<boolean>, reads: string[]) => {
  const Api = HttpApi.make('homeCardShell').add(DocumentGatewayApiGroup).prefix('/shell-super-app-api');
  return browserNetwork(
    serveApi(
      Api,
      HttpApiBuilder.group(Api, 'documentGateway', (group) =>
        group.handle('issueDocumentGatewayContexts', () =>
          Effect.succeed({
            assertions: [
              { apiBaseUrl: base, audience, compositionRevision: revision, expiresAt: 4_102_444_800, token },
            ],
          }),
        ),
      ),
    ),
    HttpRouter.add(
      'POST',
      `${base}/reads/destination/*`,
      Effect.gen(function* readDestination() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        reads.push(request.url);
        yield* Deferred.await(release);
        return HttpServerResponse.jsonUnsafe({ value: 'fresh' });
      }),
    ),
  );
};

it.live('prepares no Home card on render, then a pointed card through the native router, and joins a click', () => {
  const reads: string[] = [];
  const release = Deferred.makeUnsafe<boolean>();
  return Effect.gen(function* homeCardPreparation() {
    yield* staffRoutePreloads.invalidate;
    yield* staffRoutePreloads.resume;
    globalThis.history.replaceState(null, '', '/en');
    globalThis.localStorage.clear();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, true));
    yield* clearBrowserRequestCache;
    yield* warmDocumentGatewayAssertions(revision, [audience]);
    // A remote takes the warmed assertion; the request cache answers it locally and learns its audience.
    yield* Effect.promise(() =>
      globalThis.fetch('/shell-super-app-api/auth/gateway-context', {
        body: JSON.stringify({ audience, compositionRevision: revision }),
        method: 'POST',
      }),
    );
    const loaded: string[] = [];
    const root = createRootRoute();
    const home = createRoute({ getParentRoute: () => root, path: '/en' });
    const destinationRoutes = destinations.map((path) =>
      createRoute({
        getParentRoute: () => root,
        loader: ({ location }) => {
          loaded.push(location.pathname);
          return globalThis.fetch(`${base}/reads/destination${location.pathname}`, {
            body: '{}',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'x-ontos-composition-revision': revision,
            },
            method: 'POST',
          });
        },
        path: `/en${path}`,
      }),
    );
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/en'] }),
      isServer: false,
      routeTree: root.addChildren([home, ...destinationRoutes]),
    });
    yield* Effect.promise(() => router.load());
    const adapter: I18nRouterAdapter = {
      hasRouter: true,
      Link: ({ children, to, ...props }) => (
        <NativeLink {...props} to={to}>
          {children}
        </NativeLink>
      ),
      location: { hash: '', pathname: '/en', search: '' },
      navigate: null,
      params: {},
    };
    render(
      <RouterProvider
        InnerWrap={({ children }) => (
          <ShellI18n translations={shellLocaleCopy('en')}>
            <I18nNavigationProvider value={adapter}>
              <StaffRoutePreloadContext value={{ enabled: true, generation: 0 }}>
                {destinations.map((to) => (
                  <ShellRouteLink key={to} to={to}>
                    {to}
                  </ShellRouteLink>
                ))}
                {children}
              </StaffRoutePreloadContext>
            </I18nNavigationProvider>
          </ShellI18n>
        )}
        router={router}
      />,
    );
    // Rendering the cards prepares none of their destinations.
    yield* networkIdle;
    expect(loaded).toEqual([]);
    expect(reads).toEqual([]);
    fireEvent.mouseEnter(screen.getByRole('link', { name: '/finance' }));
    yield* waitUntil(() => reads.length === 1);
    expect(loaded).toEqual(['/en/finance']);
    expect(reads).toEqual([`${base}/reads/destination/en/finance`]);
    expect(globalThis.localStorage.getItem(manifestKey)).toBeNull();
    // The click joins the pointed preparation instead of loading again.
    const navigating = router.navigate({ to: '/en/finance' });
    yield* Deferred.succeed(release, true);
    yield* Effect.promise(() => navigating);
    expect(router.state.location.pathname).toBe('/en/finance');
    yield* networkIdle;
    expect(loaded).toEqual(['/en/finance']);
    expect(reads).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(Layer.suspend(() => shellAndModule(release, reads))));
});

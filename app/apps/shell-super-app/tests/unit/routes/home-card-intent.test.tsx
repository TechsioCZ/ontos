import { I18nNavigationProvider } from '@modern-js/plugin-i18n/runtime';
import type { I18nRouterAdapter } from '@modern-js/plugin-i18n/runtime';
import { ModernI18nContext } from '@modern-js/plugin-i18n/runtime/contexts';
import { Link as NativeLink } from '@modern-js/plugin-tanstack/runtime';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, waitFor } from '@testing-library/react';
import { Deferred, Effect } from 'effect';
import { afterAll, afterEach, beforeAll, expect, it, rstest } from 'effect-rstest';

import { browserRuntime } from '../../../src/runtime/browser-effect-runtime.ts';
import { clearBrowserRequestCache, installBrowserRequestCache } from '../../../src/routes/browser-request-cache.ts';
import { seedDocumentGatewayAssertions } from '../../../src/routes/document-gateway-assertions.ts';
import { ShellRouteLink } from '../../../src/routes/shell-frame.tsx';
import { StaffRoutePreloadContext } from '../../../src/routes/use-idle-route-preload.ts';

const destinations = ['/finance', '/ukoly', '/prodej/prilezitosti'];
const revision = 'a'.repeat(64);
const audience = 'home-card-fixture';
const token = 'home-card-fixture-token';
const base = `/shell-super-app-api/module-api/${audience}/build/fixture`;
const manifestKey = 'ontos.page-reads.v1:/en';
const platformFetch = rstest.fn<typeof globalThis.fetch>();
const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = platformFetch;
  installBrowserRequestCache();
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => cleanup());

it.live(
  'prepares every rendered Home card concurrently through the native router, isolates replay and joins a click',
  () =>
    Effect.gen(function* homeCardPreparation() {
      globalThis.history.replaceState(null, '', '/en');
      globalThis.localStorage.clear();
      const release = yield* Deferred.make<boolean>();
      platformFetch.mockReset();
      platformFetch.mockImplementation(() =>
        browserRuntime.runPromise(Deferred.await(release).pipe(Effect.as(Response.json({ value: 'fresh' })))),
      );
      yield* clearBrowserRequestCache;
      yield* seedDocumentGatewayAssertions(revision, [
        { apiBaseUrl: base, audience, compositionRevision: revision, expiresAt: 4_102_444_800, token },
      ]);
      yield* Effect.promise(() =>
        globalThis.fetch('/shell-super-app-api/auth/gateway-context', {
          body: JSON.stringify({ audience, compositionRevision: revision }),
          method: 'POST',
        }),
      );
      const root = createRootRoute();
      const home = createRoute({ getParentRoute: () => root, path: '/en' });
      const destinationLoader = rstest.fn(({ location }: { readonly location: { readonly pathname: string } }) =>
        globalThis.fetch(`${base}/reads/destination${location.pathname}`, {
          body: '{}',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-ontos-composition-revision': revision,
          },
          method: 'POST',
        }),
      );
      const destinationRoutes = destinations.map((path) =>
        createRoute({ getParentRoute: () => root, loader: destinationLoader, path: `/en${path}` }),
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
            <ModernI18nContext
              value={{
                i18nInstance: {
                  init: () => Promise.resolve(),
                  isInitialized: true,
                  language: 'en',
                  t: String,
                  use: () => {},
                },
                language: 'en',
                languages: ['en', 'cs'],
              }}
            >
              <I18nNavigationProvider value={adapter}>
                <StaffRoutePreloadContext value={{ enabled: true, generation: 0 }}>
                  {destinations.map((to) => (
                    <ShellRouteLink key={to} to={to}>
                      Open
                    </ShellRouteLink>
                  ))}
                  {children}
                </StaffRoutePreloadContext>
              </I18nNavigationProvider>
            </ModernI18nContext>
          )}
          router={router}
        />,
      );
      yield* Effect.promise(() => waitFor(() => expect(platformFetch).toHaveBeenCalledTimes(3)));
      expect(destinationLoader).toHaveBeenCalledTimes(3);
      expect(globalThis.localStorage.getItem(manifestKey)).toBeNull();
      const navigating = router.navigate({ to: '/en/finance' });
      yield* Effect.sleep('20 millis');
      expect(destinationLoader).toHaveBeenCalledTimes(3);
      yield* Deferred.succeed(release, true);
      yield* Effect.promise(() => navigating);
      expect(router.state.location.pathname).toBe('/en/finance');
      expect(platformFetch).toHaveBeenCalledTimes(3);
    }),
);

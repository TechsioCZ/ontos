import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { waitFor } from '@testing-library/react';
import { Deferred, Effect } from 'effect';
import { expect, it, rstest } from 'effect-rstest';

import { browserRuntime } from '../../../src/runtime/browser-effect-runtime.ts';

it.live('native foreground navigation joins a compatible preload without owning or canceling its work', () =>
  Effect.gen(function* nativeJoin() {
    const release = yield* Deferred.make<string>();
    const root = createRootRoute();
    const home = createRoute({ getParentRoute: () => root, path: '/' });
    const loader = rstest.fn((_context: { readonly abortController: AbortController }) =>
      browserRuntime.runPromise(Deferred.await(release)),
    );
    const finance = createRoute({ getParentRoute: () => root, loader, path: '/finance' });
    const other = createRoute({ getParentRoute: () => root, path: '/other' });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      isServer: false,
      routeTree: root.addChildren([home, finance, other]),
    });
    yield* Effect.promise(() => router.load());
    const preloading = router.preloadRoute({ to: '/finance' });
    yield* Effect.promise(() => waitFor(() => expect(loader).toHaveBeenCalledTimes(1)));
    const navigating = router.navigate({ to: '/finance' });
    yield* Effect.sleep('30 millis');
    expect(loader).toHaveBeenCalledTimes(1);
    yield* Effect.promise(() => router.navigate({ to: '/other' }));
    expect(loader.mock.calls[0]?.[0].abortController.signal.aborted).toBe(false);
    yield* Deferred.succeed(release, 'fresh-finance-data');
    yield* Effect.promise(() => preloading);
    yield* Effect.promise(() => navigating);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe('/other');
  }),
);

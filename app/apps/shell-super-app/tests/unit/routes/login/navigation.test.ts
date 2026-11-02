import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';

import { openSignedInPage } from '../../../../src/routes/sign-in-return.ts';

afterEach(cleanup);

it.effect('preserves a validated destination query and fragment through real router navigation', () =>
  Effect.gen(function* preservesSavedSearchAndHash() {
    const root = createRootRoute();
    const login = createRoute({
      component: () => createElement('h1', null, 'Login'),
      getParentRoute: () => root,
      path: '$lang/login',
    });
    const search = createRoute({
      component: () => createElement('h1', null, 'Search'),
      getParentRoute: () => root,
      path: '$lang/search',
    });
    const history = createMemoryHistory({ initialEntries: ['/cs/login'] });
    const router = createRouter({
      history,
      isServer: false,
      rewrite: {
        input: ({ url }) => {
          const target = new URL(url);
          if (target.pathname === '/cs/hledat') {
            target.pathname = '/cs/search';
          }
          return target;
        },
        output: ({ url }) => {
          const target = new URL(url);
          if (target.pathname === '/cs/search') {
            target.pathname = '/cs/hledat';
          }
          return target;
        },
      },
      routeTree: root.addChildren([login, search]),
    });
    render(createElement(RouterProvider, { router }));
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Login' })).toBeDefined()));
    const returnTo = encodeURIComponent('/cs/hledat?q=100%25#matched');
    yield* openSignedInPage(router, `https://stage.test/cs/login?returnTo=${returnTo}`, 'cs');
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Search' })).toBeDefined()));
    expect(router.state.location.pathname).toBe('/cs/search');
    expect(router.state.location.search).toEqual({ q: '100%' });
    expect(router.state.location.hash).toBe('matched');
    expect(history.location.pathname).toBe('/cs/hledat');
  }),
);

it.effect('replaces a missing saved destination with Home using the real router', () =>
  Effect.gen(function* recoversMissingReturnRoute() {
    const root = createRootRoute();
    const home = createRoute({
      component: () => createElement('h1', null, 'Home'),
      getParentRoute: () => root,
      loader: () => ({ state: 'authenticated' }),
      path: '$lang/',
    });
    const missing = createRoute({
      component: () => createElement('h1', null, 'Not found'),
      getParentRoute: () => root,
      loader: () => ({ state: 'not_found' }),
      path: '$lang/$',
    });
    const login = createRoute({
      component: () => createElement('h1', null, 'Login'),
      getParentRoute: () => root,
      path: '$lang/login',
    });
    const history = createMemoryHistory({ initialEntries: ['/cs/login?returnTo=%2Fcs%2Fretired-dashboard'] });
    const router = createRouter({ history, isServer: false, routeTree: root.addChildren([home, missing, login]) });
    render(createElement(RouterProvider, { router }));
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Login' })).toBeDefined()));

    yield* openSignedInPage(router, 'http://localhost/cs/login?returnTo=%2Fcs%2Fretired-dashboard', 'cs');

    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Home' })).toBeDefined()));
    expect(router.state.location.pathname).toBe('/cs');
    expect(router.state.matches.at(-1)?.loaderData).toEqual({ state: 'authenticated' });
    history.back();
    yield* Effect.promise(() => waitFor(() => expect(screen.getByRole('heading', { name: 'Login' })).toBeDefined()));
  }),
);

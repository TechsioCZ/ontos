import { cleanup, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@modern-js/plugin-tanstack/runtime';
import { Effect } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import type { ReactElement } from 'react';

import { ultramodernUiMarker } from '../../shared/ultramodern-build.ts';
import LanguageLayout from '../../src/routes/[lang]/layout.tsx';

const CurrentRoute = (): ReactElement => <main>Current route</main>;

// The layout is mounted in the actual TanStack route tree the Modern runtime uses, so its Outlet
// renders the matched child route instead of a stand-in.
const rootRoute = createRootRoute();
const languageRoute = createRoute({
  component: LanguageLayout,
  getParentRoute: () => rootRoute,
  path: '$lang',
});
const contactsRoute = createRoute({
  component: CurrentRoute,
  getParentRoute: () => languageRoute,
  path: 'contacts',
});
const routeTree = rootRoute.addChildren([languageRoute.addChildren([contactsRoute])]);

afterEach(cleanup);

it.effect('marks every localized Party Registry route with its UI release marker', () =>
  Effect.gen(function* renderLocalizedRoute() {
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/en/contacts'] }),
      routeTree,
    });
    const { container } = render(<RouterProvider router={router} />);

    yield* Effect.promise(() => screen.findByText('Current route'));
    const root = container.querySelector<HTMLElement>('[data-build-marker]');
    expect(root?.dataset['buildMarker']).toBe(ultramodernUiMarker.build);
    expect(root?.textContent).toBe('Current route');
  }),
);

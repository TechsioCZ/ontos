import { I18nNavigationProvider } from '@modern-js/plugin-i18n/runtime';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
  useRouter,
} from '@modern-js/plugin-tanstack/runtime';
import type { AnyRouter, RouteComponent } from '@modern-js/plugin-tanstack/runtime';
import { render } from '@testing-library/react';
import { Effect } from 'effect';
import { flow } from 'effect/Function';
import type { i18n } from 'i18next';
import type { ReactNode } from 'react';

import { ShellI18n } from './shell-i18n.tsx';

/** One page of the Shell under its language segment, served by a real route with a real loader. */
export interface ShellRoutePage<LoaderData> {
  readonly component: RouteComponent;
  /** Read on every load, so a test can change it and revalidate with `router.invalidate()`. */
  readonly loaderData?: () => LoaderData;
  /** The path below `$lang`, written as the route file declares it: `/`, `login`, `search`, … */
  readonly path: string;
}

/** A Shell router over any page; tests drive it through its public `load`, `navigate` and `state`. */
export type ShellRouter = AnyRouter;

/**
 * The router navigation the Modern.js TanStack plugin hands the i18n plugin in production, read
 * from the live router: localised links render through TanStack's own `Link` against the route
 * tree, and language switches navigate the same router.
 */
const ShellNavigation = ({ children }: { readonly children: ReactNode }) => {
  const router = useRouter();
  const location = useLocation();
  const params = useParams({ strict: false });
  return (
    <I18nNavigationProvider
      value={{
        createLinkProps: ({ hash, pathname, search }) => ({ hash, search, to: pathname }),
        framework: 'tanstack',
        hasRouter: true,
        Link,
        location: {
          hash: location.hash === '' ? '' : `#${location.hash}`,
          pathname: location.pathname,
          search: location.searchStr,
        },
        navigate: flow(
          (href: string, options?: { readonly replace?: boolean }) => ({
            replace: options?.replace === true,
            to: href,
          }),
          router.navigate,
        ),
        params,
      }}
    >
      {children}
    </I18nNavigationProvider>
  );
};

const Empty = () => null;

/**
 * A real TanStack router over the Shell's language-prefixed route tree, started at `url` in memory
 * history. The page under test is the only route besides the localised home; `root` renders around
 * every route, as the Shell's own layout does.
 */
export const makeShellRouter = <LoaderData = undefined,>(options: {
  readonly page: ShellRoutePage<LoaderData>;
  readonly root?: RouteComponent;
  readonly url: string;
}): ShellRouter => {
  const { page } = options;
  const Root = options.root ?? Outlet;
  const root = createRootRoute({
    component: () => (
      <ShellNavigation>
        <Root />
      </ShellNavigation>
    ),
  });
  const language = createRoute({ getParentRoute: () => root, path: '$lang' });
  const pageRoute = createRoute({
    component: page.component,
    getParentRoute: () => language,
    loader: () => page.loaderData?.(),
    path: page.path,
  });
  const routes =
    page.path === '/'
      ? [pageRoute]
      : [pageRoute, createRoute({ component: Empty, getParentRoute: () => language, path: '/' })];
  return createRouter({
    history: createMemoryHistory({ initialEntries: [options.url] }),
    routeTree: root.addChildren([language.addChildren(routes)]),
  });
};

/**
 * Loads the route the router stands on, then renders it under the Shell's i18n context. The page
 * reads its loader data, navigation and invalidation from the real router.
 */
export const renderShellRoute = (router: ShellRouter, translations: i18n) =>
  Effect.promise(async () => await router.load()).pipe(
    Effect.map(() =>
      render(
        <ShellI18n translations={translations}>
          <RouterProvider router={router} />
        </ShellI18n>,
      ),
    ),
  );

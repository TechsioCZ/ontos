import { useRouterState } from '@modern-js/plugin-tanstack/runtime';

/**
 * Path the router is moving to while the next page's loader still runs (it prepares the page's code and data), or
 * undefined once it settles. The router keeps rendering the previous page until then; the frame highlights the
 * destination in the menu and shows a thin progress bar. Search-only changes and same-path revalidation never count
 * as pending.
 */
export const usePendingNavigationPath = (): string | undefined =>
  useRouterState({
    select: ({ location, resolvedLocation }) =>
      resolvedLocation !== undefined && location.pathname !== resolvedLocation.pathname ? location.pathname : undefined,
  });

/** Strips the language segment so the path compares with module-contributed navigation hrefs. */
export const navigationHrefFromPath = (pathname: string, language: string): string => {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const [first, ...rest] = segments;
  const unprefixed = first === language ? rest : segments;
  return `/${unprefixed.join('/')}`;
};

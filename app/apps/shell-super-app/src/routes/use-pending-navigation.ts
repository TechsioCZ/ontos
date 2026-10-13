import { useRouterState } from '@modern-js/plugin-tanstack/runtime';

/**
 * Path the router is moving to while the next page's loader still runs, or undefined once it settles.
 * The router keeps rendering the previous page until then, so the frame uses this to stop showing that
 * page under the new URL. Search-only changes and same-path revalidation never count as pending.
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

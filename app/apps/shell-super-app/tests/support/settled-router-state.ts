export interface RouterLocationsDouble {
  readonly location: { readonly pathname: string };
  readonly resolvedLocation?: { readonly pathname: string };
}

const settledRouterLocations: RouterLocationsDouble = {
  location: { pathname: '/en' },
  resolvedLocation: { pathname: '/en' },
};

/** `useRouterState` double for a router whose last navigation has finished loading. */
export const useSettledRouterState = ({
  select,
}: {
  readonly select: (state: RouterLocationsDouble) => string | undefined;
}): string | undefined => select(settledRouterLocations);

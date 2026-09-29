// @effect-diagnostics asyncFunction:off globalFetch:off -- This module implements the `typeof fetch` contract that `FetchHttpClient.Fetch` and contract loaders consume; Effect code reaches it only through `HttpClient`. remove-when: FetchHttpClient.Fetch accepts an Effect-returning fetcher.
import { env } from 'cloudflare:workers';
import { Data } from 'effect';

import type { UnitRoute, UnitRoutedFetch, UnitServiceFetch } from './unit-service-fetch.ts';

class UnitServiceBindingMissingError extends Data.TaggedError('UnitServiceBindingMissingError')<{
  readonly serviceBinding: string;
}> {}

/**
 * A Worker reaches another unit only through its service binding; the request keeps its URL path
 * and the binding ignores the host. A missing binding rejects like an unreachable service.
 */
export const unitServiceFetch: UnitServiceFetch = (serviceBinding) => {
  const binding = env[serviceBinding];
  const bindingFetch = binding?.fetch;
  if (bindingFetch === undefined) {
    return async () => {
      throw new UnitServiceBindingMissingError({ serviceBinding });
    };
  }
  return bindingFetch.bind(binding);
};

const routeFor = (routes: readonly UnitRoute[], url: URL): UnitRoute | undefined =>
  routes.find(
    ({ baseUrl }) =>
      url.origin === baseUrl.origin &&
      (url.pathname === baseUrl.pathname ||
        url.pathname.startsWith(baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`)),
  );

export const unitRoutedFetch: UnitRoutedFetch = (routes) => async (input, init) => {
  const request = new Request(input, init);
  const route = routeFor(routes, new URL(request.url));
  return await (route === undefined ? globalThis.fetch(request) : unitServiceFetch(route.serviceBinding)(request));
};

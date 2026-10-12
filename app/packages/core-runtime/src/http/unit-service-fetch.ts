import type { Effect } from 'effect';

import type { ApplicationCompositionModule } from '../modules/application-composition.ts';
import type { ModuleReleaseIdentityError } from './module-release-identity.ts';
import type { ModuleReleaseTransportError } from './module-release-transport-error.ts';

/**
 * How a runtime reaches other OntOS units. `#unit-service-fetch` selects it by runtime: Node reaches
 * a unit at its URL through the global fetch; a Worker reaches it through the unit's Worker service
 * binding, which calls the target Worker directly inside Cloudflare instead of taking a public round
 * trip through its hostname, and needs no routable hostname at all.
 */
export type UnitServiceFetch = (serviceBinding: string) => typeof globalThis.fetch;

/** A unit reached at `baseUrl` by configuration and through `serviceBinding` in a Worker. */
export interface UnitRoute {
  readonly baseUrl: URL;
  readonly serviceBinding: string;
}

/**
 * The runtime's outbound fetch with unit routes applied: requests under a route's base URL go to
 * that unit's transport, every other request keeps the global fetch.
 */
export type UnitRoutedFetch = (routes: readonly UnitRoute[]) => typeof globalThis.fetch;

/** Transport signatures are shared by declaration consumers and both runtime implementations. */
export type ModuleReleaseFetch = (
  request: Request,
  module: ApplicationCompositionModule,
) => Effect.Effect<Response, ModuleReleaseIdentityError | ModuleReleaseTransportError>;

// Selected only by TypeScript's `types` condition; runtime selection stays Node or workerd.
export declare const moduleReleaseFetch: ModuleReleaseFetch;
export declare const unitRoutedFetch: UnitRoutedFetch;
export declare const unitServiceFetch: UnitServiceFetch;

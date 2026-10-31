import type { Effect } from 'effect';

import type { ApplicationCompositionModule } from '../modules/application-composition.ts';
import type { ModuleReleaseIdentityError } from './module-release-identity.ts';
import type { ModuleReleaseTransportError } from './module-release-transport-error.ts';

/**
 * How a runtime reaches an approved module release. `#unit-service-fetch` selects it by runtime: Node
 * reaches the release at its approved URL; a Worker reaches a Worker release through the service
 * binding its deployment declared for that exact release, and through the release's HTTPS origin when
 * it declared none.
 */
export type ModuleReleaseFetch = (
  request: Request,
  module: ApplicationCompositionModule,
) => Effect.Effect<Response, ModuleReleaseIdentityError | ModuleReleaseTransportError>;

// Selected only by TypeScript's `types` condition; runtime selection stays Node or workerd.
export declare const moduleReleaseFetch: ModuleReleaseFetch;

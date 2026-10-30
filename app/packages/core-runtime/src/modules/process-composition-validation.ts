import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { ActiveApplicationCompositionUnavailableError } from './active-application-composition-errors.ts';
import type { ActiveApplicationCompositionSnapshot } from './active-application-composition.ts';
import type { ApplicationComposition } from './application-composition.ts';
import type { InstalledModuleCatalog } from './catalog.ts';

/**
 * A native host may share immutable deployment validation among separately bundled owners. No source reads,
 * principal decisions, database admission, or request services enter this registry. Every load checks its lease.
 */
export interface ProcessCompositionValidationRegistry {
  readonly catalog: (composition: ApplicationComposition) => Effect.Effect<Option.Option<InstalledModuleCatalog>>;
  readonly decode: (
    encoded: string,
  ) => Effect.Effect<ActiveApplicationCompositionSnapshot, ActiveApplicationCompositionUnavailableError>;
  readonly validate: (
    snapshot: ActiveApplicationCompositionSnapshot,
  ) => Effect.Effect<ActiveApplicationCompositionSnapshot, ActiveApplicationCompositionUnavailableError>;
}

export class ProcessCompositionValidation extends Context.Service<
  ProcessCompositionValidation,
  ProcessCompositionValidationRegistry
>()('@app/core-runtime/modules/process-composition-validation/ProcessCompositionValidation') {}

declare global {
  /** Installed and removed by the native process startup scope, never by an owner bundle. */
  var ontosProcessCompositionValidation: ProcessCompositionValidationRegistry | undefined;
}

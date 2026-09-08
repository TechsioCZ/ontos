import { Context } from 'effect';
import type { Effect, Schema } from 'effect';

import type {
  CoreSearchProjectionHit,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionUnavailable,
} from './projection.ts';

type UnparsedCoreSearchInput = typeof Schema.Unknown.Type;

export interface CoreSearchQueryRuntimeService {
  readonly search: (
    input: UnparsedCoreSearchInput,
  ) => Effect.Effect<
    readonly CoreSearchProjectionHit[],
    CoreSearchProjectionInvalid | InstanceType<typeof CoreSearchProjectionUnavailable>
  >;
}

/** Core-owned query port returns hits without private searchable evidence. */
export class CoreSearchQueryRuntime extends Context.Service<
  CoreSearchQueryRuntime,
  CoreSearchQueryRuntimeService
>()(
  // Preserve the public Context identity after splitting the service into its owning module.
  // @effect-diagnostics-next-line deterministicKeys:off
  '@app/core-runtime/search/projection/CoreSearchQueryRuntime',
) {}

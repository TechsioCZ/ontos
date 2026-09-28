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
export class CoreSearchQueryRuntime extends Context.Service<CoreSearchQueryRuntime, CoreSearchQueryRuntimeService>()(
  '@app/core-runtime/search/query-runtime/CoreSearchQueryRuntime',
) {}

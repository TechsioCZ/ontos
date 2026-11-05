import { Context } from 'effect';
import type { Effect, Schema } from 'effect';

import type { OperationalScope } from '../operations/context.ts';
import type { CoreSearchAuthorization } from './visibility.ts';

import type {
  CoreSearchProjectionHit,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionUnavailable,
} from './projection.ts';

type UnparsedCoreSearchInput = typeof Schema.Unknown.Type;

export interface CoreSearchQueryRuntimeService {
  /**
   * Runs under the caller's operational scope; the query tenant must match that scope. The owner
   * passes what its gate already decided: the row filter is applied inside the query before
   * matching, ordering, counting and limiting, and a denied text surface takes no part in matching,
   * ordering or result metadata.
   */
  readonly search: (
    input: UnparsedCoreSearchInput,
    scope: OperationalScope,
    authorization?: CoreSearchAuthorization,
  ) => Effect.Effect<
    readonly CoreSearchProjectionHit[],
    CoreSearchProjectionInvalid | InstanceType<typeof CoreSearchProjectionUnavailable>
  >;
}

/** Core-owned query port returns hits without private searchable evidence. */
export class CoreSearchQueryRuntime extends Context.Service<CoreSearchQueryRuntime, CoreSearchQueryRuntimeService>()(
  '@app/core-runtime/search/query-runtime/CoreSearchQueryRuntime',
) {}

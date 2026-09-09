import { Context } from 'effect';
import type { Effect, Schema } from 'effect';

import type {
  CoreSearchProjectionDocument,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionUnavailable,
  CoreSearchQuery,
} from './projection.ts';

type UnparsedCoreSearchInput = typeof Schema.Unknown.Type;
type CoreSearchProjectionUnavailableInstance = InstanceType<typeof CoreSearchProjectionUnavailable>;

export interface CoreSearchProjectionStoreService {
  /** Applies one idempotent versioned lifecycle observation. */
  readonly apply: (
    input: UnparsedCoreSearchInput,
  ) => Effect.Effect<void, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance>;
  /** Candidate access is Core-private: the query runtime strips searchable evidence before return. */
  readonly queryCandidates: (
    input: CoreSearchQuery,
  ) => Effect.Effect<readonly CoreSearchProjectionDocument[], CoreSearchProjectionUnavailableInstance>;
  /**
   * Replaces one tenant/module/resource projection as one physical rebuild unit. Implementations
   * must leave the prior unit intact when validation or persistence fails.
   */
  readonly replace: (
    input: UnparsedCoreSearchInput,
  ) => Effect.Effect<void, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance>;
}

/** Production persistence implements this Core-owned port; business modules never own an index. */
export class CoreSearchProjectionStore extends Context.Service<
  CoreSearchProjectionStore,
  CoreSearchProjectionStoreService
>()(
  // Preserve the public Context identity after splitting the service into its owning module.
  // @effect-diagnostics-next-line deterministicKeys:off
  '@app/core-runtime/search/projection/CoreSearchProjectionStore',
) {}

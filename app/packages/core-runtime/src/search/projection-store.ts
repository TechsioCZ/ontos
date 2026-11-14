import { Context } from 'effect';
import type { Effect, Schema } from 'effect';
import type { OperationalScope } from '../operations/context.ts';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';
import type { CoreSearchAuthorization } from './visibility.ts';

import type {
  CoreSearchProjectionDocument,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionUnavailable,
  CoreSearchQuery,
} from './projection.ts';

type UnparsedCoreSearchInput = typeof Schema.Unknown.Type;
type CoreSearchProjectionUnavailableInstance = InstanceType<typeof CoreSearchProjectionUnavailable>;

/** Query selection can narrow, but never widen, the caller's sealed database authority. */
export const coreSearchQueryMatchesScope = (input: CoreSearchQuery, scope: OperationalScope): boolean =>
  input.tenantId === scope.tenantId &&
  (scope.legalEntityId === undefined ||
    input.selectedLegalEntityId === undefined ||
    input.selectedLegalEntityId === scope.legalEntityId);

export interface CoreSearchProjectionStoreService {
  /** Applies one idempotent versioned lifecycle observation. */
  readonly apply: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance>;
  /**
   * Candidate access is Core-private: the query runtime strips searchable evidence before return.
   * The unchanged scope is installed before reading. A selected entity must match a sealed entity;
   * tenant-wide scopes may select any entity, and global queries remain valid in selected scopes.
   * The owner's `listAccess` filter belongs to the query itself: an implementation must apply it
   * before text matching, ordering, counting and limiting, never to an already-materialized page.
   */
  readonly queryCandidates: (
    input: CoreSearchQuery,
    scope: OperationalScope,
    authorization?: CoreSearchAuthorization,
  ) => Effect.Effect<readonly CoreSearchProjectionDocument[], CoreSearchProjectionUnavailableInstance>;
  /**
   * Replaces one tenant/module/resource projection as one physical rebuild unit. Implementations
   * must leave the prior unit intact when validation or persistence fails.
   */
  readonly replace: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance>;
}

export { CoreSearchProjectionRefreshStore } from './projection-refresh-store.ts';
export type { CoreSearchProjectionRefreshStoreService } from './projection-refresh-store.ts';

/** Production persistence implements this Core-owned port; business modules never own an index. */
export class CoreSearchProjectionStore extends Context.Service<
  CoreSearchProjectionStore,
  CoreSearchProjectionStoreService
>()('@app/core-runtime/search/projection-store/CoreSearchProjectionStore') {}

import { Context } from 'effect';
import type { Effect, Schema } from 'effect';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';
import type {
  CoreSearchDerivedRepairJob,
  CoreSearchDerivedRepairProgress,
  CoreSearchDerivedRepairResult,
  CoreSearchDerivedRepairScan,
  CoreSearchLabelRefreshJob,
  CoreSearchLabelRefreshPage,
  CoreSearchProjectionDocument,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionUnavailable,
} from './projection.ts';

type UnparsedCoreSearchInput = typeof Schema.Unknown.Type;
type CoreSearchProjectionUnavailableInstance = InstanceType<typeof CoreSearchProjectionUnavailable>;

/**
 * Owner-local background refresh port. A batch is one transaction, not a rebuild page: it never
 * advances a rebuild floor or treats omitted resources as withdrawn. Dependency reads are complete
 * or fail unavailable, and are never a public/source-authorization API.
 *
 * The label-refresh job operations make an interrupted sweep durable. They persist the job epoch,
 * optimistic CAS version and keyset cursor so unfinished work resumes instead of being marked done,
 * a newer source revision supersedes an older token, and a final resweep plus the retained
 * source-revision barrier catch a concurrent relation inserted behind the cursor.
 */
export interface CoreSearchProjectionRefreshStoreService {
  readonly applyBatch: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<void, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance>;
  /**
   * Repairs one bounded page of derived stamps and advances the durable epoch/CAS/cursor in the same
   * transaction. A stale token is rejected without partial work. A drained sweep enters the resweep
   * phase, which re-walks the unit so a row inserted behind the committed cursor is still repaired; a
   * drained resweep completes the job.
   */
  readonly commitDerivedRepairPage: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<
    CoreSearchDerivedRepairProgress,
    CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance
  >;
  /**
   * Applies one page of target mutations and advances the durable cursor, epoch and CAS version in
   * one transaction. An empty page end transitions to the final resweep; a completed resweep
   * completes the job. A stale epoch, CAS version or source revision is rejected without partial work.
   */
  readonly commitLabelRefreshPage: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<CoreSearchLabelRefreshJob, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance>;
  /**
   * Opens or resumes the durable stamp-repair job for one projection unit.
   *
   * Operator/driver contract:
   * - **Ordinary open** (no `expectedGeneration`): creates the job at epoch 1 when none exists, and
   *   otherwise resumes the persisted job byte-for-byte, returning its exact epoch, CAS version and
   *   cursors. It is idempotent and never resets an in-flight or completed sweep, so a delayed or
   *   repeated ordinary open cannot restart a campaign.
   * - **Explicit new campaign** (`expectedGeneration` set to the `[epoch, casVersion]` the caller
   *   actually observed): starts a fresh sweep at a strictly greater epoch (`epoch + 1`, `casVersion
   *   + 1`, phase `sweeping`, no cursors) so a completed or superseded generation can repair newly
   *   damaged rows. It is compare-and-set: if the durable job no longer sits at that exact generation
   *   the request is rejected as stale rather than resetting a campaign that already advanced, and a
   *   duplicate replay of a restart that already produced `epoch + 1` returns that campaign idempotently.
   *
   * There is deliberately no blind `restart: true`: a plain replay of an open can never reset a
   * completed generation. Restart is the only way to advance the epoch, and it always names the
   * generation it is replacing. A rejected (stale) request writes nothing.
   */
  readonly openDerivedRepairJob: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<CoreSearchDerivedRepairJob, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance>;
  /**
   * Opens or resumes the durable refresh job for one source reference and selected company. A newer
   * source revision advances the retained barrier and opens a strictly greater epoch, superseding
   * any older in-flight token. An unchanged revision resumes the existing job idempotently.
   */
  readonly openLabelRefresh: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<CoreSearchLabelRefreshJob, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance>;
  readonly queryDependents: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<
    readonly CoreSearchProjectionDocument[],
    CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance
  >;
  /** Reads one bounded page of the current repair phase without writing. */
  readonly readDerivedRepairPage: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<
    CoreSearchDerivedRepairScan,
    CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance
  >;
  /** Reads one bounded keyset page of dependents at the job's committed cursor. Never advances state. */
  readonly readLabelRefreshPage: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<CoreSearchLabelRefreshPage, CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance>;
  /**
   * Distinct stamp-repair operation. Under lock and CAS it re-derives only searchTextV1,
   * searchFormatVersion and searchSourceVersion from the accepted persisted document, never
   * lifecycle versions, payload or rebuild floors. Returns the keyset continuation and resweep flag.
   */
  readonly repairDerivedRepresentation: (
    input: UnparsedCoreSearchInput,
    context: OutboxWorkerHandlerContext,
  ) => Effect.Effect<
    CoreSearchDerivedRepairResult,
    CoreSearchProjectionInvalid | CoreSearchProjectionUnavailableInstance
  >;
}

export class CoreSearchProjectionRefreshStore extends Context.Service<
  CoreSearchProjectionRefreshStore,
  CoreSearchProjectionRefreshStoreService
>()('@app/core-runtime/search/projection-refresh-store/CoreSearchProjectionRefreshStore') {}

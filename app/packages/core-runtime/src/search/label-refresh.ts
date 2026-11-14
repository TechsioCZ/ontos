import { Option, Result, Schema } from 'effect';

import {
  CoreSearchResourceRefSchema,
  coreSearchModuleId,
  coreSearchResourceId,
  coreSearchResourceType,
  coreSearchSelectedLegalEntityId,
  coreSearchTenantId,
  coreSearchResourceRefKey,
} from './resource-ref.ts';
import type { CoreSearchResourceRef } from './resource-ref.ts';

/**
 * Durable label-refresh continuation contracts. This is a leaf module: it imports only the canonical
 * resource-ref leaf and never the projection contract, so the projection schemas can consume these
 * contracts without an initialization cycle.
 *
 * A refresh is a bounded keyset sweep of one consumer module's dependent documents for one owner
 * source reference. Its epoch, optimistic version and cursors are persisted so an interrupted worker
 * resumes the exact unfinished page, and a newer source revision supersedes an older in-flight token.
 *
 * A cursor is an `Option`: an unset keyset position is `Option.none()`, never a nullable field.
 * Decoded jobs are re-consumed as inputs, so the embedding contracts use `Schema.toType` to accept
 * the decoded form without re-encoding.
 */

/** One page of target mutations and one owner label-lookup batch, both bounded by the same budget. */
export const CORE_SEARCH_LABEL_REFRESH_PAGE_LIMIT = 1000;
export const CORE_SEARCH_LABEL_REFERENCE_LOOKUP_LIMIT = 100;

const positiveDecimal = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/u));
const nonNegativeDecimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/u));
const pageLimit = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1000));
const cursorCodec = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));
/** An absent keyset position decodes to `Option.none()`; a present one to `Option.some(key)`. */
const cursor = Schema.OptionFromNullOr(Schema.String);
/** A cursor that a fresh caller may also omit entirely. */
const optionalCursor = Schema.OptionFromOptionalNullOr(Schema.String);

/** The single authority for the refresh/repair phase vocabulary. */
export const CoreSearchLabelRefreshStateSchema = Schema.Literals(['sweeping', 'resweep', 'complete']);
export type CoreSearchLabelRefreshState = typeof CoreSearchLabelRefreshStateSchema.Type;

export const CoreSearchLabelRefreshJobSchema = Schema.Struct({
  /** Optimistic version advanced by every committed page; a stale driver is rejected. */
  casVersion: positiveDecimal,
  /** Last committed key of the primary keyset sweep; absent before the first page. */
  cursor,
  /** Monotonic job generation. A newer source revision opens a strictly greater epoch. */
  epoch: positiveDecimal,
  legalEntityId: coreSearchSelectedLegalEntityId,
  moduleId: coreSearchModuleId,
  sourceRef: CoreSearchResourceRefSchema,
  sourceRevision: nonNegativeDecimal,
  state: CoreSearchLabelRefreshStateSchema,
  /** Last committed key of the final resweep; absent outside the resweep phase. */
  sweepCursor: cursor,
  tenantId: coreSearchTenantId,
});
export type CoreSearchLabelRefreshJob = typeof CoreSearchLabelRefreshJobSchema.Type;

export const CoreSearchLabelRefreshOpenSchema = Schema.Struct({
  legalEntityId: coreSearchSelectedLegalEntityId,
  moduleId: coreSearchModuleId,
  sourceRef: CoreSearchResourceRefSchema,
  sourceRevision: nonNegativeDecimal,
  tenantId: coreSearchTenantId,
}).check(Schema.makeFilter((input) => input.sourceRef.tenantId === input.tenantId));
export type CoreSearchLabelRefreshOpen = typeof CoreSearchLabelRefreshOpenSchema.Type;

export const CoreSearchLabelRefreshPageQuerySchema = Schema.Struct({
  job: Schema.toType(CoreSearchLabelRefreshJobSchema),
  limit: Schema.optionalKey(pageLimit),
});
export type CoreSearchLabelRefreshPageQuery = typeof CoreSearchLabelRefreshPageQuerySchema.Type;

/**
 * Retained source-revision barrier. It survives dependent-document and target deletion so a late,
 * older observation cannot roll an already-observed owner revision back.
 */
export const CoreSearchLabelSourceRevisionSchema = Schema.Struct({
  legalEntityId: coreSearchSelectedLegalEntityId,
  ref: CoreSearchResourceRefSchema,
  sourceRevision: nonNegativeDecimal,
  tenantId: coreSearchTenantId,
});
export type CoreSearchLabelSourceRevision = typeof CoreSearchLabelSourceRevisionSchema.Type;

/** Stamp repair re-derives only the derived representation of an accepted persisted document. */
export const CoreSearchDerivedRepairRequestSchema = Schema.Struct({
  cursor: optionalCursor,
  limit: Schema.optionalKey(pageLimit),
  moduleId: coreSearchModuleId,
  resourceType: coreSearchResourceType,
  resweep: Schema.optionalKey(Schema.Boolean),
  tenantId: coreSearchTenantId,
});
export type CoreSearchDerivedRepairRequest = typeof CoreSearchDerivedRepairRequestSchema.Type;

export const CoreSearchDerivedRepairResultSchema = Schema.Struct({
  complete: Schema.Boolean,
  cursor,
  repaired: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  resweep: Schema.Boolean,
  scanned: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type CoreSearchDerivedRepairResult = typeof CoreSearchDerivedRepairResultSchema.Type;

/**
 * Durable stamp-repair job. It is deliberately separate from the owner label-refresh job: it records
 * only the progress of re-deriving the shortlist representation for one projection unit and never an
 * owner label revision, so the two lifecycles cannot be conflated. `sweeping` walks the unit forward;
 * `resweep` re-walks it from the start so a row inserted behind the committed cursor is still repaired;
 * `complete` is terminal.
 */
export const CoreSearchDerivedRepairStateSchema = CoreSearchLabelRefreshStateSchema;
export type CoreSearchDerivedRepairState = typeof CoreSearchDerivedRepairStateSchema.Type;

export const CoreSearchDerivedRepairJobSchema = Schema.Struct({
  /** Optimistic version advanced by every committed page; a stale driver is rejected. */
  casVersion: positiveDecimal,
  /** Last committed key of the primary sweep; absent before the first page. */
  cursor,
  /** Monotonic job generation; an explicit new campaign advances it, an ordinary open resumes it. */
  epoch: positiveDecimal,
  moduleId: coreSearchModuleId,
  resourceType: coreSearchResourceType,
  state: CoreSearchDerivedRepairStateSchema,
  /** Last committed key of the final resweep; absent outside the resweep phase. */
  sweepCursor: cursor,
  tenantId: coreSearchTenantId,
});
export type CoreSearchDerivedRepairJob = typeof CoreSearchDerivedRepairJobSchema.Type;

/**
 * The exact persisted generation a restart request was computed from. Restart is opt-in and
 * compare-and-set: it only advances the epoch while the durable job still sits at this
 * `[epoch, casVersion]`, so a delayed duplicate cannot reset a campaign that already moved on.
 */
export const CoreSearchDerivedRepairGenerationSchema = Schema.Struct({
  casVersion: positiveDecimal,
  epoch: positiveDecimal,
});
export type CoreSearchDerivedRepairGeneration = typeof CoreSearchDerivedRepairGenerationSchema.Type;

/**
 * Operator/driver request to open the stamp-repair job for one projection unit.
 *
 * - Without `expectedGeneration` this is an ordinary open: it creates the job at epoch 1 when absent,
 *   and otherwise resumes the persisted job byte-for-byte. It is idempotent and never resets progress.
 * - With `expectedGeneration` this is an explicit restart/new-campaign request: it starts a fresh
 *   sweep at a strictly greater epoch **only** while the persisted job is exactly the generation the
 *   caller observed. It is deliberately not a blind `restart: true`: a completed generation is never
 *   reset by a plain replay, and a request computed from an older generation is rejected as stale.
 */
export const CoreSearchDerivedRepairOpenSchema = Schema.Struct({
  expectedGeneration: Schema.optionalKey(CoreSearchDerivedRepairGenerationSchema),
  moduleId: coreSearchModuleId,
  resourceType: coreSearchResourceType,
  tenantId: coreSearchTenantId,
});
export type CoreSearchDerivedRepairOpen = typeof CoreSearchDerivedRepairOpenSchema.Type;

export const CoreSearchDerivedRepairCommitSchema = Schema.Struct({
  job: Schema.toType(CoreSearchDerivedRepairJobSchema),
  limit: Schema.optionalKey(pageLimit),
});
export type CoreSearchDerivedRepairCommit = typeof CoreSearchDerivedRepairCommitSchema.Type;

/** The branded resource identities one repair page previews; never an interchangeable raw string. */
export const CoreSearchDerivedRepairResourceIdsSchema = Schema.Array(coreSearchResourceId).check(
  Schema.isMaxLength(1000),
);

/** One read-only preview of the next bounded repair page. It never writes. */
export const CoreSearchDerivedRepairScanSchema = Schema.Struct({
  hasMore: Schema.Boolean,
  pageEnd: cursor,
  resourceIds: CoreSearchDerivedRepairResourceIdsSchema,
});
export type CoreSearchDerivedRepairScan = typeof CoreSearchDerivedRepairScanSchema.Type;

/** The atomic result of one committed repair page: repaired stamps plus the advanced job token. */
export const CoreSearchDerivedRepairProgressSchema = Schema.Struct({
  job: CoreSearchDerivedRepairJobSchema,
  repaired: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  scanned: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type CoreSearchDerivedRepairProgress = typeof CoreSearchDerivedRepairProgressSchema.Type;

/** The fresh, first-page state of a new repair campaign at the given generation. */
const freshDerivedRepairCampaign = (
  open: CoreSearchDerivedRepairOpen,
  epoch: bigint,
  casVersion: bigint,
): CoreSearchDerivedRepairJob => ({
  casVersion: casVersion.toString(),
  cursor: Option.none(),
  epoch: epoch.toString(),
  moduleId: open.moduleId,
  resourceType: open.resourceType,
  state: 'sweeping',
  sweepCursor: Option.none(),
  tenantId: open.tenantId,
});

/**
 * The replay-safe outcome of one open/restart request against the persisted job (if any). Both the
 * in-memory and PostgreSQL stores apply this exact planner, so their reopen semantics cannot drift.
 *
 * - `create`: no job exists and no restart was requested; persist the fresh epoch-1 campaign.
 * - `advance`: an explicit restart matched the persisted generation exactly; persist a fresh sweep at
 *   `epoch + 1` with `casVersion + 1`, discarding the previous cursors and phase.
 * - `resume`: return the persisted job unchanged. This covers an ordinary open of any job and an
 *   idempotent replay of a restart whose `epoch + 1` campaign is already the persisted one.
 * - `stale`: reject. A restart asked from a generation the durable job no longer matches (older,
 *   newer, or a different CAS), so applying it would reset a campaign that already advanced.
 */
export type CoreSearchDerivedRepairReopenPlan =
  | { readonly job: CoreSearchDerivedRepairJob; readonly kind: 'advance' }
  | { readonly job: CoreSearchDerivedRepairJob; readonly kind: 'create' }
  | { readonly job: CoreSearchDerivedRepairJob; readonly kind: 'resume' }
  | { readonly kind: 'stale' };

export const planCoreSearchDerivedRepairReopen = (
  open: CoreSearchDerivedRepairOpen,
  existing: Option.Option<CoreSearchDerivedRepairJob>,
): CoreSearchDerivedRepairReopenPlan => {
  const expected = open.expectedGeneration;
  if (Option.isNone(existing)) {
    // There is no generation to restart; a restart request for an absent job is stale, never a create.
    return expected === undefined
      ? { job: freshDerivedRepairCampaign(open, 1n, 1n), kind: 'create' }
      : { kind: 'stale' };
  }
  const job = existing.value;
  if (expected === undefined) {
    return { job, kind: 'resume' };
  }
  const epoch = BigInt(job.epoch);
  const expectedEpoch = BigInt(expected.epoch);
  if (epoch === expectedEpoch + 1n) {
    // This is exactly the campaign the restart created, so a duplicate replay is idempotent.
    return { job, kind: 'resume' };
  }
  if (epoch !== expectedEpoch || job.casVersion !== expected.casVersion) {
    return { kind: 'stale' };
  }
  return { job: freshDerivedRepairCampaign(open, epoch + 1n, BigInt(job.casVersion) + 1n), kind: 'advance' };
};

/**
 * Canonical keyset cursor for one `[resourceType, resourceId]` pair. It is unambiguous and orders
 * identically to the SQL `(source_resource_type, source_resource_id)` tuple comparison. It accepts
 * plain identity strings so a storage boundary can build a cursor without inventing a branded value.
 */
export const coreSearchDerivedRepairCursor = (resourceType: string, resourceId: string): string =>
  Result.getOrThrow(Schema.encodeResult(cursorCodec)([resourceType, resourceId]));

export const coreSearchLabelRefreshCursorKey = (ref: CoreSearchResourceRef): string =>
  coreSearchDerivedRepairCursor(ref.resourceType, ref.resourceId);

/** Decode a persisted cursor key to its exact tuple as an Option, for absent-safe keyset math. */
export const decodeCoreSearchLabelRefreshCursorOption = (value: string): Option.Option<readonly [string, string]> =>
  Schema.decodeUnknownOption(cursorCodec)(value);

/** Decode a persisted cursor key back to its exact `[resourceType, resourceId]` tuple. */
export const decodeCoreSearchLabelRefreshCursor = (value: string): readonly [string, string] | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(cursorCodec)(value));

export const compareCoreSearchLabelRefreshCursor = (
  left: readonly [string, string],
  right: readonly [string, string],
): number => {
  if (left[0] !== right[0]) {
    return left[0] < right[0] ? -1 : 1;
  }
  if (left[1] === right[1]) {
    return 0;
  }
  return left[1] < right[1] ? -1 : 1;
};

/**
 * A newer observation of the same source edge cannot be replaced by an older one, even after the
 * dependent document or its edge was deleted. The barrier is keyed by the exact canonical reference
 * and selected company, never by ID alone.
 */
export const coreSearchLabelBarrierKey = (ref: CoreSearchResourceRef, legalEntityId: string): string =>
  `${coreSearchResourceRefKey(ref)}|${legalEntityId}`;

export const advanceCoreSearchLabelBarrier = (
  barriers: Map<string, bigint>,
  dependencies: readonly {
    readonly ref: CoreSearchResourceRef;
    readonly selectedLegalEntityId: string;
    readonly sourceRevision: string;
  }[],
): void => {
  for (const dependency of dependencies) {
    const key = coreSearchLabelBarrierKey(dependency.ref, dependency.selectedLegalEntityId);
    const observed = BigInt(dependency.sourceRevision);
    const current = barriers.get(key);
    if (current === undefined || observed > current) {
      barriers.set(key, observed);
    }
  }
};

/** Returns the first retained-barrier violation reason, or undefined when every observation is admissible. */
export const coreSearchLabelBarrierViolation = (
  barriers: ReadonlyMap<string, bigint>,
  dependencies: readonly {
    readonly ref: CoreSearchResourceRef;
    readonly selectedLegalEntityId: string;
    readonly sourceRevision: string;
  }[],
): string | undefined => {
  for (const dependency of dependencies) {
    const observed = barriers.get(coreSearchLabelBarrierKey(dependency.ref, dependency.selectedLegalEntityId));
    if (observed !== undefined && BigInt(dependency.sourceRevision) < observed) {
      return 'Core Search refresh would roll back a retained source label revision';
    }
  }
  return undefined;
};

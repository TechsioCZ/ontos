import { Clock, Context, DateTime, Effect, Match, Option, Result, Schema } from 'effect';

import type { AccessOperationId, AccessScopeId, CommandDigest, TenantId } from '../ids.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  OperationJournalSchema,
  ScopeFenceSchema,
  canAdvanceOperationPhase,
} from '../model.ts';
import type { OperationJournal, OperationPhase, ScopeFence } from '../model.ts';
import type { AccessLifecycleError } from './errors.ts';
import { lifecycleRefusal } from './errors.ts';

const decodeJournal = Schema.decodeUnknownResult(OperationJournalSchema, ACCESS_MODEL_PARSE_OPTIONS);
const nowDate = (epochMillis: number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(epochMillis));

const invalidJournal = (reason: string): AccessLifecycleError => lifecycleRefusal('operation_journal_invalid', reason);

/* ------------------------------------------------------------------------------------------------
 * D9: validation happens before the company is locked
 * ---------------------------------------------------------------------------------------------- */

export interface AccessChangeValidation {
  /** Stable name of the rule, so a receipt records which checks a change already passed. */
  readonly check: string;
  readonly run: Effect.Effect<void, AccessLifecycleError>;
}

const receiptProvenance = Symbol('AccessChangeReceipt');

/**
 * Proof that a change passed its validations. The proof cannot be built outside this module, so no
 * write path can reach the scope fence without running `validateAccessChange` first (D9).
 */
export interface AccessChangeReceipt {
  readonly checks: readonly string[];
  readonly [receiptProvenance]: true;
}

/**
 * D9: every change is validated before the scope is locked. A change with no registered validator is
 * refused, because an empty validation list is not a licence to write.
 */
export const validateAccessChange = Effect.fn('accessLifecycle.validateAccessChange')(
  function* validateAccessChangeEffect(
    validations: readonly AccessChangeValidation[],
  ): Effect.fn.Return<AccessChangeReceipt, AccessLifecycleError> {
    if (validations.length === 0) {
      return yield* lifecycleRefusal(
        'change_validation_missing',
        'A change needs at least one validation before it is written',
      );
    }
    yield* Effect.forEach(validations, (validation) => validation.run, { concurrency: 1 });
    return Object.freeze({
      checks: validations.map((validation) => validation.check),
      [receiptProvenance]: true as const,
    });
  },
);

/* ------------------------------------------------------------------------------------------------
 * D15: one fence per scope, owned by the operation that took it
 * ---------------------------------------------------------------------------------------------- */

export interface ScopeFenceRequest {
  /** The fence row of that scope. `None` means no fence exists, which is not a licence to write. */
  readonly current: Option.Option<ScopeFence>;
  readonly operationId: AccessOperationId;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

/**
 * D15: all writers share one lock per scope. A second writer is refused rather than queued inside the
 * writer, and the operation that already holds the fence may resume its own work.
 */
export const acquireScopeFence = (request: ScopeFenceRequest): Effect.Effect<ScopeFence, AccessLifecycleError> =>
  Option.match(request.current, {
    onNone: () =>
      Effect.fail(
        lifecycleRefusal('fence_unavailable', `Scope ${request.scopeId} has no scope fence, so nothing may write`),
      ),
    onSome: (fence) =>
      Match.value(fence.state).pipe(
        Match.when('Ready', () =>
          Effect.succeed<ScopeFence>({
            owningOperationId: request.operationId,
            revision: fence.revision + 1,
            scopeId: fence.scopeId,
            state: 'Changing',
            tenantId: fence.tenantId,
          }),
        ),
        Match.when('Changing', () => {
          const { owningOperationId } = fence;
          if (owningOperationId === undefined) {
            return Effect.fail(invalidJournal('A changing scope fence names the operation that holds it'));
          }
          return owningOperationId === request.operationId
            ? Effect.succeed(fence)
            : Effect.fail(
                lifecycleRefusal(
                  'fence_held_by_other_operation',
                  `Scope ${fence.scopeId} is locked by another access operation`,
                ),
              );
        }),
        Match.when('Unavailable', () =>
          Effect.fail(
            lifecycleRefusal('fence_unavailable', `Scope ${fence.scopeId} is unavailable, so nothing may write`),
          ),
        ),
        Match.exhaustive,
      ),
  });

/**
 * D15: the compare-and-set a writer sends to the store. The expected revision is the one it read, so
 * a store that took another operation's fence in between refuses this write instead of overwriting it.
 */
export interface FenceAcquireCommand {
  readonly expectedRevision: ScopeFence['revision'];
  readonly operationId: AccessOperationId;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

/** The fence row as it is after the attempt, whether this writer took it or somebody else did. */
export const FenceAcquireOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('Acquired', { fence: ScopeFenceSchema }),
  Schema.TaggedStruct('Conflict', { fence: ScopeFenceSchema }),
]);
export type FenceAcquireOutcome = typeof FenceAcquireOutcomeSchema.Type;

export interface FenceReleaseCommand {
  readonly expectedRevision: ScopeFence['revision'];
  readonly operationId: AccessOperationId;
  readonly scopeId: AccessScopeId;
  /** The tenant the scope belongs to, so a store never binds itself to one tenant. */
  readonly tenantId: TenantId;
}

/** A fence read names its scope and that scope's tenant, never only the scope. */
export interface FenceReadCommand {
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

/** A journal read names the operation and its tenant, so a store is not bound to one tenant either. */
export interface JournalReadCommand {
  readonly operationId: AccessOperationId;
  readonly tenantId: TenantId;
}

export const FenceReleaseOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('Released', { fence: ScopeFenceSchema }),
  Schema.TaggedStruct('Conflict', { fence: ScopeFenceSchema }),
]);
export type FenceReleaseOutcome = typeof FenceReleaseOutcomeSchema.Type;

/**
 * D15: interpreting a refused compare-and-set. A store that moved the fence away from the revision
 * this writer read means another writer got there first, so this one stops instead of projecting.
 */
const resolveFenceConflict = (
  fence: ScopeFence,
  operationId: AccessOperationId,
): Effect.Effect<ScopeFence, AccessLifecycleError> =>
  Match.value(fence.state).pipe(
    Match.when('Ready', () =>
      Effect.fail(
        lifecycleRefusal(
          'fence_revision_conflict',
          `Scope ${fence.scopeId} changed while this writer was taking it, so nothing may write`,
        ),
      ),
    ),
    Match.when('Changing', () =>
      fence.owningOperationId === operationId
        ? Effect.succeed(fence)
        : Effect.fail(
            lifecycleRefusal(
              'fence_held_by_other_operation',
              `Scope ${fence.scopeId} is locked by another access operation`,
            ),
          ),
    ),
    Match.when('Unavailable', () =>
      Effect.fail(lifecycleRefusal('fence_unavailable', `Scope ${fence.scopeId} is unavailable, so nothing may write`)),
    ),
    Match.exhaustive,
  );

export interface ScopeFenceReleaseRequest {
  readonly current: ScopeFence;
  readonly operationId: AccessOperationId;
}

/** Releasing is idempotent for the owner and impossible for anybody else. */
export const releaseScopeFence = (request: ScopeFenceReleaseRequest): Effect.Effect<ScopeFence, AccessLifecycleError> =>
  Match.value(request.current.state).pipe(
    Match.when('Ready', () => Effect.succeed(request.current)),
    Match.when('Unavailable', () =>
      Effect.fail(
        lifecycleRefusal(
          'fence_unavailable',
          `Scope ${request.current.scopeId} is unavailable, so it cannot be released`,
        ),
      ),
    ),
    Match.when('Changing', () =>
      request.current.owningOperationId === request.operationId
        ? Effect.succeed<ScopeFence>({
            revision: request.current.revision + 1,
            scopeId: request.current.scopeId,
            state: 'Ready',
            tenantId: request.current.tenantId,
          })
        : Effect.fail(
            lifecycleRefusal('fence_not_held_by_operation', 'Only the operation that took the scope fence releases it'),
          ),
    ),
    Match.exhaustive,
  );

/* ------------------------------------------------------------------------------------------------
 * D24: journals belong to the operation that started them
 * ---------------------------------------------------------------------------------------------- */

/** The journal columns Core writes, before the shared schema validates them. */
interface JournalRow {
  readonly commandDigest: CommandDigest;
  readonly failureCode?: string;
  readonly operationId: AccessOperationId;
  readonly phase: OperationPhase;
  readonly projectionToken?: string;
  readonly scopeId: AccessScopeId;
  readonly startedAt: Date;
  readonly tenantId: TenantId;
  readonly updatedAt: Date;
}

const withFailureCode = (row: JournalRow, failureCode: string | undefined): JournalRow =>
  failureCode === undefined ? row : { ...row, failureCode };
const withProjectionToken = (row: JournalRow, projectionToken: string | undefined): JournalRow =>
  projectionToken === undefined ? row : { ...row, projectionToken };

const journalFrom = (row: JournalRow): Effect.Effect<OperationJournal, AccessLifecycleError> =>
  Result.match(decodeJournal(row), {
    onFailure: (failure) => Effect.fail(invalidJournal(failure.message)),
    onSuccess: (journal) => Effect.succeed(journal),
  });

export interface JournalOpenRequest {
  readonly commandDigest: CommandDigest;
  readonly operationId: AccessOperationId;
  readonly scopeId: AccessScopeId;
  readonly startedAt: Date;
  readonly tenantId: TenantId;
}

/** Open the journal of one operation. It is keyed by operation id, never by scope or by company. */
export const openOperationJournal = (
  request: JournalOpenRequest,
): Effect.Effect<OperationJournal, AccessLifecycleError> =>
  journalFrom({
    commandDigest: request.commandDigest,
    operationId: request.operationId,
    phase: 'validated',
    scopeId: request.scopeId,
    startedAt: request.startedAt,
    tenantId: request.tenantId,
    updatedAt: request.startedAt,
  });

export interface JournalAdvanceRequest {
  readonly current: OperationJournal;
  readonly failureCode?: string;
  readonly operationId: AccessOperationId;
  readonly phase: OperationPhase;
  readonly projectionToken?: string;
  readonly updatedAt: Date;
}

/**
 * D24: only the owning operation advances its journal, only forward, and never out of a terminal
 * state. A committed operation is not re-run and a failed one is not repaired by a different
 * operation: recovery resumes that operation, under that operation id.
 */
export const advanceOperationJournal = (
  request: JournalAdvanceRequest,
): Effect.Effect<OperationJournal, AccessLifecycleError> => {
  const { current } = request;
  if (current.operationId !== request.operationId) {
    return Effect.fail(
      lifecycleRefusal('operation_not_owned', `Journal ${current.operationId} belongs to another operation`),
    );
  }
  if (current.phase === 'committed' || current.phase === 'failed') {
    return Effect.fail(
      lifecycleRefusal('operation_terminal', `Operation ${current.operationId} already ended as ${current.phase}`),
    );
  }
  if (!canAdvanceOperationPhase(current.phase, request.phase)) {
    return Effect.fail(
      lifecycleRefusal(
        'operation_phase_regression',
        `Operation ${current.operationId} cannot move from ${current.phase} back to ${request.phase}`,
      ),
    );
  }
  const row: JournalRow = {
    commandDigest: current.commandDigest,
    operationId: current.operationId,
    phase: request.phase,
    scopeId: current.scopeId,
    startedAt: current.startedAt,
    tenantId: current.tenantId,
    updatedAt: request.updatedAt,
  };
  return journalFrom(withProjectionToken(withFailureCode(row, request.failureCode), request.projectionToken));
};

/* ------------------------------------------------------------------------------------------------
 * The fence and journal store, and the one write path every access writer uses
 * ---------------------------------------------------------------------------------------------- */

export interface AccessWriteJournalPortService {
  /**
   * D15: take the fence in one atomic step (`UPDATE … SET state = 'Changing', owning_operation_id = $op,
   * revision = revision + 1 WHERE scope_id = $scope AND revision = $expected AND state = 'Ready'`).
   * A store never writes a fence whose revision it did not match; it reports the row it found instead.
   */
  readonly acquireFence: (command: FenceAcquireCommand) => Effect.Effect<FenceAcquireOutcome, AccessLifecycleError>;
  readonly readFence: (command: FenceReadCommand) => Effect.Effect<Option.Option<ScopeFence>, AccessLifecycleError>;
  readonly readJournal: (
    command: JournalReadCommand,
  ) => Effect.Effect<Option.Option<OperationJournal>, AccessLifecycleError>;
  /**
   * D15: release only the fence this operation observed (`… WHERE revision = $expected AND
   * owning_operation_id = $op`), so a writer never frees somebody else's lock.
   */
  readonly releaseFence: (command: FenceReleaseCommand) => Effect.Effect<FenceReleaseOutcome, AccessLifecycleError>;
  readonly writeJournal: (journal: OperationJournal) => Effect.Effect<void, AccessLifecycleError>;
}

/**
 * Persistence seam of the scope fence and the operation journals (`core.access_scope_fences`,
 * `core.access_operation_journals`). The writer provides the database implementation; the lifecycle
 * rules stay pure so they are testable without a database and shared by every writer.
 */
export class AccessWriteJournalPort extends Context.Service<AccessWriteJournalPort, AccessWriteJournalPortService>()(
  '@app/core-runtime/access/lifecycle/fence/AccessWriteJournalPort',
) {}

/**
 * D15: take the fence through the store's compare-and-set. A fence this operation already holds is
 * resumed without a second write. A fence that moved since the read, or that another operation
 * holds, refuses the write — two writers that read the same revision cannot both project.
 */
const takeScopeFence = Effect.fn('accessLifecycle.takeScopeFence')(function* takeScopeFenceEffect(
  request: ScopeFenceRequest,
): Effect.fn.Return<ScopeFence, AccessLifecycleError, AccessWriteJournalPort> {
  const port = yield* AccessWriteJournalPort;
  const desired = yield* acquireScopeFence(request);
  const { current, operationId, scopeId, tenantId } = request;
  return yield* Option.match(current, {
    onNone: () =>
      Effect.fail(lifecycleRefusal('fence_unavailable', `Scope ${scopeId} has no scope fence, so nothing may write`)),
    onSome: (observed) =>
      observed.state === 'Changing'
        ? Effect.succeed(desired)
        : port.acquireFence({ expectedRevision: observed.revision, operationId, scopeId, tenantId }).pipe(
            Effect.andThen((outcome) =>
              Match.value(outcome).pipe(
                Match.tag('Acquired', ({ fence }) => Effect.succeed(fence)),
                Match.tag('Conflict', ({ fence }) => resolveFenceConflict(fence, operationId)),
                Match.exhaustive,
              ),
            ),
          ),
  });
});

export interface AccessWriteRequest {
  readonly change: AccessChangeReceipt;
  readonly commandDigest: CommandDigest;
  readonly operationId: AccessOperationId;
  /** Writes the projection of this change and returns the projection token of that write. */
  readonly project: (scopeId: AccessScopeId) => Effect.Effect<string, AccessLifecycleError>;
  readonly scopeId: AccessScopeId;
  readonly tenantId: TenantId;
}

export interface AccessWriteResult {
  readonly operationId: AccessOperationId;
  readonly phase: 'committed';
  readonly projectionToken: string;
  readonly resumed: boolean;
}

/** The three fields a committed projection reports; the caller adds whether it resumed a journal. */
export interface CommittedProjection {
  readonly operationId: AccessOperationId;
  readonly phase: 'committed';
  readonly projectionToken: string;
}

interface CommitRequest {
  readonly fence: ScopeFence;
  readonly fencedJournal: OperationJournal;
  readonly write: AccessWriteRequest;
}

const releaseFence = Effect.fn('accessLifecycle.releaseFence')(function* releaseFenceEffect(
  fence: ScopeFence,
  operationId: AccessOperationId,
): Effect.fn.Return<void, AccessLifecycleError, AccessWriteJournalPort> {
  const port = yield* AccessWriteJournalPort;
  const released = yield* releaseScopeFence({ current: fence, operationId });
  const outcome = yield* port.releaseFence({
    expectedRevision: fence.revision,
    operationId,
    scopeId: released.scopeId,
    tenantId: released.tenantId,
  });
  yield* Match.value(outcome).pipe(
    Match.tag('Released', () => Effect.void),
    Match.tag('Conflict', ({ fence: observed }) =>
      Effect.fail(
        lifecycleRefusal(
          'fence_revision_conflict',
          `Scope ${observed.scopeId} moved while operation ${operationId} was releasing it`,
        ),
      ),
    ),
    Match.exhaustive,
  );
});

const failOperation = Effect.fn('accessLifecycle.failOperation')(function* failOperationEffect(
  request: CommitRequest,
  failureCode: string,
): Effect.fn.Return<void, AccessLifecycleError, AccessWriteJournalPort> {
  const port = yield* AccessWriteJournalPort;
  const now = nowDate(yield* Clock.currentTimeMillis);
  const failed = yield* advanceOperationJournal({
    current: request.fencedJournal,
    failureCode,
    operationId: request.write.operationId,
    phase: 'failed',
    updatedAt: now,
  });
  yield* port.writeJournal(failed);
  yield* releaseFence(request.fence, request.write.operationId);
});

const commitProjection = Effect.fn('accessLifecycle.commitProjection')(function* commitProjectionEffect(
  request: CommitRequest,
): Effect.fn.Return<CommittedProjection, AccessLifecycleError, AccessWriteJournalPort> {
  const port = yield* AccessWriteJournalPort;
  // A resumed operation that already projected does not project a second time; it commits what it wrote.
  const alreadyProjected = request.fencedJournal.phase === 'projected';
  const projection = alreadyProjected
    ? Result.succeed<string>(request.fencedJournal.projectionToken ?? '')
    : yield* Effect.result(request.write.project(request.write.scopeId));
  if (Result.isFailure(projection)) {
    yield* failOperation(request, 'projection_failed');
    return yield* projection.failure;
  }
  const now = nowDate(yield* Clock.currentTimeMillis);
  const projected = alreadyProjected
    ? request.fencedJournal
    : yield* advanceOperationJournal({
        current: request.fencedJournal,
        operationId: request.write.operationId,
        phase: 'projected',
        projectionToken: projection.success,
        updatedAt: now,
      });
  if (!alreadyProjected) {
    yield* port.writeJournal(projected);
  }
  const committed = yield* advanceOperationJournal({
    current: projected,
    operationId: request.write.operationId,
    phase: 'committed',
    projectionToken: projection.success,
    updatedAt: now,
  });
  yield* port.writeJournal(committed);
  yield* releaseFence(request.fence, request.write.operationId);
  return {
    operationId: request.write.operationId,
    phase: 'committed',
    projectionToken: projection.success,
  };
});

/**
 * The one write path: resume or open the journal of this operation, take the scope fence, project,
 * commit, release. Every access writer goes through it, so D9, D15 and D24 hold for all of them
 * instead of each writer re-implementing a lock and a journal.
 */
export const runAccessWrite = Effect.fn('accessLifecycle.runAccessWrite')(function* runAccessWriteEffect(
  request: AccessWriteRequest,
): Effect.fn.Return<AccessWriteResult, AccessLifecycleError, AccessWriteJournalPort> {
  if (request.change.checks.length === 0) {
    return yield* lifecycleRefusal(
      'change_validation_missing',
      'A change is written only after its validations passed',
    );
  }
  const port = yield* AccessWriteJournalPort;
  const existing = yield* port.readJournal({ operationId: request.operationId, tenantId: request.tenantId });
  // A journal belongs to one command in one scope (D24). Resuming another command's journal would
  // commit somebody else's projection under this operation id, so the digest and the scope must match.
  if (Option.isSome(existing)) {
    const { commandDigest, scopeId, tenantId } = existing.value;
    if (tenantId !== request.tenantId) {
      return yield* lifecycleRefusal(
        'operation_command_mismatch',
        `Journal ${request.operationId} belongs to another tenant, so it is not this operation's work`,
      );
    }
    if (commandDigest !== request.commandDigest) {
      return yield* lifecycleRefusal(
        'operation_command_mismatch',
        `Journal ${request.operationId} records another command, so it is not this operation's work`,
      );
    }
    if (scopeId !== request.scopeId) {
      return yield* lifecycleRefusal(
        'operation_command_mismatch',
        `Journal ${request.operationId} belongs to scope ${scopeId}, not ${request.scopeId}`,
      );
    }
  }
  if (Option.isSome(existing) && existing.value.phase === 'committed') {
    return {
      operationId: request.operationId,
      phase: 'committed',
      projectionToken: existing.value.projectionToken ?? '',
      resumed: true,
    };
  }
  if (Option.isSome(existing) && existing.value.phase === 'failed') {
    return yield* lifecycleRefusal('operation_already_failed', `Operation ${request.operationId} already failed`);
  }
  const startedAt = nowDate(yield* Clock.currentTimeMillis);
  const journal = yield* Option.match(existing, {
    onNone: () =>
      openOperationJournal({
        commandDigest: request.commandDigest,
        operationId: request.operationId,
        scopeId: request.scopeId,
        startedAt,
        tenantId: request.tenantId,
      }),
    onSome: (current) => Effect.succeed(current),
  });
  if (Option.isNone(existing)) {
    yield* port.writeJournal(journal);
  }
  const fence = yield* takeScopeFence({
    current: yield* port.readFence({ scopeId: request.scopeId, tenantId: request.tenantId }),
    operationId: request.operationId,
    scopeId: request.scopeId,
    tenantId: request.tenantId,
  });
  const fenced =
    journal.phase === 'validated'
      ? yield* advanceOperationJournal({
          current: journal,
          operationId: request.operationId,
          phase: 'fenced',
          updatedAt: startedAt,
        })
      : journal;
  if (journal.phase === 'validated') {
    yield* port.writeJournal(fenced);
  }
  const committed = yield* commitProjection({ fence, fencedJournal: fenced, write: request });
  return { ...committed, resumed: Option.isSome(existing) };
});

/**
 * D24: recovery is owned by the operation. It looks the journal up by operation id only, refuses a
 * scope fence that another operation holds, and then resumes the same operation forward. It never
 * adopts, restarts or repairs another operation's work.
 */
export const recoverAccessWrite = Effect.fn('accessLifecycle.recoverAccessWrite')(function* recoverAccessWriteEffect(
  request: AccessWriteRequest,
): Effect.fn.Return<AccessWriteResult, AccessLifecycleError, AccessWriteJournalPort> {
  const port = yield* AccessWriteJournalPort;
  const journal = yield* port.readJournal({ operationId: request.operationId, tenantId: request.tenantId });
  if (Option.isNone(journal)) {
    return yield* lifecycleRefusal(
      'operation_unknown',
      `No journal for ${request.operationId}: recovery resumes an existing operation and never starts one`,
    );
  }
  const fence = yield* port.readFence({ scopeId: journal.value.scopeId, tenantId: journal.value.tenantId });
  const foreignFence = Option.match(fence, {
    onNone: () => false,
    onSome: (current) =>
      current.state === 'Changing' &&
      current.owningOperationId !== undefined &&
      current.owningOperationId !== request.operationId,
  });
  if (foreignFence) {
    return yield* lifecycleRefusal(
      'operation_not_owned',
      `Scope ${journal.value.scopeId} is held by another access operation`,
    );
  }
  return yield* runAccessWrite(request);
});

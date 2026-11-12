import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { and, eq, sql } from 'drizzle-orm';
import { Context, Duration, Effect, Layer, Option, Result, Schema } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';

import { isDatabaseGuardRefusal, isDatabaseIntegrityRefusal } from '../../../database/driver-failure.ts';
import { findPostgresFailure, isPostgresUniqueViolation } from '../../../database/postgres-failure.ts';
import { CoreDatabase } from '../../../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../../../db/database-identities.ts';
import { installOperationalScope } from '../../../db/scoped-transaction.ts';
import { accessOperationJournals, accessScopeFences } from '../../../db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../../db/types.ts';
import type { OperationalScope } from '../../../operations/context.ts';
import { AccessOperationIdSchema, AccessScopeIdSchema, CommandDigestSchema, TenantIdSchema } from '../../ids.ts';
import type { TenantId } from '../../ids.ts';
import {
  ACCESS_MODEL_PARSE_OPTIONS,
  OperationJournalSchema,
  OperationPhaseSchema,
  RevisionSchema,
  ScopeFenceSchema,
  ScopeFenceStateSchema,
  canAdvanceOperationPhase,
} from '../../model.ts';
import type { OperationJournal, OperationPhase, ScopeFence } from '../../model.ts';
import type { AccessLifecycleError } from '../errors.ts';
import { lifecycleRefusal } from '../errors.ts';
import {
  ACCESS_FENCE_CLOCK_SKEW_MARGIN,
  ACCESS_FENCE_LEASE,
  ACCESS_FENCE_PRE_LEASE_IDLE,
  AccessWriteJournalPort,
} from '../fence.ts';
import type {
  AccessWriteJournalPortService,
  FenceAcquireCommand,
  FenceAcquireOutcome,
  FenceLeaseRenewCommand,
  FenceReadCommand,
  FenceReleaseCommand,
  FenceReleaseOutcome,
  FenceTakeOverCommand,
  JournalReadCommand,
} from '../fence.ts';

/**
 * Drizzle persistence of the two rows every access writer shares (D15, D24): the one fence of a
 * scope and the journal of one operation. The rules live in `../fence.ts`; this module makes their
 * compare-and-set atomic and their journal forward-only in the database.
 *
 * The store is built once and takes the caller's `OperationalScope` on every call, which it installs
 * with Core's `installOperationalScope` before it reads or writes (O66). The tenant of a command is
 * therefore never trusted: a command that names a tenant other than the installed scope is refused,
 * and row-level security reaches nothing outside that tenant even if it were not.
 */
export type AccessJournalStoreDatabase = Readonly<{
  /** The enrolled database identities the installed scope is verified against. */
  enrollment: DatabaseIdentityEnrollment;
  executor: CoreDatabaseExecutor;
}>;

/** A failure of the database driver itself, before the store gives it a Core meaning. */
type DriverFailure = EffectDrizzleQueryError | SqlError;
/** What one store statement fails with: a Core refusal, or a driver failure it maps to one. */
type StoreFailure = AccessLifecycleError | DriverFailure;
/** A refusal of the store in the vocabulary of its port. */
type Refusal = (reason: string) => AccessLifecycleError;

/**
 * The lapse of a hold, from the database's own clock, so hosts with skewed clocks agree on it. It is measured from
 * the moment the statement writes it (`clock_timestamp()`), not from the transaction's start: a take can wait behind
 * the shared locks of Actions in flight, and a lease counted from before that wait would lapse early. The holder
 * counts its own 90-second limit from before it sent the statement, so its limit always ends first.
 */
const leaseUntil = sql`pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => ${Duration.toSeconds(ACCESS_FENCE_LEASE)})`;

const fenceColumns = {
  owningOperationId: accessScopeFences.owningOperationId,
  revision: accessScopeFences.revision,
  scopeId: accessScopeFences.scopeId,
  state: accessScopeFences.state,
  tenantId: accessScopeFences.tenantId,
} as const;

const journalColumns = {
  commandDigest: accessOperationJournals.commandDigest,
  failureCode: accessOperationJournals.failureCode,
  operationId: accessOperationJournals.operationId,
  phase: accessOperationJournals.phase,
  projectionToken: accessOperationJournals.projectionToken,
  scopeId: accessOperationJournals.scopeId,
  startedAt: accessOperationJournals.startedAt,
  tenantId: accessOperationJournals.tenantId,
  updatedAt: accessOperationJournals.updatedAt,
} as const;

const journalIdentity = {
  commandDigest: accessOperationJournals.commandDigest,
  operationId: accessOperationJournals.operationId,
  phase: accessOperationJournals.phase,
  scopeId: accessOperationJournals.scopeId,
} as const;

/**
 * The columns as PostgreSQL returns them. `core.access_*` returns raw strings and nulls; the row
 * schemas brand the identifiers and lift a null column into an absent key, and the model decodes the
 * result. Nothing about a stored row is parsed by hand.
 */
interface FenceRow {
  readonly owningOperationId: string | null;
  readonly revision: number;
  readonly scopeId: string;
  readonly state: string;
  readonly tenantId: string;
}

interface JournalRow {
  readonly commandDigest: string;
  readonly failureCode: string | null;
  readonly operationId: string;
  readonly phase: string;
  readonly projectionToken: string | null;
  readonly scopeId: string;
  readonly startedAt: Date;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

const FenceRowSchema = Schema.Struct({
  owningOperationId: Schema.OptionFromNullOr(AccessOperationIdSchema),
  revision: RevisionSchema,
  scopeId: AccessScopeIdSchema,
  state: ScopeFenceStateSchema,
  tenantId: TenantIdSchema,
});
type DecodedFenceRow = Schema.Schema.Type<typeof FenceRowSchema>;

const JournalRowSchema = Schema.Struct({
  commandDigest: CommandDigestSchema,
  failureCode: Schema.OptionFromNullOr(Schema.String),
  operationId: AccessOperationIdSchema,
  phase: OperationPhaseSchema,
  projectionToken: Schema.OptionFromNullOr(Schema.String),
  scopeId: AccessScopeIdSchema,
  startedAt: Schema.Date,
  tenantId: TenantIdSchema,
  updatedAt: Schema.Date,
});
type DecodedJournalRow = Schema.Schema.Type<typeof JournalRowSchema>;

const decodeFenceRow = Schema.decodeUnknownResult(FenceRowSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeJournalRow = Schema.decodeUnknownResult(JournalRowSchema, ACCESS_MODEL_PARSE_OPTIONS);

const fenceStoreUnavailable = (reason: string): AccessLifecycleError =>
  lifecycleRefusal('fence_store_unavailable', reason);
/** A fence command for another tenant names a scope this one cannot reach, so nothing may write. */
const fenceOutOfScope = (reason: string): AccessLifecycleError => lifecycleRefusal('fence_unavailable', reason);
/** A journal of another tenant is never this scope's operation. */
const journalOutOfScope = (reason: string): AccessLifecycleError => lifecycleRefusal('operation_not_owned', reason);
const journalStoreUnavailable = (reason: string): AccessLifecycleError =>
  lifecycleRefusal('operation_store_unavailable', reason);

const decodeScopeFence = Schema.decodeUnknownResult(ScopeFenceSchema, ACCESS_MODEL_PARSE_OPTIONS);
const decodeOperationJournal = Schema.decodeUnknownResult(OperationJournalSchema, ACCESS_MODEL_PARSE_OPTIONS);

/** A column that is `null` in PostgreSQL is an absent key in the model, never an `undefined` value. */
const fenceOf = (row: DecodedFenceRow): ScopeFence => {
  const fence: ScopeFence = {
    revision: row.revision,
    scopeId: row.scopeId,
    state: row.state,
    tenantId: row.tenantId,
  };
  const withOwner: ScopeFence = Option.match(row.owningOperationId, {
    onNone: () => fence,
    onSome: (owningOperationId) => ({ ...fence, owningOperationId }),
  });
  return withOwner;
};

/** The journal row before the model brands it: the projection token and failure code are still text. */
interface JournalRowValue {
  readonly commandDigest: string;
  readonly failureCode?: string;
  readonly operationId: string;
  readonly phase: OperationPhase;
  readonly projectionToken?: string;
  readonly scopeId: string;
  readonly startedAt: Date;
  readonly tenantId: string;
  readonly updatedAt: Date;
}

const journalOf = (row: DecodedJournalRow): JournalRowValue => {
  const journal: JournalRowValue = {
    commandDigest: row.commandDigest,
    operationId: row.operationId,
    phase: row.phase,
    scopeId: row.scopeId,
    startedAt: row.startedAt,
    tenantId: row.tenantId,
    updatedAt: row.updatedAt,
  };
  const withFailureCode: JournalRowValue = Option.match(row.failureCode, {
    onNone: () => journal,
    onSome: (failureCode) => ({ ...journal, failureCode }),
  });
  const withProjectionToken: JournalRowValue = Option.match(row.projectionToken, {
    onNone: () => withFailureCode,
    onSome: (projectionToken) => ({ ...withFailureCode, projectionToken }),
  });
  return withProjectionToken;
};

/** A stored fence is decoded through the shared model, so a row the model refuses never enters Core. */
const fenceFromRow = (row: FenceRow): Effect.Effect<ScopeFence, AccessLifecycleError> =>
  Result.match(decodeFenceRow(row), {
    onFailure: (failure) => Effect.fail(fenceStoreUnavailable(`A stored scope fence is invalid: ${failure.message}`)),
    onSuccess: (fence) =>
      Result.match(decodeScopeFence(fenceOf(fence)), {
        onFailure: (failure) =>
          Effect.fail(fenceStoreUnavailable(`A stored scope fence is invalid: ${failure.message}`)),
        onSuccess: (decoded) => Effect.succeed(decoded),
      }),
  });

const journalFromRow = (row: JournalRow): Effect.Effect<OperationJournal, AccessLifecycleError> =>
  Result.match(decodeJournalRow(row), {
    onFailure: (failure) =>
      Effect.fail(journalStoreUnavailable(`A stored operation journal is invalid: ${failure.message}`)),
    onSuccess: (journal) =>
      Result.match(decodeOperationJournal(journalOf(journal)), {
        onFailure: (failure) =>
          Effect.fail(journalStoreUnavailable(`A stored operation journal is invalid: ${failure.message}`)),
        onSuccess: (decoded) => Effect.succeed(decoded),
      }),
  });

const fenceFrom = (row: FenceRow | undefined): Effect.Effect<Option.Option<ScopeFence>, AccessLifecycleError> =>
  row === undefined ? Effect.succeed(Option.none<ScopeFence>()) : fenceFromRow(row).pipe(Effect.asSome);

const journalFrom = (
  row: JournalRow | undefined,
): Effect.Effect<Option.Option<OperationJournal>, AccessLifecycleError> =>
  row === undefined ? Effect.succeed(Option.none<OperationJournal>()) : journalFromRow(row).pipe(Effect.asSome);

const fenceSqlRefusal = (failure: DriverFailure): AccessLifecycleError => {
  // A fence PostgreSQL refuses can never be written by anybody: this scope's fence is not storable as
  // the command describes it, so the writer re-reads instead of retrying the same write (R4-M1).
  if (isDatabaseIntegrityRefusal(failure)) {
    return fenceOutOfScope(
      Option.match(findPostgresFailure(failure), {
        onNone: () => 'PostgreSQL refused the scope fence this write changes',
        onSome: ({ code }) =>
          `PostgreSQL refused the scope fence this write changes (PostgreSQL ${code}), so nothing may write`,
      }),
    );
  }
  return lifecycleRefusal(
    'fence_store_unavailable',
    Option.match(findPostgresFailure(failure), {
      onNone: () => 'The scope fence store is unavailable',
      onSome: ({ code }) => `The scope fence store is unavailable (PostgreSQL ${code})`,
    }),
  );
};

/** The operation id of a journal is unique in the branch, so a collision is somebody else's journal. */
const JOURNAL_IDENTITY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'access_operation_journals_pkey',
  'access_operation_journals_tenant_id_uk',
]);

const journalSqlRefusal = (failure: DriverFailure): AccessLifecycleError => {
  if (isPostgresUniqueViolation(failure, JOURNAL_IDENTITY_CONSTRAINTS)) {
    return lifecycleRefusal('operation_not_owned', 'That operation id already belongs to another journal');
  }
  // The journal PostgreSQL refused is one it can never store: a terminal journal never reopens, an
  // operation only advances, and a row breaks one of the table's own checks. Retrying the same write
  // cannot succeed, so it is a lifecycle refusal and never unavailability (R4-M1).
  if (isDatabaseIntegrityRefusal(failure)) {
    const reason = Option.match(findPostgresFailure(failure), {
      onNone: () => 'PostgreSQL refused the journal this write describes',
      onSome: ({ code }) => `PostgreSQL refused the journal this write describes (PostgreSQL ${code})`,
    });
    return isDatabaseGuardRefusal(failure)
      ? lifecycleRefusal('operation_phase_regression', reason)
      : lifecycleRefusal('operation_journal_invalid', reason);
  }
  return journalStoreUnavailable('The operation journal store is unavailable');
};

interface ScopedRequest<Value> {
  readonly body: (transaction: CoreTransaction) => Effect.Effect<Value, StoreFailure>;
  readonly database: AccessJournalStoreDatabase;
  readonly refusal: (failure: DriverFailure) => AccessLifecycleError;
  readonly scope: OperationalScope;
  readonly scopeRefusal: Refusal;
}

/**
 * Runs one statement inside the caller's operational scope: Core installs the scope's tenant (and
 * legal entity) on the transaction and verifies it, so every statement is bounded by that tenant's
 * row-level security policies. A driver failure becomes the refusal the port names: a store that
 * cannot read or write must stop the writer, never retry it.
 */
const runScoped = <Value>(request: ScopedRequest<Value>): Effect.Effect<Value, AccessLifecycleError> =>
  request.database.executor
    .transaction((transaction) =>
      installOperationalScope(transaction, request.scope, request.database.enrollment).pipe(
        Effect.catchTag('OperationContextUnavailable', (failure) =>
          Effect.fail(request.scopeRefusal(`The operation scope could not be installed (${failure.code})`)),
        ),
        Effect.andThen(request.body(transaction)),
      ),
    )
    .pipe(
      Effect.catchTags({
        EffectDrizzleQueryError: (failure) => Effect.fail(request.refusal(failure)),
        SqlError: (failure) => Effect.fail(request.refusal(failure)),
      }),
    );

/**
 * O66: the tenant of a command is never trusted. A command that names another tenant than the
 * installed scope is refused before it reaches the database, whatever the policies would do.
 */
const requireScopedTenant = (
  scope: OperationalScope,
  tenantId: TenantId,
  refusal: Refusal,
): Effect.Effect<void, AccessLifecycleError> =>
  tenantId === scope.tenantId
    ? Effect.void
    : Effect.fail(
        refusal(`A command for tenant ${tenantId} is not this scope's work: the scope is tenant ${scope.tenantId}`),
      );

interface FenceAcquireTransactionRequest {
  readonly command: FenceAcquireCommand;
  readonly transaction: CoreTransaction;
}

/**
 * Wait for the fence row's lock before writing it. A take can wait behind the shared locks of Actions in flight, and
 * PostgreSQL computes an UPDATE's new values before such a wait: locking first makes the lease the take writes count
 * from the moment the take actually holds the row.
 */
const lockFenceRow = (transaction: CoreTransaction, command: { readonly scopeId: string; readonly tenantId: string }) =>
  transaction
    .select({ scopeId: accessScopeFences.scopeId })
    .from(accessScopeFences)
    .where(and(eq(accessScopeFences.scopeId, command.scopeId), eq(accessScopeFences.tenantId, command.tenantId)))
    .for('update');

const acquireFenceTransaction = Effect.fn('accessLifecycle.persistence.acquireFenceTransaction')(
  function* acquireFenceTransactionEffect(
    request: FenceAcquireTransactionRequest,
  ): Effect.fn.Return<FenceAcquireOutcome, StoreFailure> {
    const { command, transaction } = request;
    yield* lockFenceRow(transaction, command);
    const acquired = yield* transaction
      .update(accessScopeFences)
      .set({
        leaseExpiresAt: leaseUntil,
        owningOperationId: command.operationId,
        revision: sql`${accessScopeFences.revision} + 1`,
        state: 'Changing',
      })
      .where(
        and(
          eq(accessScopeFences.scopeId, command.scopeId),
          eq(accessScopeFences.tenantId, command.tenantId),
          eq(accessScopeFences.revision, command.expectedRevision),
          eq(accessScopeFences.state, 'Ready'),
        ),
      )
      .returning(fenceColumns);
    const [taken] = acquired;
    if (taken !== undefined) {
      const fence = yield* fenceFromRow(taken);
      return { _tag: 'Acquired', fence };
    }
    // The compare-and-set matched nothing: either the scope has no fence at all, or another writer
    // moved it away from the revision this one read. Both must reach the caller.
    const observed = yield* transaction
      .select(fenceColumns)
      .from(accessScopeFences)
      .where(and(eq(accessScopeFences.scopeId, command.scopeId), eq(accessScopeFences.tenantId, command.tenantId)));
    const [current] = observed;
    if (current === undefined) {
      return yield* lifecycleRefusal(
        'fence_unavailable',
        `Scope ${command.scopeId} has no scope fence for this tenant, so nothing may write`,
      );
    }
    const fence = yield* fenceFromRow(current);
    return { _tag: 'Conflict', fence };
  },
);

const acquireFence = Effect.fn('accessLifecycle.persistence.acquireFence')(function* acquireFenceEffect(
  database: AccessJournalStoreDatabase,
  scope: OperationalScope,
  command: FenceAcquireCommand,
): Effect.fn.Return<FenceAcquireOutcome, AccessLifecycleError> {
  yield* requireScopedTenant(scope, command.tenantId, fenceOutOfScope);
  return yield* runScoped({
    body: (transaction) => acquireFenceTransaction({ command, transaction }),
    database,
    refusal: fenceSqlRefusal,
    scope,
    scopeRefusal: fenceStoreUnavailable,
  });
});

interface FenceReleaseTransactionRequest {
  readonly command: FenceReleaseCommand;
  readonly transaction: CoreTransaction;
}

const releaseFenceTransaction = Effect.fn('accessLifecycle.persistence.releaseFenceTransaction')(
  function* releaseFenceTransactionEffect(
    request: FenceReleaseTransactionRequest,
  ): Effect.fn.Return<FenceReleaseOutcome, StoreFailure> {
    const { command, transaction } = request;
    const released = yield* transaction
      .update(accessScopeFences)
      .set({
        leaseExpiresAt: null,
        owningOperationId: null,
        revision: sql`${accessScopeFences.revision} + 1`,
        state: 'Ready',
      })
      .where(
        and(
          eq(accessScopeFences.scopeId, command.scopeId),
          eq(accessScopeFences.tenantId, command.tenantId),
          eq(accessScopeFences.revision, command.expectedRevision),
          eq(accessScopeFences.state, 'Changing'),
          eq(accessScopeFences.owningOperationId, command.operationId),
        ),
      )
      .returning(fenceColumns);
    const [givenBack] = released;
    if (givenBack !== undefined) {
      const fence = yield* fenceFromRow(givenBack);
      return { _tag: 'Released', fence };
    }
    // Only the operation that observed this revision holds this fence; anybody else finds the row
    // where the other writer left it and stops instead of freeing a lock it never held.
    const observed = yield* transaction
      .select(fenceColumns)
      .from(accessScopeFences)
      .where(and(eq(accessScopeFences.scopeId, command.scopeId), eq(accessScopeFences.tenantId, command.tenantId)));
    const [current] = observed;
    if (current === undefined) {
      return yield* lifecycleRefusal(
        'fence_unavailable',
        `Scope ${command.scopeId} has no scope fence for this tenant, so nothing may release one`,
      );
    }
    const fence = yield* fenceFromRow(current);
    return { _tag: 'Conflict', fence };
  },
);

const releaseFence = Effect.fn('accessLifecycle.persistence.releaseFence')(function* releaseFenceEffect(
  database: AccessJournalStoreDatabase,
  scope: OperationalScope,
  command: FenceReleaseCommand,
): Effect.fn.Return<FenceReleaseOutcome, AccessLifecycleError> {
  yield* requireScopedTenant(scope, command.tenantId, fenceOutOfScope);
  return yield* runScoped({
    body: (transaction) => releaseFenceTransaction({ command, transaction }),
    database,
    refusal: fenceSqlRefusal,
    scope,
    scopeRefusal: fenceStoreUnavailable,
  });
});

/** The holder's lease, renewed only while it still owns the fence; the revision never moves on a renewal. */
const renewFenceLeaseTransaction = Effect.fn('accessLifecycle.persistence.renewFenceLeaseTransaction')(
  function* renewFenceLeaseTransactionEffect(request: {
    readonly command: FenceLeaseRenewCommand;
    readonly transaction: CoreTransaction;
  }): Effect.fn.Return<boolean, StoreFailure> {
    const { command, transaction } = request;
    const renewed = yield* transaction
      .update(accessScopeFences)
      .set({ leaseExpiresAt: leaseUntil })
      .where(
        and(
          eq(accessScopeFences.scopeId, command.scopeId),
          eq(accessScopeFences.tenantId, command.tenantId),
          eq(accessScopeFences.state, 'Changing'),
          eq(accessScopeFences.owningOperationId, command.operationId),
        ),
      )
      .returning({ scopeId: accessScopeFences.scopeId });
    return renewed.length === 1;
  },
);

const renewFenceLease = Effect.fn('accessLifecycle.persistence.renewFenceLease')(function* renewFenceLeaseEffect(
  database: AccessJournalStoreDatabase,
  scope: OperationalScope,
  command: FenceLeaseRenewCommand,
): Effect.fn.Return<boolean, AccessLifecycleError> {
  yield* requireScopedTenant(scope, command.tenantId, fenceOutOfScope);
  return yield* runScoped({
    body: (transaction) => renewFenceLeaseTransaction({ command, transaction }),
    database,
    refusal: fenceSqlRefusal,
    scope,
    scopeRefusal: fenceStoreUnavailable,
  });
});

/**
 * Whether the observed holder's lease has lapsed, on the database clock. A hold taken before leases existed has
 * none: it counts as lapsed once its journal has not moved for `ACCESS_FENCE_PRE_LEASE_IDLE` plus the clock skew
 * margin. A writer of the previous release moves its journal only between phases, never while it writes the
 * engine, so that idle time is longer than any real projection; the journal's timestamp comes from the writer's
 * clock, hence the margin.
 *
 * A hold whose operation's journal already ended as `failed` is lapsed at once, whatever its lease: a failed
 * operation never writes or commits again (its writer marks the journal only after it stopped), so the fence it
 * kept closed only waits for the next writer to take it over and finish a whole projection.
 */
const PRE_LEASE_LAPSE_SECONDS =
  Duration.toSeconds(ACCESS_FENCE_PRE_LEASE_IDLE) + Duration.toSeconds(ACCESS_FENCE_CLOCK_SKEW_MARGIN);
const holdLapsed = (previousOperationId: string) => sql`coalesce(
  ${accessScopeFences.leaseExpiresAt},
  (select j.updated_at + pg_catalog.make_interval(secs => ${PRE_LEASE_LAPSE_SECONDS})
     from core.access_operation_journals j
    where j.tenant_id = ${accessScopeFences.tenantId} and j.operation_id = ${previousOperationId}::uuid)
) < pg_catalog.now() or exists (
  select 1 from core.access_operation_journals j
   where j.tenant_id = ${accessScopeFences.tenantId} and j.operation_id = ${previousOperationId}::uuid
     and j.phase = 'failed'
)`;

/**
 * D15 for a dead holder: one transaction takes a fence whose holder's lease lapsed (compare-and-set on the
 * revision and the holder this operation observed) and ends that holder's journal as `failed`, so it can neither
 * release nor resume. A live hold is never taken: the row comes back as a `Conflict`.
 */
const takeOverExpiredFenceTransaction = Effect.fn('accessLifecycle.persistence.takeOverExpiredFenceTransaction')(
  function* takeOverExpiredFenceTransactionEffect(request: {
    readonly command: FenceTakeOverCommand;
    readonly transaction: CoreTransaction;
  }): Effect.fn.Return<FenceAcquireOutcome, StoreFailure> {
    const { command, transaction } = request;
    yield* lockFenceRow(transaction, command);
    const taken = yield* transaction
      .update(accessScopeFences)
      .set({
        leaseExpiresAt: leaseUntil,
        owningOperationId: command.operationId,
        revision: sql`${accessScopeFences.revision} + 1`,
      })
      .where(
        and(
          eq(accessScopeFences.scopeId, command.scopeId),
          eq(accessScopeFences.tenantId, command.tenantId),
          eq(accessScopeFences.revision, command.expectedRevision),
          eq(accessScopeFences.state, 'Changing'),
          eq(accessScopeFences.owningOperationId, command.previousOperationId),
          holdLapsed(command.previousOperationId),
        ),
      )
      .returning(fenceColumns);
    const [row] = taken;
    if (row !== undefined) {
      yield* transaction
        .update(accessOperationJournals)
        .set({ failureCode: 'lease_expired', phase: 'failed', updatedAt: sql`pg_catalog.now()` })
        .where(
          and(
            eq(accessOperationJournals.tenantId, command.tenantId),
            eq(accessOperationJournals.operationId, command.previousOperationId),
            sql`${accessOperationJournals.phase} not in ('committed', 'failed')`,
          ),
        );
      return { _tag: 'Acquired', fence: yield* fenceFromRow(row) };
    }
    const observed = yield* transaction
      .select(fenceColumns)
      .from(accessScopeFences)
      .where(and(eq(accessScopeFences.scopeId, command.scopeId), eq(accessScopeFences.tenantId, command.tenantId)));
    const [current] = observed;
    if (current === undefined) {
      return yield* lifecycleRefusal(
        'fence_unavailable',
        `Scope ${command.scopeId} has no scope fence for this tenant, so nothing may write`,
      );
    }
    return { _tag: 'Conflict', fence: yield* fenceFromRow(current) };
  },
);

const takeOverExpiredFence = Effect.fn('accessLifecycle.persistence.takeOverExpiredFence')(
  function* takeOverExpiredFenceEffect(
    database: AccessJournalStoreDatabase,
    scope: OperationalScope,
    command: FenceTakeOverCommand,
  ): Effect.fn.Return<FenceAcquireOutcome, AccessLifecycleError> {
    yield* requireScopedTenant(scope, command.tenantId, fenceOutOfScope);
    return yield* runScoped({
      body: (transaction) => takeOverExpiredFenceTransaction({ command, transaction }),
      database,
      refusal: fenceSqlRefusal,
      scope,
      scopeRefusal: fenceStoreUnavailable,
    });
  },
);

const readFenceTransaction = Effect.fn('accessLifecycle.persistence.readFenceTransaction')(
  function* readFenceTransactionEffect(request: {
    readonly command: FenceReadCommand;
    readonly transaction: CoreTransaction;
  }): Effect.fn.Return<Option.Option<ScopeFence>, StoreFailure> {
    const { command, transaction } = request;
    const rows = yield* transaction
      .select(fenceColumns)
      .from(accessScopeFences)
      .where(and(eq(accessScopeFences.scopeId, command.scopeId), eq(accessScopeFences.tenantId, command.tenantId)));
    return yield* fenceFrom(rows[0]);
  },
);

const readFence = Effect.fn('accessLifecycle.persistence.readFence')(function* readFenceEffect(
  database: AccessJournalStoreDatabase,
  scope: OperationalScope,
  command: FenceReadCommand,
): Effect.fn.Return<Option.Option<ScopeFence>, AccessLifecycleError> {
  yield* requireScopedTenant(scope, command.tenantId, fenceOutOfScope);
  return yield* runScoped({
    body: (transaction) => readFenceTransaction({ command, transaction }),
    database,
    refusal: fenceSqlRefusal,
    scope,
    scopeRefusal: fenceStoreUnavailable,
  });
});

const readJournalTransaction = Effect.fn('accessLifecycle.persistence.readJournalTransaction')(
  function* readJournalTransactionEffect(request: {
    readonly command: JournalReadCommand;
    readonly transaction: CoreTransaction;
  }): Effect.fn.Return<Option.Option<OperationJournal>, StoreFailure> {
    const { command, transaction } = request;
    const rows = yield* transaction
      .select(journalColumns)
      .from(accessOperationJournals)
      .where(
        and(
          eq(accessOperationJournals.operationId, command.operationId),
          eq(accessOperationJournals.tenantId, command.tenantId),
        ),
      );
    return yield* journalFrom(rows[0]);
  },
);

const readJournal = Effect.fn('accessLifecycle.persistence.readJournal')(function* readJournalEffect(
  database: AccessJournalStoreDatabase,
  scope: OperationalScope,
  command: JournalReadCommand,
): Effect.fn.Return<Option.Option<OperationJournal>, AccessLifecycleError> {
  yield* requireScopedTenant(scope, command.tenantId, journalOutOfScope);
  return yield* runScoped({
    body: (transaction) => readJournalTransaction({ command, transaction }),
    database,
    refusal: journalSqlRefusal,
    scope,
    scopeRefusal: journalStoreUnavailable,
  });
});

/**
 * D24: the journal of one operation only advances forward, and only for the command and scope it was
 * opened for. The trigger on the table says the same thing; the store refuses first so a writer gets
 * a lifecycle refusal with the reason instead of an opaque database error. A terminal journal is
 * immutable: not even a write of the same phase may rewrite its token or its failure (R4-L3).
 */
const refuseJournalWrite = (
  stored:
    | {
        readonly commandDigest: string;
        readonly operationId: string;
        readonly phase: OperationPhase;
        readonly scopeId: string;
      }
    | undefined,
  journal: OperationJournal,
): Effect.Effect<void, AccessLifecycleError> => {
  if (stored === undefined) {
    return Effect.void;
  }
  if (stored.commandDigest !== journal.commandDigest || stored.scopeId !== journal.scopeId) {
    return Effect.fail(
      lifecycleRefusal(
        'operation_command_mismatch',
        `Journal ${journal.operationId} records another command or scope, so it is not this operation's work`,
      ),
    );
  }
  if (stored.phase === 'committed' || stored.phase === 'failed') {
    return Effect.fail(
      lifecycleRefusal('operation_terminal', `Operation ${journal.operationId} already ended as ${stored.phase}`),
    );
  }
  if (stored.phase === journal.phase) {
    return Effect.void;
  }
  return canAdvanceOperationPhase(stored.phase, journal.phase)
    ? Effect.void
    : Effect.fail(
        lifecycleRefusal(
          'operation_phase_regression',
          `Operation ${journal.operationId} cannot move from ${stored.phase} back to ${journal.phase}`,
        ),
      );
};

const journalRowOf = (journal: OperationJournal, tenantId: string) => ({
  commandDigest: journal.commandDigest,
  failureCode: journal.failureCode ?? null,
  operationId: journal.operationId,
  phase: journal.phase,
  projectionToken: journal.projectionToken ?? null,
  scopeId: journal.scopeId,
  startedAt: journal.startedAt,
  tenantId,
  updatedAt: journal.updatedAt,
});

/** Advances the journal row this operation id already owns; the caller holds it under a row lock. */
const advanceStoredJournal = (
  transaction: CoreTransaction,
  journal: OperationJournal,
  tenantId: string,
): Effect.Effect<void, StoreFailure> =>
  transaction
    .update(accessOperationJournals)
    .set({
      failureCode: journal.failureCode ?? null,
      phase: journal.phase,
      projectionToken: journal.projectionToken ?? null,
      updatedAt: journal.updatedAt,
    })
    .where(
      and(eq(accessOperationJournals.operationId, journal.operationId), eq(accessOperationJournals.tenantId, tenantId)),
    )
    .pipe(Effect.asVoid);

/**
 * D24 and R4-M2: the journal of one operation id is opened exactly once and then only advanced by the
 * command and scope that opened it. The row is read under a row lock, so the forward-only comparison
 * decides against the state PostgreSQL holds rather than one another writer is about to replace, and
 * the opener is claimed with an insert that writes nothing when another writer got there first. That
 * writer's committed row is then what this one is refused against, so a second command never advances
 * somebody else's journal into its own phases.
 */
const writeJournalTransaction = Effect.fn('accessLifecycle.persistence.writeJournalTransaction')(
  function* writeJournalTransactionEffect(request: {
    readonly journal: OperationJournal;
    readonly transaction: CoreTransaction;
  }): Effect.fn.Return<void, StoreFailure> {
    const { journal, tenantId, transaction } = { ...request, tenantId: request.journal.tenantId };
    const readStored = transaction
      .select(journalIdentity)
      .from(accessOperationJournals)
      .where(
        and(
          eq(accessOperationJournals.operationId, journal.operationId),
          eq(accessOperationJournals.tenantId, tenantId),
        ),
      )
      .for('update');
    const stored = yield* readStored;
    if (stored[0] !== undefined) {
      yield* refuseJournalWrite(stored[0], journal);
      return yield* advanceStoredJournal(transaction, journal, tenantId);
    }
    const claimed = yield* transaction
      .insert(accessOperationJournals)
      .values(journalRowOf(journal, tenantId))
      .onConflictDoNothing()
      .returning({ operationId: accessOperationJournals.operationId });
    if (claimed.length === 1) {
      return yield* Effect.void;
    }
    // Another writer opened this operation id between this read and this insert. PostgreSQL handed the
    // conflict to that writer's row, so the journal this command may advance is that row or none.
    const raced = yield* readStored;
    if (raced[0] === undefined) {
      // The row that took the id is not this scope's to read: another tenant holds it, and an operation
      // id is never reused across tenants.
      return yield* lifecycleRefusal('operation_not_owned', 'That operation id already belongs to another journal');
    }
    yield* refuseJournalWrite(raced[0], journal);
    return yield* advanceStoredJournal(transaction, journal, tenantId);
  },
);

const writeJournal = Effect.fn('accessLifecycle.persistence.writeJournal')(function* writeJournalEffect(
  database: AccessJournalStoreDatabase,
  scope: OperationalScope,
  journal: OperationJournal,
): Effect.fn.Return<void, AccessLifecycleError> {
  yield* requireScopedTenant(scope, journal.tenantId, journalOutOfScope);
  return yield* runScoped({
    body: (transaction) => writeJournalTransaction({ journal, transaction }),
    database,
    refusal: journalSqlRefusal,
    scope,
    scopeRefusal: journalStoreUnavailable,
  });
});

/**
 * The fence and journal store, unbound to any tenant: every call names the caller's operational
 * scope, which the store installs before it touches a row (O66).
 */
export interface AccessWriteJournalStoreService {
  readonly acquireFence: (
    scope: OperationalScope,
    command: FenceAcquireCommand,
  ) => Effect.Effect<FenceAcquireOutcome, AccessLifecycleError>;
  readonly readFence: (
    scope: OperationalScope,
    command: FenceReadCommand,
  ) => Effect.Effect<Option.Option<ScopeFence>, AccessLifecycleError>;
  readonly readJournal: (
    scope: OperationalScope,
    command: JournalReadCommand,
  ) => Effect.Effect<Option.Option<OperationJournal>, AccessLifecycleError>;
  readonly releaseFence: (
    scope: OperationalScope,
    command: FenceReleaseCommand,
  ) => Effect.Effect<FenceReleaseOutcome, AccessLifecycleError>;
  /** Optional so a store double without leases stays valid; the database store always provides it. */
  readonly renewFenceLease?: (
    scope: OperationalScope,
    command: FenceLeaseRenewCommand,
  ) => Effect.Effect<boolean, AccessLifecycleError>;
  readonly takeOverExpiredFence?: (
    scope: OperationalScope,
    command: FenceTakeOverCommand,
  ) => Effect.Effect<FenceAcquireOutcome, AccessLifecycleError>;
  readonly writeJournal: (
    scope: OperationalScope,
    journal: OperationJournal,
  ) => Effect.Effect<void, AccessLifecycleError>;
}

/**
 * The fence and journal store as Core provides it: one instance for the process, scoped by the
 * caller's `OperationalScope` on every call (O66).
 */
export class AccessWriteJournalStore extends Context.Service<AccessWriteJournalStore, AccessWriteJournalStoreService>()(
  '@app/core-runtime/access/lifecycle/persistence/journal-store/AccessWriteJournalStore',
) {}

export const makeAccessWriteJournalStore = (database: AccessJournalStoreDatabase): AccessWriteJournalStoreService => ({
  acquireFence: (scope, command) => acquireFence(database, scope, command),
  readFence: (scope, command) => readFence(database, scope, command),
  readJournal: (scope, command) => readJournal(database, scope, command),
  releaseFence: (scope, command) => releaseFence(database, scope, command),
  renewFenceLease: (scope, command) => renewFenceLease(database, scope, command),
  takeOverExpiredFence: (scope, command) => takeOverExpiredFence(database, scope, command),
  writeJournal: (scope, journal) => writeJournal(database, scope, journal),
});

/** The fence and journal store of the process database. */
export const AccessWriteJournalStoreLive: Layer.Layer<
  AccessWriteJournalStore,
  never,
  CoreDatabase | DatabaseIdentityEnrollmentContext
> = Layer.effect(
  AccessWriteJournalStore,
  Effect.gen(function* accessWriteJournalStoreLayer() {
    const database = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    return makeAccessWriteJournalStore({ enrollment, executor: database.executor });
  }),
);

/**
 * The lifecycle port of one request scope. `runAccessWrite` carries no scope of its own, so the caller
 * that knows the request's scope provides this adapter beside the store. The commands still name
 * their tenant, and the store refuses any command whose tenant is not the scope's.
 */
export const accessWriteJournalPortLayer = (
  scope: OperationalScope,
): Layer.Layer<AccessWriteJournalPort, never, AccessWriteJournalStore> =>
  Layer.effect(
    AccessWriteJournalPort,
    AccessWriteJournalStore.pipe(
      Effect.map((store) => {
        const { renewFenceLease: renew, takeOverExpiredFence: takeOver } = store;
        const base: AccessWriteJournalPortService = {
          acquireFence: (command) => store.acquireFence(scope, command),
          readFence: (command) => store.readFence(scope, command),
          readJournal: (command) => store.readJournal(scope, command),
          releaseFence: (command) => store.releaseFence(scope, command),
          writeJournal: (journal) => store.writeJournal(scope, journal),
        };
        // The lease operations exist exactly when the store has them.
        return renew === undefined || takeOver === undefined
          ? base
          : {
              ...base,
              renewFenceLease: (command) => renew(scope, command),
              takeOverExpiredFence: (command) => takeOver(scope, command),
            };
      }),
    ),
  );

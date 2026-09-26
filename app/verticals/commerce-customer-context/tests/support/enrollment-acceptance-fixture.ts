import { loadDatabaseConnectionPair, scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { Context, Effect, Schema } from 'effect';

import { layerTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { acquireFixturePgClient } from './fixture-pg-client.ts';
import type { CommerceCustomerContextTransaction } from '../../src/database/types.ts';
import {
  commerceCustomerContextRelations,
  portalEnrollmentAttempts,
  portalEnrollmentOwnerOperations,
} from '../../src/database/schema.ts';
import type { EnrollmentAttemptSnapshot, StartEnrollmentAttemptInput } from '../../shared/enrollment-contracts.ts';
import { commerceEnrollmentAttemptPersistenceForTransaction } from '../../src/enrollment/attempts/attempt-persistence.ts';
import type {
  CommerceEnrollmentOwnerScope,
  EnrollmentDueWorkExecution,
} from '../../src/enrollment/attempts/attempt-persistence.ts';
import {
  CommerceEnrollmentAttemptErrorSchema,
  CommerceEnrollmentAttemptUnavailable,
} from '../../src/enrollment/attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../../src/enrollment/attempts/errors.ts';
import { commerceEnrollmentOwnerAttemptStoreForRun } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import type {
  CommerceEnrollmentOwnerTransactionRun,
  CommerceEnrollmentWorkerTransactionRun,
} from '../../src/enrollment/orchestration/owner-transition-production.ts';
import type { CommerceEnrollmentOwnerAttemptStore } from '../../src/enrollment/orchestration/owner-transition-driver.ts';

/**
 * PostgreSQL fixture where only the owner effect is scripted; the driver, Attempt service,
 * SECURITY DEFINER routines and tenant policies all run for real.
 */

/** The Drizzle/Effect executor the fixture drives both the runtime and the admin role through. */
type EnrollmentAcceptanceDatabase = TestDatabaseFromClient<typeof commerceCustomerContextRelations>;

class AcceptanceDatabase extends Context.Service<AcceptanceDatabase, EnrollmentAcceptanceDatabase>()(
  '@app/commerce-customer-context/tests/support/AcceptanceDatabase',
) {}

export interface EnrollmentAcceptanceFixture {
  /** Owner-role executor, used only to seed, inspect and clean up fixture rows. */
  readonly admin: EnrollmentAcceptanceDatabase;
  /** Removes every Attempt and owner operation of the fixture Tenant. */
  readonly cleanup: () => Effect.Effect<void>;
  /** The production generic owner store, backed by one real transaction per phase. */
  readonly ownerStore: CommerceEnrollmentOwnerAttemptStore;
  readonly run: CommerceEnrollmentOwnerTransactionRun;
  /**
   * The same runtime-role transaction as `runWorker`, with the fixture's verified Tenant installed
   * the way every request installs it. It is how a test asks what a request-scoped caller gets.
   */
  readonly runRequestScoped: CommerceEnrollmentWorkerTransactionRun;
  /** One worker transaction on the runtime role, with no operational scope installed. */
  readonly runWorker: CommerceEnrollmentWorkerTransactionRun;
  readonly scope: CommerceEnrollmentOwnerScope;
}

const transactionUnavailable = <Cause>(cause: Cause): CommerceEnrollmentAttemptError =>
  Object.defineProperty(
    new CommerceEnrollmentAttemptUnavailable({
      code: 'attempt_unavailable',
      reason: 'The durable Enrollment Attempt transaction could not be completed',
      retryable: true,
    }),
    'cause',
    { configurable: false, enumerable: false, value: cause },
  );

const executorFor =
  (transaction: CommerceCustomerContextTransaction) => (statement: Parameters<typeof transaction.execute>[0]) =>
    transaction.execute(statement, 'objects');

/** One owner phase, one transaction, scope installed the same way production installs it. */
const acceptanceTransactionRun =
  (database: EnrollmentAcceptanceDatabase): CommerceEnrollmentOwnerTransactionRun =>
  (scope, operation) =>
    database
      .transaction((transaction) =>
        transaction
          .execute(
            sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true), set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`,
            'objects',
          )
          .pipe(Effect.flatMap(() => operation(scopedRoutineInvokerFromTransaction(executorFor(transaction), scope)))),
      )
      .pipe(
        Effect.mapError((failure) =>
          Schema.is(CommerceEnrollmentAttemptErrorSchema)(failure) ? failure : transactionUnavailable(failure),
        ),
      );

/**
 * One worker tick, one transaction, and no `set_config` at all: the cross-Tenant due-work routine
 * refuses a transaction that installed a verified Tenant, so installing one here would make every
 * sweeper test fail closed rather than exercise the listing.
 */
const acceptanceWorkerRun =
  (
    database: EnrollmentAcceptanceDatabase,
    scope?: CommerceEnrollmentOwnerScope,
  ): CommerceEnrollmentWorkerTransactionRun =>
  (operation) =>
    database
      .transaction((transaction) => {
        const raw: EnrollmentDueWorkExecution = (statement) =>
          transaction.execute(statement, 'objects').pipe(Effect.mapError(transactionUnavailable));
        return scope === undefined
          ? operation(raw)
          : transaction
              .execute(
                sql`select set_config('ontos.tenant_id', ${scope.tenantId}, true), set_config('ontos.legal_entity_id', ${scope.legalEntityId ?? ''}, true)`,
                'objects',
              )
              .pipe(Effect.flatMap(() => operation(raw)));
      })
      .pipe(
        Effect.mapError((failure) =>
          Schema.is(CommerceEnrollmentAttemptErrorSchema)(failure) ? failure : transactionUnavailable(failure),
        ),
      );

/** Acquires the admin and runtime clients and builds the production owner store on the runtime role. */
export const makeEnrollmentAcceptanceFixture = Effect.fnUntraced(function* makeEnrollmentAcceptanceFixture(
  scope: CommerceEnrollmentOwnerScope,
) {
  const connections = yield* loadDatabaseConnectionPair();
  const adminClient = yield* acquireFixturePgClient(connections.admin.connectionString);
  const runtimeClient = yield* acquireFixturePgClient(connections.runtime.connectionString, 4);
  const admin = yield* AcceptanceDatabase.pipe(
    Effect.provide(layerTestDatabaseFromClient(AcceptanceDatabase, adminClient, commerceCustomerContextRelations)),
  );
  const runtime = yield* AcceptanceDatabase.pipe(
    Effect.provide(layerTestDatabaseFromClient(AcceptanceDatabase, runtimeClient, commerceCustomerContextRelations)),
  );
  const cleanup = () =>
    admin
      .transaction((transaction) =>
        Effect.gen(function* deleteFixtureRows() {
          yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
          yield* transaction
            .delete(portalEnrollmentOwnerOperations)
            .where(eq(portalEnrollmentOwnerOperations.tenantId, scope.tenantId));
          yield* transaction
            .delete(portalEnrollmentAttempts)
            .where(eq(portalEnrollmentAttempts.tenantId, scope.tenantId));
        }),
      )
      .pipe(Effect.orDie);
  const run = acceptanceTransactionRun(runtime);
  const fixture: EnrollmentAcceptanceFixture = {
    admin,
    cleanup,
    ownerStore: commerceEnrollmentOwnerAttemptStoreForRun(scope, run),
    run,
    runRequestScoped: acceptanceWorkerRun(runtime, scope),
    runWorker: acceptanceWorkerRun(runtime),
    scope,
  };
  yield* fixture.cleanup();
  yield* Effect.addFinalizer(() => fixture.cleanup());
  return fixture;
});

/** Creates the durable Attempt the journey then advances, through the same routine the Action uses. */
export const startEnrollmentAcceptanceAttempt = (
  fixture: EnrollmentAcceptanceFixture,
  input: StartEnrollmentAttemptInput,
): Effect.Effect<EnrollmentAttemptSnapshot, CommerceEnrollmentAttemptError> =>
  fixture
    .run(fixture.scope, (transaction) =>
      commerceEnrollmentAttemptPersistenceForTransaction(transaction, fixture.scope).create(input),
    )
    .pipe(Effect.map((created) => created.attempt));

/** Moves an Attempt's still-running leases into the past, as if the worker had disappeared. */
export const expireEnrollmentAcceptanceLeases = (
  fixture: EnrollmentAcceptanceFixture,
  portalEnrollmentAttemptId: string,
): Effect.Effect<void> =>
  fixture.admin
    .transaction((transaction) =>
      Effect.gen(function* expireBothLeases() {
        yield* transaction.execute(
          sql`
            update commerce_customer_context.portal_enrollment_attempts
               set lease_expires_at = statement_timestamp() - interval '1 second'
             where tenant_id = ${fixture.scope.tenantId}::uuid
               and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
          `,
          'objects',
        );
        yield* transaction.execute(
          sql`
            update commerce_customer_context.portal_enrollment_owner_operations
               set lease_expires_at = statement_timestamp() - interval '1 second'
             where tenant_id = ${fixture.scope.tenantId}::uuid
               and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
               and status = 'IN_PROGRESS'
          `,
          'objects',
        );
      }),
    )
    .pipe(Effect.asVoid, Effect.orDie);

/**
 * Moves an Attempt's last activity to an exact instant. The due-work listing is cross-Tenant and
 * ordered by activity, so a test that needs a known position in that order states it rather than
 * hoping the wall clock produced one.
 */
export const backdateEnrollmentAcceptanceAttempt = (
  fixture: EnrollmentAcceptanceFixture,
  portalEnrollmentAttemptId: string,
  updatedAt: string,
): Effect.Effect<void> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute(
        sql`
          update commerce_customer_context.portal_enrollment_attempts
             set updated_at = ${updatedAt}::timestamptz
           where tenant_id = ${fixture.scope.tenantId}::uuid
             and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(Effect.asVoid, Effect.orDie);

/**
 * Moves an Attempt's durable revision and nothing else. Every real transition moves it too; this
 * states the one fact the durable sweep budget reads — "something has moved this Attempt since the
 * count was spent" — so a test of that rule need not drive a whole journey to produce it.
 */
export const advanceEnrollmentAcceptanceAttemptRevision = (
  fixture: EnrollmentAcceptanceFixture,
  portalEnrollmentAttemptId: string,
): Effect.Effect<void> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute(
        sql`
          update commerce_customer_context.portal_enrollment_attempts
             set revision = revision + 1
           where tenant_id = ${fixture.scope.tenantId}::uuid
             and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(Effect.asVoid, Effect.orDie);

interface EnrollmentAcceptanceOwnerOperationRow extends Record<string, unknown> {
  readonly outcome_code: string | null;
  readonly reconciliation_ref: string | null;
  readonly result_reference: string | null;
  readonly status: string;
  readonly transition_key: string;
}

/** Every durable owner operation of one Attempt, in creation order, read with the owner role. */
export const readEnrollmentAcceptanceOperations = (
  fixture: EnrollmentAcceptanceFixture,
  portalEnrollmentAttemptId: string,
): Effect.Effect<readonly EnrollmentAcceptanceOwnerOperationRow[]> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute<EnrollmentAcceptanceOwnerOperationRow>(
        sql`
          select transition_key, status, outcome_code, result_reference, reconciliation_ref
            from commerce_customer_context.portal_enrollment_owner_operations
           where tenant_id = ${fixture.scope.tenantId}::uuid
             and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
           order by created_at, transition_key
        `,
        'objects',
      ),
    )
    .pipe(Effect.orDie);

interface EnrollmentAcceptanceAttemptRow extends Record<string, unknown> {
  readonly revision: number;
  readonly state: string;
}

/** Every fixture reader below dies with this when its `where` finds no row. */
const FIXTURE_ATTEMPT_ROW_MISSING = 'The fixture Attempt row is missing';

/** The durable Attempt row itself, read with the owner role so RLS cannot mask a regression. */
export const readEnrollmentAcceptanceAttempt = (
  fixture: EnrollmentAcceptanceFixture,
  portalEnrollmentAttemptId: string,
): Effect.Effect<EnrollmentAcceptanceAttemptRow> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute<EnrollmentAcceptanceAttemptRow>(
        sql`
          select state, revision
            from commerce_customer_context.portal_enrollment_attempts
           where tenant_id = ${fixture.scope.tenantId}::uuid
             and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(
      Effect.flatMap((rows) => {
        const [row] = rows;
        return row === undefined ? Effect.die(FIXTURE_ATTEMPT_ROW_MISSING) : Effect.succeed(row);
      }),
      Effect.orDie,
    );

interface EnrollmentAcceptanceSweepRow extends Record<string, unknown> {
  readonly sweep_count: number;
}

/**
 * The durable sweep budget one Attempt has actually been charged, read with the owner role. A test
 * of the claim needs the charge itself: an answer of "one replica won" says nothing about whether
 * the losers were charged on their way out.
 */
export const readEnrollmentAcceptanceSweepCount = (
  fixture: EnrollmentAcceptanceFixture,
  portalEnrollmentAttemptId: string,
): Effect.Effect<number> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute<EnrollmentAcceptanceSweepRow>(
        sql`
          select sweep_count
            from commerce_customer_context.portal_enrollment_attempts
           where tenant_id = ${fixture.scope.tenantId}::uuid
             and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(
      Effect.flatMap((rows) => {
        const [row] = rows;
        return row === undefined ? Effect.die(FIXTURE_ATTEMPT_ROW_MISSING) : Effect.succeed(row.sweep_count);
      }),
      Effect.orDie,
    );

interface EnrollmentAcceptanceSweepClaimRow extends Record<string, unknown> {
  readonly remaining_millis: number;
}

/**
 * How far `sweep_claimed_until` still sits ahead of the database's own clock, computed inside the
 * same statement so a test asserting a claim's back-off never chases this process's clock skew.
 */
export const readEnrollmentAcceptanceSweepClaimRemainingMillis = (
  fixture: EnrollmentAcceptanceFixture,
  portalEnrollmentAttemptId: string,
): Effect.Effect<number> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute<EnrollmentAcceptanceSweepClaimRow>(
        sql`
          select (extract(epoch from (sweep_claimed_until - statement_timestamp())) * 1000)::float8 as remaining_millis
            from commerce_customer_context.portal_enrollment_attempts
           where tenant_id = ${fixture.scope.tenantId}::uuid
             and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(
      Effect.flatMap((rows) => {
        const [row] = rows;
        return row === undefined ? Effect.die(FIXTURE_ATTEMPT_ROW_MISSING) : Effect.succeed(row.remaining_millis);
      }),
      Effect.orDie,
    );

/**
 * Moves an Attempt's sweep claim into the past. The claim expires against the database's own clock,
 * which a test cannot advance, so the one fact under test — "this claim is no longer live" — is
 * stated directly instead of waited for, exactly as `backdateEnrollmentAcceptanceAttempt` states
 * the activity order.
 */
export const expireEnrollmentAcceptanceSweepClaim = (
  fixture: EnrollmentAcceptanceFixture,
  portalEnrollmentAttemptId: string,
): Effect.Effect<void> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute(
        sql`
          update commerce_customer_context.portal_enrollment_attempts
             set sweep_claimed_until = statement_timestamp() - interval '1 second'
           where tenant_id = ${fixture.scope.tenantId}::uuid
             and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(Effect.asVoid, Effect.orDie);

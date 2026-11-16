import { findPostgresFailure, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import type { PaymentTermDefinitionSnapshot } from '@app/payment-term-catalog-contracts/payment-term';
import { PaymentTermDefinitionSnapshotSchema } from '@app/payment-term-catalog-contracts/payment-term';
import type { PgClient } from '@effect/sql-pg';
import { randomUUID } from 'node:crypto';

import { Duration, Effect, Option, Predicate, Result, Schedule, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect } from 'effect-rstest';

import type { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { PaymentPurchasingContext } from '../../shared/domain/applicability-purchasing-context.ts';
import type { PaymentExecutionProvenance } from '../../shared/domain/payment-provenance.ts';
import { paymentAggregatePersistenceForTransaction } from '../../src/persistence/payment-aggregate-persistence.ts';
import type {
  NewPaymentInput,
  NewPaymentOperationInput,
  PaymentAggregatePersistence,
} from '../../src/persistence/payment-aggregate-persistence.ts';

/**
 * Native PostgreSQL support for the Payment database tests. Every test uses fresh random Tenant and
 * Selling Legal Entity identities against the worktree database; append-only ledgers are never
 * deleted, so isolation comes from scope, not cleanup.
 */
export type PaymentTestDatabase = TestDatabaseFromClient<typeof coreRelations>;
type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

export const randomUuid = Effect.sync(() => randomUUID());

export interface PaymentTestScope {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export const makeTestScope = Effect.gen(function* makeTestScope() {
  const [legalEntityId, principalId, tenantId] = yield* Effect.all([randomUuid, randomUuid, randomUuid], {
    concurrency: 1,
  });
  return { legalEntityId, principalId, tenantId } satisfies PaymentTestScope;
});

export const operationalScopeOf = (scope: PaymentTestScope): OperationalScope => ({
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: scope.principalId,
    authContextRef: 'session:payment-database-tests',
    authMethod: 'session',
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    tenantId: scope.tenantId,
  }),
  correlationId: 'payment-database-tests',
});

/** Runs owner persistence inside one Core-scoped runtime transaction, exactly as Actions receive it. */
export const withPersistence = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (persistence: PaymentAggregatePersistence) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PaymentTestTransaction) =>
    Effect.gen(function* scopedPaymentPersistence() {
      const scoped = yield* installOperationalScope(transaction, operationalScopeOf(scope));
      return yield* operation(paymentAggregatePersistenceForTransaction(scoped));
    }),
  );

/** Raw SQL under the session-setting scope of the shared runtime role, in one transaction. */
export const inScope = <A, E, R>(
  client: PgClient.PgClient,
  scope: PaymentTestScope,
  operation: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* scopedSql() {
    yield* client.unsafe("select set_config('ontos.tenant_id',$1,true),set_config('ontos.legal_entity_id',$2,true)", [
      scope.tenantId,
      scope.legalEntityId,
    ]);
    return yield* operation;
  }).pipe(client.withTransaction);

/** Asserts that PostgreSQL itself refused the statement with the expected SQLSTATE (and constraint). */
export const expectSqlFailure = <A, E, R>(operation: Effect.Effect<A, E, R>, code: string, constraint?: string) =>
  Effect.gen(function* assertNativeRejection() {
    const result = yield* Effect.result(operation);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      const metadata = findPostgresFailure(result.failure);
      expect(Option.isSome(metadata)).toBe(true);
      if (Option.isSome(metadata)) {
        expect(metadata.value.code).toBe(code);
        if (constraint !== undefined) {
          expect(metadata.value.constraint).toBe(constraint);
        }
      }
    }
  });

export const COMPOSITION_REVISION = 'c'.repeat(64);

export const provenanceFor = (scope: PaymentTestScope) =>
  randomUuid.pipe(
    Effect.map((actionInvocationId): PaymentExecutionProvenance => ({
      actionInvocationId,
      actorPrincipalId: scope.principalId,
      compositionRevision: COMPOSITION_REVISION,
    })),
  );

const termSnapshotFor = (tenantId: string, resourceId: string): PaymentTermDefinitionSnapshot =>
  Schema.decodeSync(PaymentTermDefinitionSnapshotSchema)({
    code: 'IMMEDIATE',
    compatibilityId: 'immediate.v2',
    definitionRevisionId: '55555555-5555-4555-8555-555555555555',
    lifecycle: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, state: 'ACTIVE' },
    metadataRevision: 1,
    name: 'Immediate',
    paymentTermRef: {
      moduleId: 'payment.term-catalog',
      resourceId,
      resourceType: 'payment.term-catalog.payment-term',
      tenantId,
    },
    semanticFingerprint: 'f'.repeat(64),
    semanticRevisionId: '66666666-6666-4666-8666-666666666666',
    semantics: { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
  });

/** The trusted Commerce Purchasing Context of one purchase: a Retail Customer profile of this Tenant. */
export const purchasingContextFor = (scope: PaymentTestScope, purchaseRef: string): PaymentPurchasingContext => ({
  channelId: 'web-cz',
  contextRef: `purchasing-context-${purchaseRef}`,
  contextRevision: '1',
  marketId: 'market-cz',
  subject: {
    kind: 'PROFILE',
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: `retail-customer-${purchaseRef}`,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: scope.tenantId,
    },
  },
});

export const newPaymentInput = Effect.fn('PaymentDatabaseFixture.newPaymentInput')(function* newPaymentInput(
  scope: PaymentTestScope,
  amountMinor = 100_000,
) {
  const [intentKey, termId, provenance] = yield* Effect.all([randomUuid, randomUuid, provenanceFor(scope)], {
    concurrency: 1,
  });
  const termSemanticEvidence = termSnapshotFor(scope.tenantId, termId);
  return {
    amount: { amountMinor, currency: 'CZK' },
    customerConfigurationId: 'customer-configuration-1',
    executionBinding: {
      _tag: 'GATEWAY_ACCOUNT',
      environment: 'production',
      providerAccountRef: 'gopay-account-1',
      providerFamily: 'GOPAY',
    },
    intentKey: `intent-${intentKey}`,
    method: 'ONLINE_GATEWAY',
    paymentTermRef: termSemanticEvidence.paymentTermRef,
    provenance,
    purchaseCorrelationId: `purchase-${intentKey}`,
    purchasingContext: purchasingContextFor(scope, intentKey),
    termSemanticEvidence,
  } satisfies NewPaymentInput;
});

export const collectInput = Effect.fn('PaymentDatabaseFixture.collectInput')(function* collectInput(
  scope: PaymentTestScope,
  payment: { readonly amountMinor: number; readonly paymentId: string },
  operationKey: string,
) {
  const provenance = yield* provenanceFor(scope);
  return {
    amount: { amountMinor: payment.amountMinor, currency: 'CZK' },
    binding: {
      _tag: 'GATEWAY_ACCOUNT',
      environment: 'production',
      providerAccountRef: 'gopay-account-1',
      providerFamily: 'GOPAY',
    },
    initialOutcome: 'PENDING',
    kind: 'COLLECT',
    materialRequest: { amountMinor: payment.amountMinor, currency: 'CZK', kind: 'COLLECT' },
    operationKey,
    paymentId: payment.paymentId,
    provenance,
  } satisfies NewPaymentOperationInput;
});

/** The typed failure code of a refused Payment operation (`unknown` for an untyped failure). */
export const failureCodeOf = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  Effect.flip(operation).pipe(
    Effect.map((failure) => (Predicate.hasProperty(failure, 'code') ? failure.code : 'unknown')),
  );

/** The lock wait one race needs PostgreSQL to publish before the holder may release. */
export interface QueuedLockWaiters {
  /** How many backends must be queued behind the holder. */
  readonly expected: number;
  /** The backend holding the lock, read as `select pg_backend_pid()` inside its own transaction. */
  readonly holderPid: number;
  /** Optional `ilike` pattern on the queued statement, for holders whose chain carries other waiters. */
  readonly statementLike?: string;
}

/**
 * PostgreSQL publishes a lock wait in `pg_blocking_pids` only once the waiting backend has registered
 * it, which no number of round trips bounds. The wait therefore runs on the live clock against a real
 * deadline: a loaded runner no longer turns a correct lock into a failed assertion, and a lock that
 * never materializes fails loudly instead of returning a count the caller then asserts on.
 */
const LOCK_WAIT_POLL = Schedule.spaced(Duration.millis(20));
const LOCK_WAIT_DEADLINE = Duration.seconds(30);

/**
 * Waits until PostgreSQL itself reports `expected` backends queued (directly or transitively) behind
 * `holderPid` and answers with the observed count. Queued row-lock waiters form a chain: a later
 * waiter is blocked by an earlier one, never by the holder directly, so the chain is walked.
 */
export const awaitQueuedLockWaiters = (admin: PgClient.PgClient, waiters: QueuedLockWaiters) =>
  Effect.gen(function* observeQueuedLockWaiters() {
    const rows = yield* admin.unsafe<{ readonly waiting: number }>(
      `with recursive blocked(pid) as (
         select activity.pid from pg_catalog.pg_stat_activity as activity
         where $1::integer = any(pg_catalog.pg_blocking_pids(activity.pid))
         union
         select activity.pid from pg_catalog.pg_stat_activity as activity
         join blocked on blocked.pid = any(pg_catalog.pg_blocking_pids(activity.pid))
       )
       select count(*)::integer as waiting
       from blocked
       join pg_catalog.pg_stat_activity as waiter on waiter.pid = blocked.pid
       where $2::text is null or waiter.query ilike $2::text`,
      [waiters.holderPid, waiters.statementLike ?? null],
    );
    const waiting = rows[0]?.waiting ?? 0;
    return waiting >= waiters.expected ? waiting : yield* Effect.fail('payment_lock_wait_unregistered' as const);
  }).pipe(
    Effect.retry(LOCK_WAIT_POLL),
    Effect.timeoutOrElse({
      duration: LOCK_WAIT_DEADLINE,
      orElse: () =>
        Effect.die(
          `PostgreSQL never queued ${waiters.expected} backend(s) behind backend ${waiters.holderPid} within 30 seconds`,
        ),
    }),
    TestClock.withLive,
  );

export { coreRelations as paymentTestRelations } from '../../../../packages/core-runtime/src/db/schema.ts';

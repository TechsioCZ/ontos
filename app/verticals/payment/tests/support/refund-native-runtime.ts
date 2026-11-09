import { and, eq, sql } from 'drizzle-orm';
import type { ActionRuntimeService } from '@app/core-runtime';
import type { PgClient } from '@effect/sql-pg';
import { DateTime, Deferred, Effect, Schema } from 'effect';

import {
  accessScopeFences,
  accessScopes,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import { PaymentOperationIdSchema } from '../../shared/domain/payment-identifiers.ts';
import type {
  PaymentMethod,
  PaymentOperationOutcome,
  PaymentSourceFactFamily,
  PaymentSourceKind,
} from '../../shared/domain/payment-vocabulary.ts';
import { observations, reconciliationCases, sourceAuthorities } from '../../src/database/schema.ts';
import { paymentAggregatePersistenceForTransaction } from '../../src/persistence/payment-aggregate-persistence.ts';
import {
  COMPOSITION_REVISION,
  collectInput,
  newPaymentInput,
  operationalScopeOf,
  provenanceFor,
  randomUuid,
} from '../integration/database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from '../integration/database-fixture.ts';

/**
 * Native PostgreSQL harness of the refund lane (#1150): the real registered Payment Actions run
 * through the Core Action runtime (invocation ledger, scoped transaction, RLS, outbox collector)
 * against the worktree database. Authorization and composition are opened explicitly because they
 * are owned by Core suites; Module State denial is proven separately through the Core gate.
 */

/** Core Action permission opened for the owner suites; authorization has its own Core suites. */
export const refundRuntimePermission = {
  checkActionPermission: () => Effect.succeed('allowed' as const),
};

/** Tenant, Legal Entity, module, resource and owner-permission access opened for the owner suites. */
export const refundRuntimeContextAccess: ContextAccessService = {
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  ownerPermissions: (input) =>
    Effect.succeed(input.targets.map((target) => ({ decision: 'allowed' as const, key: target.target.key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};

/** The second compatible Composition revision R2 used for late evidence after a runtime release. */
export const LATER_COMPOSITION_REVISION = 'b'.repeat(64);

/**
 * The real Core Action runtime over the worktree database, built by each suite from
 * `refundRuntimePermission` / `refundRuntimeContextAccess` and the registered Payment owner.
 */
export interface RefundNativeRuntime {
  readonly actionRuntime: ActionRuntimeService;
  readonly admin: PgClient.PgClient;
  readonly coreAdmin: PaymentTestDatabase;
  readonly database: PaymentTestDatabase;
}

/** Seeds the Core identity of one acting principal in a fresh Tenant; rows stay under that random Tenant. */
export const seedRefundActor = Effect.fn('RefundNativeRuntime.seedActor')(function* seedRefundActor(
  native: RefundNativeRuntime,
  scope: PaymentTestScope,
) {
  const [authBindingId, accessScopeId, companyScopeId] = yield* Effect.all([randomUuid, randomUuid, randomUuid], {
    concurrency: 1,
  });
  const authenticationNamespaceId = 'test.payment-refund.v1';
  yield* native.coreAdmin.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Payment refund acceptance',
    slug: `payment-refund-${scope.tenantId}`,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* native.coreAdmin.insert(legalEntities).values({
    legalEntityId: scope.legalEntityId,
    legalName: 'Payment refund seller',
    registrationCountry: 'CZ',
    registrationNumber: `refund-${scope.legalEntityId}`,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* native.coreAdmin.insert(accessScopes).values({
    scopeId: accessScopeId,
    tenantContextId: scope.tenantId,
    tenantId: scope.tenantId,
  });
  // The runner pins the Selling Legal Entity's own access scope fence; both scopes start Ready.
  yield* native.coreAdmin.insert(accessScopes).values({
    legalEntityId: scope.legalEntityId,
    scopeId: companyScopeId,
    tenantId: scope.tenantId,
  });
  yield* native.coreAdmin.insert(accessScopeFences).values([
    { revision: 1, scopeId: accessScopeId, state: 'Ready', tenantId: scope.tenantId },
    { revision: 1, scopeId: companyScopeId, state: 'Ready', tenantId: scope.tenantId },
  ]);
  yield* native.coreAdmin.insert(principals).values({
    displayName: 'Payment refund operator',
    kind: 'human',
    principalId: scope.principalId,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* native.coreAdmin.insert(principalAuthBindings).values({
    authenticationNamespaceId,
    principalAuthBindingId: authBindingId,
    principalId: scope.principalId,
    provider: 'better_auth',
    providerSubjectId: `payment-refund-${scope.principalId}`,
    status: 'active',
    subjectType: 'user',
    tenantId: scope.tenantId,
  });
  return {
    authBindingId,
    authContextRef: `better-auth-session:${authBindingId}`,
    authenticationNamespaceId,
    authMethod: 'session' as const,
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    tenantId: scope.tenantId,
  };
});

/** Foundation owner persistence inside one Core-scoped transaction, exactly as Actions receive it. */
const withScopedTransaction = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (transaction: Effect.Success<ReturnType<typeof installOperationalScope>>) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope)).pipe(Effect.flatMap(operation)),
  );

export const GATEWAY_BINDING: PaymentExecutionBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'gopay-account-1',
  providerFamily: 'GOPAY',
};

export interface SeedPaymentOptions {
  readonly amountMinor: number;
  readonly binding?: PaymentExecutionBinding;
  /** Prove the collection (EFFECT_CONFIRMED) instead of leaving it PENDING. */
  readonly collected: boolean;
  readonly method?: PaymentMethod;
}

export interface QualifiedOutcomeInput {
  readonly compositionRevision?: string;
  readonly operationId: string;
  readonly paymentId: string;
  readonly to: PaymentOperationOutcome;
}

/**
 * Applies one qualified outcome change with the foundation primitive under a chosen Composition
 * revision. It stands in for the evidence lanes' acceptance Actions (#1151/#1152).
 */
export const transitionOperation = Effect.fn('RefundNativeRuntime.transitionOperation')(function* transitionOperation(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  input: QualifiedOutcomeInput,
) {
  const provenance = yield* provenanceFor(scope);
  return yield* withScopedTransaction(database, scope, (transaction) =>
    Effect.gen(function* applyQualifiedOutcome() {
      const persistence = paymentAggregatePersistenceForTransaction(transaction);
      const aggregate = yield* persistence.loadAggregate(input.paymentId, { lock: true });
      const current = aggregate.operations.find((operation) => operation.operationId === input.operationId);
      return yield* persistence.transitionOperationOutcome({
        causedBy: { kind: 'OBSERVATION' },
        expectedOutcomeRevision: current?.outcomeRevision ?? 0,
        operationId: input.operationId,
        paymentId: input.paymentId,
        provenance: { ...provenance, compositionRevision: input.compositionRevision ?? COMPOSITION_REVISION },
        to: input.to,
      });
    }),
  );
});

/**
 * A Payment with one COLLECT, created with the foundation owner primitives. Collection proof stands
 * in for qualified evidence accepted by the evidence lanes; refunds themselves always run through
 * the registered Action.
 */
export const seedPayment = Effect.fn('RefundNativeRuntime.seedPayment')(function* seedPayment(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  options: SeedPaymentOptions,
) {
  const base = yield* newPaymentInput(scope, options.amountMinor);
  const binding = options.binding ?? GATEWAY_BINDING;
  const created = yield* withScopedTransaction(database, scope, (transaction) =>
    paymentAggregatePersistenceForTransaction(transaction).insertPayment({
      ...base,
      executionBinding: binding,
      method: options.method ?? 'ONLINE_GATEWAY',
    }),
  );
  const { paymentId } = created.record;
  const collect = yield* collectInput(scope, { amountMinor: options.amountMinor, paymentId }, `collect-${paymentId}`);
  const collected = yield* withScopedTransaction(database, scope, (transaction) =>
    paymentAggregatePersistenceForTransaction(transaction).insertOperation({ ...collect, binding }),
  );
  const collectOperationId = collected.record.operationId;
  if (options.collected) {
    yield* transitionOperation(database, scope, { operationId: collectOperationId, paymentId, to: 'EFFECT_CONFIRMED' });
  }
  return { collectOperationId, paymentId, purchaseCorrelationId: base.purchaseCorrelationId };
});

export const loadPaymentAggregate = (database: PaymentTestDatabase, scope: PaymentTestScope, paymentId: string) =>
  withScopedTransaction(database, scope, (transaction) =>
    paymentAggregatePersistenceForTransaction(transaction).loadAggregate(paymentId),
  );

export interface SourceAuthorityOptions {
  readonly accountRef: string;
  readonly environment?: string;
  readonly factFamily?: PaymentSourceFactFamily;
  readonly method?: PaymentMethod;
  readonly refundRoute?: boolean;
  readonly sourceKind: PaymentSourceKind;
  readonly sourceSystem: string;
  readonly status?: 'ACTIVE' | 'REVOKED';
}

/** A configured source authority, as the source-authority Action would persist it (#1152). */
export const seedSourceAuthority = Effect.fn('RefundNativeRuntime.seedSourceAuthority')(function* seedSourceAuthority(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  options: SourceAuthorityOptions,
) {
  const provenance = yield* provenanceFor(scope);
  const configuredAt = DateTime.toDateUtc(yield* DateTime.now);
  const rows = yield* withScopedTransaction(database, scope, (transaction) =>
    transaction
      .insert(sourceAuthorities)
      .values({
        accountRef: options.accountRef,
        actionInvocationId: provenance.actionInvocationId,
        actorPrincipalId: provenance.actorPrincipalId,
        compositionRevision: provenance.compositionRevision,
        configuredAt,
        environment: options.environment ?? 'production',
        factFamily: options.factFamily ?? 'REFUND_EXECUTION',
        legalEntityId: scope.legalEntityId,
        method: options.method ?? null,
        reason: 'Configured for the refund acceptance suite',
        refundRoute: options.refundRoute ?? true,
        revision: 1,
        sourceKind: options.sourceKind,
        sourceSystem: options.sourceSystem,
        status: options.status ?? 'ACTIVE',
        tenantId: scope.tenantId,
      })
      .returning({ sourceAuthorityId: sourceAuthorities.sourceAuthorityId }),
  );
  return rows.map((row) => row.sourceAuthorityId).join('');
});

/** The exact original gateway account configured as its refund execution authority. */
export const seedGatewayRefundRoute = (database: PaymentTestDatabase, scope: PaymentTestScope) =>
  seedSourceAuthority(database, scope, {
    accountRef: 'gopay-account-1',
    method: 'ONLINE_GATEWAY',
    sourceKind: 'PAYMENT_GATEWAY',
    sourceSystem: 'GOPAY',
  });

/** Held, ambiguous evidence about the Payment's funds awaiting governed reconciliation (#1151). */
export const openAmbiguousFundsCase = Effect.fn('RefundNativeRuntime.openAmbiguousFundsCase')(
  function* openAmbiguousFundsCase(database: PaymentTestDatabase, scope: PaymentTestScope, paymentId: string) {
    const provenance = yield* provenanceFor(scope);
    const openedAt = DateTime.toDateUtc(yield* DateTime.now);
    yield* withScopedTransaction(database, scope, (transaction) =>
      transaction.insert(reconciliationCases).values({
        actionInvocationId: provenance.actionInvocationId,
        actorPrincipalId: provenance.actorPrincipalId,
        caseKind: 'AMBIGUOUS_FUNDS',
        compositionRevision: provenance.compositionRevision,
        legalEntityId: scope.legalEntityId,
        openedAt,
        paymentId,
        revision: 1,
        status: 'OPEN',
        tenantId: scope.tenantId,
      }),
    );
  },
);

export interface CollectionCorrectionInput {
  readonly amountMinor: number;
  readonly collectOperationId: string;
  readonly paymentId: string;
}

/**
 * An accepted qualified SOURCE_CORRECTION against the collection: the bank/accounting source says
 * part of the earlier receipt report was erroneous (#1152). It is not a return of money.
 */
export const acceptCollectionCorrection = Effect.fn('RefundNativeRuntime.acceptCollectionCorrection')(
  function* acceptCollectionCorrection(
    database: PaymentTestDatabase,
    scope: PaymentTestScope,
    input: CollectionCorrectionInput,
  ) {
    const sourceAuthorityId = yield* seedSourceAuthority(database, scope, {
      accountRef: 'receipt-account-1',
      factFamily: 'BANK_ACCOUNTING_RECEIPT',
      refundRoute: false,
      sourceKind: 'BANK_ACCOUNTING',
      sourceSystem: 'erp-primary',
    });
    const provenance = yield* provenanceFor(scope);
    const now = DateTime.toDateUtc(yield* DateTime.now);
    yield* withScopedTransaction(database, scope, (transaction) =>
      transaction.insert(observations).values({
        acceptanceOutcome: 'ACCEPTED_OBSERVATION',
        accountRef: 'receipt-account-1',
        actionInvocationId: provenance.actionInvocationId,
        actorPrincipalId: provenance.actorPrincipalId,
        amountMinor: input.amountMinor,
        compositionRevision: provenance.compositionRevision,
        // A partial disproof of the established receipt: the only correction that reduces coverage.
        correctionEffect: 'REDUCE_ESTABLISHED_COLLECTION',
        currency: 'CZK',
        environment: 'production',
        factFamily: 'BANK_ACCOUNTING_RECEIPT',
        factKind: 'SOURCE_CORRECTION',
        legalEntityId: scope.legalEntityId,
        operationId: input.collectOperationId,
        paymentId: input.paymentId,
        receivedAt: now,
        sourceAuthorityId,
        sourceAuthorityRevision: 1,
        sourceKind: 'BANK_ACCOUNTING',
        sourceOccurrenceId: `correction-${input.paymentId}`,
        sourceRevision: 1,
        sourceSystem: 'erp-primary',
        tenantId: scope.tenantId,
        verifiedAt: now,
      }),
    );
  },
);

const OperationRequestedReferenceSchema = Schema.Struct({ operationId: PaymentOperationIdSchema });

/** Durable `payment.core.operation-requested.v1` Outbox rows written for one operation. */
export const operationRequestedMessages = Effect.fn('RefundNativeRuntime.operationRequestedMessages')(
  function* operationRequestedMessages(native: RefundNativeRuntime, scope: PaymentTestScope, operationId: string) {
    const rows = yield* native.coreAdmin
      .select({ payloadJson: outboxMessages.payloadJson, producerModuleKey: outboxMessages.producerModuleKey })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.tenantId, scope.tenantId),
          eq(outboxMessages.topic, 'payment.core.operation-requested.v1'),
        ),
      );
    return rows.filter(
      (row) =>
        Schema.is(OperationRequestedReferenceSchema)(row.payloadJson) && row.payloadJson.operationId === operationId,
    );
  },
);

/**
 * Holds the Payment row lock in its own transaction until `release` completes and publishes the
 * holder's backend id, so concurrent Action executions can be proven to queue on the owner boundary.
 */
export const holdPaymentRowLock = (
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  paymentId: string,
  gates: { readonly locked: Deferred.Deferred<number>; readonly release: Deferred.Deferred<boolean> },
) =>
  database.transaction((transaction) =>
    Effect.gen(function* holdLock() {
      const scoped = yield* installOperationalScope(transaction, operationalScopeOf(scope));
      yield* paymentAggregatePersistenceForTransaction(scoped).lockPayment(paymentId);
      const [holder] = yield* transaction.execute<{ readonly pid: number }>(
        sql`select pg_catalog.pg_backend_pid() as pid`,
        'objects',
      );
      yield* Deferred.succeed(gates.locked, holder?.pid ?? 0);
      yield* Deferred.await(gates.release);
    }),
  );

/** Waits until PostgreSQL reports `expected` backends queued behind the lock holder (bounded polling). */
export const awaitBlockedLockWaiters = Effect.fn('RefundNativeRuntime.awaitBlockedLockWaiters')(
  function* awaitBlockedLockWaiters(native: RefundNativeRuntime, holderPid: number, expected: number) {
    const blockedByHolder = native.admin
      .unsafe<{ readonly waiting: number }>(
        // Queued row-lock waiters form a chain: later waiters are blocked by earlier ones.
        `with recursive blocked(pid) as (
           select activity.pid from pg_catalog.pg_stat_activity as activity
           where $1::integer = any(pg_catalog.pg_blocking_pids(activity.pid))
           union
           select activity.pid from pg_catalog.pg_stat_activity as activity
           join blocked on blocked.pid = any(pg_catalog.pg_blocking_pids(activity.pid))
         )
         select count(*)::integer as waiting from blocked`,
        [holderPid],
      )
      .pipe(Effect.map((rows) => rows[0]?.waiting ?? 0));
    let waiting = 0;
    for (let check = 0; check < 5000 && waiting < expected; check += 1) {
      waiting = yield* blockedByHolder;
    }
    return waiting;
  },
);

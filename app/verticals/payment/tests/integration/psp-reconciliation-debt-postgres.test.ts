import type { ScopedTransactionExecutor } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import type { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import {
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
} from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
} from '../../shared/domain/psp-configuration.ts';
import { ProviderDispatchLedgerLive } from '../../src/integrations/psp/dispatch-ledger-live.ts';
import { ProviderDispatchLedger } from '../../src/integrations/psp/dispatch-ledger.ts';
import type {
  ProviderDispatchIdentity,
  ProviderDispatchLedgerContract,
} from '../../src/integrations/psp/dispatch-ledger.ts';
import { ProviderEvidenceStoreLive } from '../../src/integrations/psp/evidence-store-live.ts';
import { ProviderEvidenceStore } from '../../src/integrations/psp/evidence-store.ts';
import type { ProviderEvidenceStoreContract } from '../../src/integrations/psp/evidence-store.ts';
import { ProviderNotificationStoreLive } from '../../src/integrations/psp/notification-store-live.ts';
import {
  ProviderNotificationIdSchema,
  ProviderNotificationStore,
} from '../../src/integrations/psp/notification-store.ts';
import type { ProviderNotificationStoreContract } from '../../src/integrations/psp/notification-store.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayExecutionTargetSchema, ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import { PreparedProviderRequestSchema, ProviderEvidenceSchema } from '../../src/integrations/psp/psp-result.ts';
import { pspDispatchReadPersistenceForTransaction } from '../../src/persistence/psp-dispatch-read-persistence.ts';
import {
  COMPOSITION_REVISION,
  collectInput,
  inScope,
  makeTestScope,
  newPaymentInput,
  operationalScopeOf,
  paymentTestRelations,
  randomUuid,
  withPersistence,
} from './database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from './database-fixture.ts';

/**
 * Gateway reconciliation debt Read (#1158): the same ledger rows the driver lists, built through the live
 * ledger and stores in their worker deliveries. No provider is called.
 */

type Family = typeof PaymentGatewayProviderFamilySchema.Type;
type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

const WORKER_KEY = 'payment.core.execute-gateway-operation';
const NOTIFICATION_URL = 'https://hooks.example.test/psp';
const RESPONDED_AT = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');

const MERCHANT_IDENTITY_DOCUMENTS = {
  COMGATE: '{"_tag":"COMGATE","merchantId":"123456"}',
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<Family, string>;
const MERCHANT_IDENTITIES = {
  COMGATE: { _tag: 'COMGATE', merchantId: '123456' },
  GOPAY: { _tag: 'GOPAY', goid: '8123456789' },
  STRIPE: { _tag: 'STRIPE', accountId: 'acct_1TestAccount' },
} as const;

const storesLayer = Layer.mergeAll(
  ProviderDispatchLedgerLive,
  ProviderEvidenceStoreLive,
  ProviderNotificationStoreLive,
);

const NO_COMPLETION: OutboxWorkerLegalEntityScope['completionPublisher'] = {
  publish: () => Effect.die('The ledger publishes no completion'),
};

interface WorkerCall {
  readonly evidence: ProviderEvidenceStoreContract;
  readonly ledger: ProviderDispatchLedgerContract;
  readonly notifications: ProviderNotificationStoreContract;
  readonly scope: OutboxWorkerLegalEntityScope;
  readonly workerContext: OutboxWorkerHandlerContext;
}

const deliveryOf = (scope: PaymentTestScope) =>
  Effect.all([randomUuid, randomUuid, randomUuid], { concurrency: 1 }).pipe(
    Effect.map(([deliveryId, invocationId, messageId]): OutboxWorkerHandlerContext => ({
      attemptNumber: 1,
      claimId: messageId,
      compositionRevision: COMPOSITION_REVISION,
      deliveryId,
      domainEventId: messageId,
      messageId,
      originatorInvocationId: invocationId,
      producerModuleKey: 'payment.core',
      tenantId: scope.tenantId,
      tenantSequenceNo: 1n,
      topic: 'payment.core.operation-requested.v1',
      workerKey: WORKER_KEY,
    })),
  );

/** One worker delivery in its own Core-scoped runtime transaction. */
const inWorker = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  call: (worker: WorkerCall) => Effect.Effect<Value, Failure>,
) =>
  Effect.gen(function* workerCall() {
    const [workerContext, ledger, evidence, notifications] = yield* Effect.all(
      [
        deliveryOf(scope),
        Effect.service(ProviderDispatchLedger),
        Effect.service(ProviderEvidenceStore),
        Effect.service(ProviderNotificationStore),
      ],
      { concurrency: 1 },
    );
    return yield* database.transaction((transaction: PaymentTestTransaction) =>
      installOperationalScope(transaction, operationalScopeOf(scope)).pipe(
        Effect.flatMap((invoker) =>
          call({
            evidence,
            ledger,
            notifications,
            scope: {
              completionPublisher: NO_COMPLETION,
              legalEntityId: scope.legalEntityId,
              routineInvoker: invoker,
              tenantId: scope.tenantId,
            },
            workerContext,
          }),
        ),
      ),
    );
  }).pipe(Effect.provide(storesLayer));

/** One Core-scoped Read transaction. */
const inTransaction = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PaymentTestTransaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope)).pipe(Effect.flatMap(operation)),
  );

const providerRef = (input: typeof ProviderObjectRefSchema.Encoded) =>
  Schema.decodeEffect(ProviderObjectRefSchema)(input);

interface DebtFixture {
  readonly accountRef: GatewayProviderAccountRef;
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly collect: ProviderDispatchIdentity;
  readonly family: Family;
  readonly paymentId: string;
  /** When Payment recorded the COLLECT request. */
  readonly requestedAt: DateTime.Utc;
  readonly scope: PaymentTestScope;
}

const gatewayBindingOf = (family: Family, accountRef: string) =>
  ({
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: accountRef,
    providerFamily: family,
  }) as const;

/** One CURRENT binding with its ACTIVE credential and a Payment with its COLLECT, as the configuration Action writes them. */
const debtFixture = Effect.fn('PspDebtFixture.gateway')(function* debtFixture(
  runtime: PaymentTestDatabase,
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  family: Family,
) {
  const [refSeed, bindingSeed] = yield* Effect.all([randomUuid, randomUuid], { concurrency: 1 });
  const [accountRef, bindingId] = yield* Effect.all(
    [
      Schema.decodeEffect(GatewayProviderAccountRefSchema)(`pab_${refSeed.replaceAll('-', '')}`),
      Schema.decodeEffect(GatewayProviderAccountBindingIdSchema)(bindingSeed),
    ],
    { concurrency: 1 },
  );
  yield* inScope(
    runtimeClient,
    scope,
    Effect.all(
      [
        runtimeClient.unsafe(
          `insert into payment.psp_provider_account_bindings (tenant_id, legal_entity_id, action_invocation_id,
             actor_principal_id, composition_revision, binding_id, configured_at, current_credential_revision,
             environment, merchant_identity, notification_url, provider_account_ref, provider_family, reason, revision, status)
           values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, 'SANDBOX', $6::jsonb, $7, $8, $9,
             'Configure the sandbox gateway account', 1, 'CURRENT')`,
          [
            scope.tenantId,
            scope.legalEntityId,
            scope.principalId,
            COMPOSITION_REVISION,
            bindingId,
            MERCHANT_IDENTITY_DOCUMENTS[family],
            NOTIFICATION_URL,
            accountRef,
            family,
          ],
        ),
        runtimeClient.unsafe(
          `insert into payment.psp_credential_revisions (tenant_id, legal_entity_id, action_invocation_id,
             actor_principal_id, composition_revision, binding_id, recorded_at, revision, secret_ref, status)
           values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, 'sandbox-credential-1', 'ACTIVE')`,
          [scope.tenantId, scope.legalEntityId, scope.principalId, COMPOSITION_REVISION, bindingId],
        ),
      ],
      { concurrency: 1 },
    ),
  );
  const executionBinding = gatewayBindingOf(family, accountRef);
  const paymentInput = yield* newPaymentInput(scope);
  const created = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertPayment({ ...paymentInput, executionBinding }),
  );
  const { paymentId } = created.record;
  const collectRequest = yield* collectInput(scope, { amountMinor: 100_000, paymentId }, 'collect-1');
  const collected = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertOperation({ ...collectRequest, binding: executionBinding }),
  );
  const target = yield* Schema.decodeUnknownEffect(GatewayExecutionTargetSchema)({
    binding: executionBinding,
    bindingId,
    credentialRevision: 1,
    credentialSecretRef: 'sandbox-credential-1',
    legalEntityId: scope.legalEntityId,
    merchantIdentity: MERCHANT_IDENTITIES[family],
    notificationUrl: NOTIFICATION_URL,
    returnUrl: Option.none(),
    tenantId: scope.tenantId,
  });
  const collect: ProviderDispatchIdentity = {
    materialHash: collected.record.materialHash,
    operationId: collected.record.operationId,
    operationKind: 'COLLECT',
    paymentId,
    target,
    targetOperationId: Option.none(),
  };
  return {
    accountRef,
    bindingId,
    collect,
    family,
    paymentId,
    requestedAt: collected.record.createdAt,
    scope,
  } satisfies DebtFixture;
});

const preparedFor = (identity: ProviderDispatchIdentity, family: Family) => {
  const { idempotencyKey, orderReference } = deriveProviderCorrelation(identity.operationId);
  const stripe = family === 'STRIPE';
  return Schema.decodeUnknownEffect(PreparedProviderRequestSchema)({
    body: new TextEncoder().encode(`operation=${identity.operationId}&amount=100000`),
    endpointRef: stripe ? 'stripe:POST:/v1/checkout/sessions' : `${family.toLowerCase()}:payment-create`,
    family,
    headers: stripe
      ? [
          { name: 'content-type', value: 'application/x-www-form-urlencoded' },
          { name: 'idempotency-key', value: idempotencyKey },
        ]
      : [{ name: 'content-type', value: 'application/json' }],
    idempotencyKey: stripe ? Option.some(idempotencyKey) : Option.none(),
    orderReference,
    replayWindowMs: stripe ? Option.some(86_400_000) : Option.none(),
    requestHash: 'a'.repeat(64),
  });
};

/** Prepares the COLLECT through the live ledger in its own worker delivery. */
const prepareThroughLedger = (runtime: PaymentTestDatabase, fixture: DebtFixture) =>
  Effect.gen(function* prepareDispatch() {
    const prepared = yield* preparedFor(fixture.collect, fixture.family);
    return yield* inWorker(runtime, fixture.scope, ({ ledger, scope, workerContext }) =>
      ledger.prepare({
        identity: fixture.collect,
        prepared,
        returnToken: Option.none(),
        scope,
        workerContext,
      }),
    );
  });

const acknowledge = (runtime: PaymentTestDatabase, fixture: DebtFixture, providerRefText: ProviderRefInput) =>
  Effect.gen(function* acknowledgeDispatch() {
    const payment = yield* providerRef(providerRefText);
    return yield* inWorker(runtime, fixture.scope, ({ ledger, scope, workerContext }) =>
      ledger.recordAcknowledged({
        customerRedirectUrl: Option.none(),
        operationId: fixture.collect.operationId,
        providerPaymentRef: Option.some(payment),
        providerRefundRef: Option.none(),
        respondedAt: RESPONDED_AT,
        scope,
        workerContext,
      }),
    );
  });

type ProviderRefInput = typeof ProviderObjectRefSchema.Encoded;

/** A notification captured for the fixture's binding, as the capture Action stores it. */
const captureNotification = (
  runtimeClient: PgClient.PgClient,
  fixture: DebtFixture,
  input: { readonly body: string; readonly deliveryIdentity: string; readonly providerRefs: string },
) =>
  inScope(
    runtimeClient,
    fixture.scope,
    runtimeClient.unsafe<{ notification_id: string }>(
      `insert into payment.psp_provider_notifications (tenant_id, legal_entity_id, action_invocation_id,
         actor_principal_id, composition_revision, authenticity, binding_id, delivery_identity, environment, headers,
         provider_account_ref, provider_family, provider_refs, query, raw_body, received_at, state,
         transport_delivery_ref, verified_at, provider_occurrence_id)
       values ($1, $2, gen_random_uuid(), $3, $4, 'SIGNATURE_VERIFIED', $5, $6, 'SANDBOX', '{}'::jsonb, $7, $8,
         $9::jsonb, '{}'::jsonb, convert_to($10, 'UTF8'), '2026-11-12T09:00:00Z', 'CAPTURED', 'relay-delivery-debt',
         '2026-11-12T09:00:01Z', $6)
       returning notification_id`,
      [
        fixture.scope.tenantId,
        fixture.scope.legalEntityId,
        fixture.scope.principalId,
        COMPOSITION_REVISION,
        fixture.bindingId,
        input.deliveryIdentity,
        fixture.accountRef,
        fixture.family,
        input.providerRefs,
        input.body,
      ],
    ),
  ).pipe(Effect.flatMap((rows) => Schema.decodeUnknownEffect(ProviderNotificationIdSchema)(rows[0]?.notification_id)));

/** Appends one signed NOT_EFFECTED statement for the COLLECT; it stays PENDING_SUBMISSION until governed submission. */
const appendPendingNotEffected = (
  runtimeClient: PgClient.PgClient,
  runtime: PaymentTestDatabase,
  fixture: DebtFixture,
  occurrence: string,
) =>
  Effect.gen(function* appendPending() {
    const intent = yield* providerRef({ _tag: 'GOPAY_PAYMENT', id: `gp_${occurrence}` });
    const notificationId = yield* captureNotification(runtimeClient, fixture, {
      body: `{"id":"${occurrence}"}`,
      deliveryIdentity: `gopay:evt:${occurrence}`,
      providerRefs: `[{"_tag":"GOPAY_PAYMENT","id":"gp_${occurrence}"}]`,
    });
    const evidence = yield* Schema.decodeUnknownEffect(ProviderEvidenceSchema)({
      discrepancy: Option.none(),
      economicEffectKey: Option.some(`gp_${occurrence}`),
      factFamily: 'GATEWAY_OUTCOME',
      factKind: 'COLLECTION_NOT_EFFECTED',
      observedAmount: Option.none(),
      observedAt: DateTime.makeUnsafe('2026-11-12T09:00:05.000Z'),
      providerOccurredAt: Option.none(),
      providerRefs: [intent],
      reason: Option.none(),
      sourceOccurrenceId: occurrence,
      sourceRevision: 0,
    });
    return yield* inWorker(runtime, fixture.scope, ({ evidence: store, scope, workerContext }) =>
      store.append({
        bindingId: fixture.bindingId,
        evidence,
        notificationId: Option.some(notificationId),
        operationId: fixture.collect.operationId,
        origin: 'NOTIFICATION_SIGNED',
        paymentId: fixture.paymentId,
        scope,
        workerContext,
      }),
    );
  });

const readDebt = (
  runtime: PaymentTestDatabase,
  scope: PaymentTestScope,
  query: { readonly afterOperationId?: string; readonly limit: number },
) =>
  inTransaction(runtime, scope, (transaction) =>
    pspDispatchReadPersistenceForTransaction(transaction).selectReconciliationDebt({
      afterOperationId: Option.fromUndefinedOr(query.afterOperationId),
      limit: query.limit,
    }),
  );

it.live('#1158 Lost create response appears as reconciliation debt', () =>
  Effect.scoped(
    Effect.gen(function* lostCreateIsDebt() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const lost = yield* debtFixture(runtime, runtimeClient, scope, 'COMGATE');
      const prepared = yield* prepareThroughLedger(runtime, lost);
      expect(Predicate.isTagged(prepared, 'PREPARED')).toBe(true);

      // The create response was lost: the ledger records OUTCOME_UNKNOWN for the operation.
      yield* inWorker(runtime, scope, ({ ledger, scope: worker, workerContext }) =>
        ledger.recordOutcomeUnknown({
          at: RESPONDED_AT,
          operationId: lost.collect.operationId,
          scope: worker,
          workerContext,
        }),
      );

      const page = yield* readDebt(runtime, scope, { limit: 50 });
      expect(
        page.rows.map((row) => ({
          ledgerState: row.ledgerState,
          operationId: row.operationId,
          operationKind: row.operationKind,
          paymentId: row.paymentId,
          pendingEvidenceCount: row.pendingEvidenceCount,
          recommendedTrigger: row.recommendedTrigger,
        })),
      ).toEqual([
        {
          ledgerState: 'OUTCOME_UNKNOWN',
          operationId: lost.collect.operationId,
          operationKind: 'COLLECT',
          paymentId: lost.paymentId,
          pendingEvidenceCount: 0,
          recommendedTrigger: 'EXECUTION_OUTCOME_UNKNOWN',
        },
      ]);
      expect(Option.isNone(page.nextAfterOperationId)).toBe(true);
    }),
  ),
);

it.live('#1158 Pending NOT_EFFECTED evidence appears as debt', () =>
  Effect.scoped(
    Effect.gen(function* pendingEvidenceIsDebt() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* debtFixture(runtime, runtimeClient, scope, 'GOPAY');
      yield* prepareThroughLedger(runtime, fixture);
      yield* acknowledge(runtime, fixture, { _tag: 'GOPAY_PAYMENT', id: 'gp_pending_debt' });
      const stored = yield* appendPendingNotEffected(runtimeClient, runtime, fixture, 'gopay:evt:pending-debt');
      expect(stored.submissionState).toBe('PENDING_SUBMISSION');

      const page = yield* readDebt(runtime, scope, { limit: 50 });
      expect(page.rows.map((row) => [row.operationId, row.ledgerState, row.pendingEvidenceCount])).toEqual([
        [fixture.collect.operationId, 'ACKNOWLEDGED', 1],
      ]);
      const [row] = page.rows;
      // Acknowledged dispatches are not unknown: the evidence is overdue reconciliation, not an unknown outcome.
      expect(row?.recommendedTrigger).toBe('OUTCOME_OVERDUE');
      expect(row !== undefined && DateTime.isDateTime(row.oldestPendingAt)).toBe(true);
    }),
  ),
);

it.live('#1158 An acknowledged collection without a provider outcome becomes overdue debt', () =>
  Effect.scoped(
    Effect.gen(function* acknowledgedOverdueIsDebt() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* debtFixture(runtime, runtimeClient, scope, 'GOPAY');
      yield* prepareThroughLedger(runtime, fixture);
      yield* acknowledge(runtime, fixture, { _tag: 'GOPAY_PAYMENT', id: 'gp_callback_lost' });

      // The customer may still pay: inside the gateway wait budget the collection is no debt.
      expect((yield* readDebt(runtime, scope, { limit: 50 })).rows).toEqual([]);

      // The callback never arrives and no evidence is queued; after the budget the driver must look it up.
      const overdueAt = DateTime.toEpochMillis(fixture.requestedAt) + 86_400_000 + 1000;
      const page = yield* TestClock.setTime(overdueAt).pipe(
        Effect.andThen(readDebt(runtime, scope, { limit: 50 })),
        Effect.provide(TestClock.layer()),
      );
      expect(
        page.rows.map((row) => ({
          hasPendingEvidence: Object.hasOwn(row, 'oldestPendingAt'),
          ledgerState: row.ledgerState,
          operationId: row.operationId,
          pendingEvidenceCount: row.pendingEvidenceCount,
          recommendedTrigger: row.recommendedTrigger,
        })),
      ).toEqual([
        {
          hasPendingEvidence: false,
          ledgerState: 'ACKNOWLEDGED',
          operationId: fixture.collect.operationId,
          pendingEvidenceCount: 0,
          recommendedTrigger: 'OUTCOME_OVERDUE',
        },
      ]);
    }),
  ),
);

it.live('#1158 Gateway reconciliation debt is isolated per Selling Legal Entity', () =>
  Effect.scoped(
    Effect.gen(function* debtIsolation() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const [scope, otherScope] = yield* Effect.all([makeTestScope, makeTestScope], { concurrency: 1 });
      const own = yield* debtFixture(runtime, runtimeClient, scope, 'COMGATE');
      const foreign = yield* debtFixture(runtime, runtimeClient, otherScope, 'COMGATE');
      yield* prepareThroughLedger(runtime, own);
      yield* prepareThroughLedger(runtime, foreign);
      for (const fixture of [own, foreign]) {
        yield* inWorker(runtime, fixture.scope, ({ ledger, scope: worker, workerContext }) =>
          ledger.recordOutcomeUnknown({
            at: RESPONDED_AT,
            operationId: fixture.collect.operationId,
            scope: worker,
            workerContext,
          }),
        );
      }

      const ownPage = yield* readDebt(runtime, scope, { limit: 50 });
      expect(ownPage.rows.map((row) => row.operationId)).toEqual([own.collect.operationId]);
      const foreignPage = yield* readDebt(runtime, otherScope, { limit: 50 });
      expect(foreignPage.rows.map((row) => row.operationId)).toEqual([foreign.collect.operationId]);
    }),
  ),
);

it.live('#1158 A resolved operation disappears from reconciliation debt', () =>
  Effect.scoped(
    Effect.gen(function* resolvedDisappears() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const first = yield* debtFixture(runtime, runtimeClient, scope, 'COMGATE');
      const second = yield* debtFixture(runtime, runtimeClient, scope, 'GOPAY');
      yield* prepareThroughLedger(runtime, first);
      yield* prepareThroughLedger(runtime, second);
      for (const fixture of [first, second]) {
        yield* inWorker(runtime, fixture.scope, ({ ledger, scope: worker, workerContext }) =>
          ledger.recordOutcomeUnknown({
            at: RESPONDED_AT,
            operationId: fixture.collect.operationId,
            scope: worker,
            workerContext,
          }),
        );
      }

      // Paginated: the first page holds one operation and points at the next.
      const firstPage = yield* readDebt(runtime, scope, { limit: 1 });
      expect(firstPage.rows).toHaveLength(1);
      expect(Option.isSome(firstPage.nextAfterOperationId)).toBe(true);
      const cursor = Option.getOrThrow(firstPage.nextAfterOperationId);
      const lastPage = yield* readDebt(runtime, scope, { afterOperationId: cursor, limit: 1 });
      expect(lastPage.rows).toHaveLength(1);
      expect(Option.isNone(lastPage.nextAfterOperationId)).toBe(true);
      const listed = [...firstPage.rows, ...lastPage.rows].map((row) => row.operationId);
      expect(listed).toHaveLength(2);
      expect(listed).toContain(first.collect.operationId);
      expect(listed).toContain(second.collect.operationId);

      expect((yield* readDebt(runtime, scope, { limit: 50 })).rows).toHaveLength(2);

      // The provider answers the first create after all: the ledger leaves OUTCOME_UNKNOWN and the debt clears.
      const answered = yield* providerRef({ _tag: 'COMGATE_TRANSACTION', transId: 'ct_resolved' });
      yield* inWorker(runtime, scope, ({ ledger, scope: worker, workerContext }) =>
        ledger.recordAcknowledged({
          customerRedirectUrl: Option.none(),
          operationId: first.collect.operationId,
          providerPaymentRef: Option.some(answered),
          providerRefundRef: Option.none(),
          respondedAt: RESPONDED_AT,
          scope: worker,
          workerContext,
        }),
      );
      const afterResolve = yield* readDebt(runtime, scope, { limit: 50 });
      expect(afterResolve.rows.map((row) => row.operationId)).toEqual([second.collect.operationId]);
    }),
  ),
);

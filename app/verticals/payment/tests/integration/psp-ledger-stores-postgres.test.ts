import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import type { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Exit, Layer, Option, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { PaymentRefundBasisSchema } from '../../shared/domain/payment-refund-basis.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import {
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
  GatewayReturnTokenSchema,
} from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
} from '../../shared/domain/psp-configuration.ts';
import { refundMaterialRequest } from '../../src/domain/refund-admission.ts';
import { ProviderDispatchLedgerLive } from '../../src/integrations/psp/dispatch-ledger-live.ts';
import { ProviderDispatchLedger } from '../../src/integrations/psp/dispatch-ledger.ts';
import type {
  ProviderDispatchIdentity,
  ProviderDispatchLedgerContract,
  ProviderPrepareResult,
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
import type { ProviderObjectRef } from '../../src/integrations/psp/psp-request.ts';
import { PreparedProviderRequestSchema, ProviderEvidenceSchema } from '../../src/integrations/psp/psp-result.ts';
import { providerReplayEvidenceForTransaction } from '../../src/integrations/psp/replay-guarantee-live.ts';
import { computePaymentMaterialHash } from '../../src/persistence/payment-aggregate-persistence.ts';
import { pspDispatchReadPersistenceForTransaction } from '../../src/persistence/psp-dispatch-read-persistence.ts';
import type { PspDispatchReadPersistence } from '../../src/persistence/psp-dispatch-read-persistence.ts';
import { configuredRefundExecutionRouteFor } from '../support/refund-execution-route.fixture.ts';
import {
  COMPOSITION_REVISION,
  collectInput,
  inScope,
  makeTestScope,
  newPaymentInput,
  operationalScopeOf,
  paymentTestRelations,
  provenanceFor,
  randomUuid,
  withPersistence,
} from './database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from './database-fixture.ts';

type Family = typeof PaymentGatewayProviderFamilySchema.Type;
type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

const WORKER_KEY = 'payment.core.execute-gateway-operation';
const NOTIFICATION_URL = 'https://hooks.example.test/psp';
const RESPONDED_AT = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');

const MERCHANT_IDENTITIES = {
  COMGATE: { _tag: 'COMGATE', merchantId: '123456' },
  GOPAY: { _tag: 'GOPAY', goid: '8123456789' },
  STRIPE: { _tag: 'STRIPE', accountId: 'acct_1TestAccount' },
} as const;
/** The same identities as the stored `merchant_identity` documents. */
const MERCHANT_IDENTITY_DOCUMENTS = {
  COMGATE: '{"_tag":"COMGATE","merchantId":"123456"}',
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<Family, string>;

const storesLayer = Layer.mergeAll(
  ProviderDispatchLedgerLive,
  ProviderEvidenceStoreLive,
  ProviderNotificationStoreLive,
);

/** The ledger and its stores never publish a completion. */
const NO_COMPLETION: OutboxWorkerLegalEntityScope['completionPublisher'] = {
  publish: () => Effect.die('The ledger publishes no completion'),
};

/** What one worker delivery sees: the live stores, its verified legal-entity scope and its delivery. */
interface WorkerCall {
  readonly evidence: ProviderEvidenceStoreContract;
  readonly ledger: ProviderDispatchLedgerContract;
  readonly notifications: ProviderNotificationStoreContract;
  readonly scope: OutboxWorkerLegalEntityScope;
  readonly workerContext: OutboxWorkerHandlerContext;
}

/** A verified delivery of admitted work; `originated: false` models a delivery without an originating Action. */
const deliveryOf = (scope: PaymentTestScope, originated = true) =>
  Effect.all([randomUuid, randomUuid, randomUuid], { concurrency: 1 }).pipe(
    Effect.map(([deliveryId, invocationId, messageId]): OutboxWorkerHandlerContext => {
      const delivery = {
        attemptNumber: 1,
        claimId: messageId,
        compositionRevision: COMPOSITION_REVISION,
        deliveryId,
        domainEventId: messageId,
        messageId,
        producerModuleKey: 'payment.core',
        tenantId: scope.tenantId,
        tenantSequenceNo: 1n,
        topic: 'payment.core.operation-requested.v1',
        workerKey: WORKER_KEY,
      };
      return originated ? { ...delivery, originatorInvocationId: invocationId } : delivery;
    }),
  );

/**
 * Runs one worker call in its own Core-scoped runtime transaction, exactly as an Outbox worker legal-entity
 * scope receives it: only the routine invoker, never a database executor.
 */
const inWorker = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  call: (worker: WorkerCall) => Effect.Effect<Value, Failure>,
  options: { readonly originated?: boolean } = {},
) =>
  Effect.gen(function* workerCall() {
    const [workerContext, ledger, evidence, notifications] = yield* Effect.all(
      [
        deliveryOf(scope, options.originated ?? true),
        Effect.service(ProviderDispatchLedger),
        Effect.service(ProviderEvidenceStore),
        Effect.service(ProviderNotificationStore),
      ],
      { concurrency: 1 },
    );
    return yield* database.transaction((transaction: PaymentTestTransaction) =>
      installOperationalScope(transaction, operationalScopeOf(scope), defineDatabaseIdentityEnrollment([])).pipe(
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

/** One Core-scoped Action or Read transaction. */
const inTransaction = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PaymentTestTransaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope), defineDatabaseIdentityEnrollment([])).pipe(
      Effect.flatMap(operation),
    ),
  );

const expectTag = <Value extends { readonly _tag: string }, Tag extends Value['_tag']>(value: Value, tag: Tag) =>
  Effect.sync(() => expect(Predicate.isTagged(value, tag)).toBe(true)).pipe(
    Effect.andThen(Predicate.isTagged(value, tag) ? Effect.succeed(value) : Effect.never),
  );

const providerRef = (input: typeof ProviderObjectRefSchema.Encoded) =>
  Schema.decodeEffect(ProviderObjectRefSchema)(input);

interface GatewayFixture {
  readonly accountRef: GatewayProviderAccountRef;
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly collect: ProviderDispatchIdentity;
  readonly family: Family;
  readonly paymentId: string;
  readonly scope: PaymentTestScope;
}

const gatewayBindingOf = (family: Family, accountRef: string) =>
  ({
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: accountRef,
    providerFamily: family,
  }) as const;

/**
 * One CURRENT binding (at most one per family and environment in a scope) with its ACTIVE credential, as the
 * configuration Action writes it, and a Payment with its COLLECT.
 */
const gatewayFixture = Effect.fn('PspLedgerFixture.gateway')(function* gatewayFixture(
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
  return { accountRef, bindingId, collect, family, paymentId, scope } satisfies GatewayFixture;
});

/** The adapter's prepared request: Stripe with its exact replayable bytes, key and window; others without. */
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
    // The ledger refuses a GoPay refund without its pre-dispatch refund-history baseline, and any other with one.
    refundBaseline:
      family === 'GOPAY' && identity.operationKind === 'REFUND' ? Option.some({ rowIds: [] }) : Option.none(),
    replayWindowMs: stripe ? Option.some(86_400_000) : Option.none(),
    requestHash: 'a'.repeat(64),
  });
};

const returnTokenFor = (seed: string) =>
  Schema.decodeEffect(GatewayReturnTokenSchema)(seed.replaceAll('-', '').slice(0, 22));

/**
 * Prepares one operation through the live ledger in its own worker delivery and transaction. A GoPay refund's
 * baseline goes with `refundDispatchCount`, the count of the serialization check it was read after.
 */
const prepareThroughLedger = (
  runtime: PaymentTestDatabase,
  fixture: GatewayFixture,
  identity: ProviderDispatchIdentity,
  returnTokenSeed?: string,
  refundDispatchCount = 0,
) =>
  Effect.gen(function* prepareDispatch() {
    const prepared = yield* preparedFor(identity, fixture.family);
    const returnToken =
      returnTokenSeed === undefined ? Option.none() : Option.some(yield* returnTokenFor(returnTokenSeed));
    return yield* inWorker(runtime, fixture.scope, ({ ledger, scope, workerContext }) =>
      ledger.prepare({
        identity,
        prepared,
        refundDispatchCount: prepared.refundBaseline.pipe(Option.map(() => refundDispatchCount)),
        returnToken,
        scope,
        workerContext,
      }),
    );
  });

const acknowledge = (
  runtime: PaymentTestDatabase,
  fixture: GatewayFixture,
  operationId: string,
  refs: { readonly payment?: ProviderObjectRef; readonly redirect?: string },
) =>
  inWorker(runtime, fixture.scope, ({ ledger, scope, workerContext }) =>
    ledger.recordAcknowledged({
      customerRedirectUrl: Option.fromUndefinedOr(refs.redirect),
      operationId,
      providerPaymentRef: Option.fromUndefinedOr(refs.payment),
      providerRefundRef: Option.none(),
      respondedAt: RESPONDED_AT,
      scope,
      workerContext,
    }),
  );

const dispatchCount = (runtimeClient: PgClient.PgClient, scope: PaymentTestScope, operationId: string) =>
  inScope(
    runtimeClient,
    scope,
    runtimeClient.unsafe<{ count: number }>(
      'select count(*)::integer as count from payment.psp_provider_dispatches where operation_id = $1',
      [operationId],
    ),
  ).pipe(Effect.map((rows) => rows[0]?.count ?? -1));

const refundBasisOf = (itemRef: string) =>
  Schema.decodeUnknownEffect(PaymentRefundBasisSchema)({
    _tag: 'REFUNDABLE_ITEMS',
    items: [{ amountMinor: 10_000, currency: 'CZK', itemRef, sourceEvidenceRef: `order:item:${itemRef}` }],
  });
const REFUND_AMOUNT = { amountMinor: 10_000, currency: 'CZK' } as const;
const GOPAY_PAYMENT_ID = '3000006529';

/** A GoPay COLLECT that the provider acknowledged and Payment confirmed, and a factory of REFUND operations. */
const refundableGopayCollect = Effect.fn('PspLedgerFixture.refundable')(function* refundableGopayCollect(
  runtime: PaymentTestDatabase,
  runtimeClient: PgClient.PgClient,
) {
  const scope = yield* makeTestScope;
  const fixture = yield* gatewayFixture(runtime, runtimeClient, scope, 'GOPAY');
  yield* expectTag(yield* prepareThroughLedger(runtime, fixture, fixture.collect), 'PREPARED');
  const paymentRef = yield* providerRef({ _tag: 'GOPAY_PAYMENT', id: GOPAY_PAYMENT_ID });
  yield* acknowledge(runtime, fixture, fixture.collect.operationId, { payment: paymentRef });
  const binding = gatewayBindingOf('GOPAY', fixture.accountRef);
  const [confirm, refundExecutionRoute] = yield* Effect.all(
    [provenanceFor(scope), configuredRefundExecutionRouteFor(runtime, scope, binding)],
    { concurrency: 1 },
  );
  yield* withPersistence(runtime, scope, (persistence) =>
    persistence.transitionOperationOutcome({
      causedBy: { kind: 'OBSERVATION', sourceId: 'observation:captured' },
      expectedOutcomeRevision: 1,
      operationId: fixture.collect.operationId,
      paymentId: fixture.paymentId,
      provenance: confirm,
      to: 'EFFECT_CONFIRMED',
    }),
  );
  const refund = Effect.fn('PspLedgerFixture.refund')(function* refund(itemRef: string) {
    const [provenance, basis] = yield* Effect.all([provenanceFor(scope), refundBasisOf(itemRef)], {
      concurrency: 1,
    });
    const created = yield* withPersistence(runtime, scope, (persistence) =>
      persistence.insertOperation({
        amount: REFUND_AMOUNT,
        binding,
        initialOutcome: 'PENDING',
        kind: 'REFUND',
        materialRequest: refundMaterialRequest({ amount: REFUND_AMOUNT, basis, reason: 'Returned goods' }),
        operationKey: `refund-${itemRef}`,
        paymentId: fixture.paymentId,
        provenance,
        refundBasis: basis,
        refundExecutionRoute,
        targetOperationId: fixture.collect.operationId,
      }),
    );
    return {
      ...fixture.collect,
      materialHash: created.record.materialHash,
      operationId: created.record.operationId,
      operationKind: 'REFUND',
      targetOperationId: Option.some(fixture.collect.operationId),
    } satisfies ProviderDispatchIdentity;
  });
  return { fixture, paymentRef, refund };
});

it.live('#1158 Same logical refund but changed basis returns a conflict without a provider mutation', () =>
  Effect.scoped(
    Effect.gen(function* changedBasisConflicts() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const { fixture, refund } = yield* refundableGopayCollect(runtime, runtimeClient);
      const original = yield* refund('A');
      yield* expectTag(yield* prepareThroughLedger(runtime, fixture, original), 'PREPARED');

      // The C16 material hash covers the refund basis: the same refund with another basis hashes differently.
      const changedHash = yield* computePaymentMaterialHash(
        refundMaterialRequest({ amount: REFUND_AMOUNT, basis: yield* refundBasisOf('B'), reason: 'Returned goods' }),
      );
      expect(changedHash).not.toBe(original.materialHash);

      // Same operation id, other material: CONFLICT with the persisted row; nothing new is prepared or sent.
      const conflict = yield* expectTag(
        yield* prepareThroughLedger(runtime, fixture, { ...original, materialHash: changedHash }),
        'CONFLICT',
      );
      expect([conflict.existing.materialHash, conflict.existing.state]).toEqual([original.materialHash, 'PREPARED']);
      expect(yield* dispatchCount(runtimeClient, fixture.scope, original.operationId)).toBe(1);
    }),
  ),
);

it.live('#1158 Duplicate execution delivery reuses the existing dispatch', () =>
  Effect.scoped(
    Effect.gen(function* duplicateDelivery() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const token = yield* randomUuid;
      const first = yield* expectTag(yield* prepareThroughLedger(runtime, fixture, fixture.collect, token), 'PREPARED');
      expect(Option.isSome(first.record.preparedAt)).toBe(true);
      expect(Option.isSome(first.record.requestBody)).toBe(true);

      // Another delivery of the same work and a concurrent executor reuse the one prepared request.
      const repeated = yield* Effect.all(
        [
          prepareThroughLedger(runtime, fixture, fixture.collect, token),
          prepareThroughLedger(runtime, fixture, fixture.collect, token),
        ],
        { concurrency: 2 },
      );
      for (const result of repeated) {
        const existing = yield* expectTag<ProviderPrepareResult, 'EXISTING'>(result, 'EXISTING');
        expect(existing.record).toEqual(first.record);
      }
      expect(yield* dispatchCount(runtimeClient, scope, fixture.collect.operationId)).toBe(1);

      // A redelivery reads the persisted row first and continues from it.
      const read = yield* inWorker(runtime, scope, ({ ledger, scope: worker }) =>
        ledger.readByOperation({ operationId: fixture.collect.operationId, scope: worker }),
      );
      expect(read).toEqual(Option.some(first.record));

      // A delivery without an originating Action invocation writes nothing.
      const prepared = yield* preparedFor(fixture.collect, 'STRIPE');
      const anonymous = yield* Effect.exit(
        inWorker(
          runtime,
          scope,
          ({ ledger, scope: worker, workerContext }) =>
            ledger.prepare({
              identity: fixture.collect,
              prepared,
              refundDispatchCount: Option.none(),
              returnToken: Option.none(),
              scope: worker,
              workerContext,
            }),
          { originated: false },
        ),
      );
      expect(Exit.isFailure(anonymous)).toBe(true);
    }),
  ),
);

it.live('#1157 Create response lost then notification correlates by order reference', () =>
  Effect.scoped(
    Effect.gen(function* lostResponseCorrelates() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const other = yield* gatewayFixture(runtime, runtimeClient, scope, 'GOPAY');
      yield* expectTag(yield* prepareThroughLedger(runtime, fixture, fixture.collect), 'PREPARED');
      const { orderReference } = deriveProviderCorrelation(fixture.collect.operationId);
      const [session, otherSession] = yield* Effect.all(
        [
          providerRef({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_lost_1' }),
          providerRef({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_other_1' }),
        ],
        { concurrency: 1 },
      );
      const unknown = yield* inWorker(runtime, scope, ({ ledger, scope: worker, workerContext }) =>
        ledger.recordOutcomeUnknown({
          at: RESPONDED_AT,
          operationId: fixture.collect.operationId,
          scope: worker,
          workerContext,
        }),
      );
      expect(unknown.state).toBe('OUTCOME_UNKNOWN');
      const correlate = (bindingId: GatewayProviderAccountBindingId, ref: ProviderObjectRef) =>
        inWorker(runtime, scope, ({ ledger, scope: worker, workerContext }) =>
          ledger.correlateUnknown({ bindingId, orderReference, providerRef: ref, scope: worker, workerContext }),
        );

      // The order reference inside another binding never correlates this binding's dispatch.
      expect(Option.isNone(yield* correlate(other.bindingId, session))).toBe(true);
      const correlated = yield* correlate(fixture.bindingId, session);
      expect(correlated.pipe(Option.map((record) => [record.state, record.providerPaymentRef]))).toEqual(
        Option.some(['ACKNOWLEDGED', Option.some(session)]),
      );
      const again = yield* correlate(fixture.bindingId, session);
      expect(again.pipe(Option.map((record) => record.state))).toEqual(Option.some('ACKNOWLEDGED'));
      const contradicting = yield* Effect.flip(correlate(fixture.bindingId, otherSession));
      expect(Predicate.isTagged(contradicting, 'GatewayCorrelationConflict')).toBe(true);

      // The provider object now leads to the dispatch, inside its own binding only.
      const byRef = (bindingId: GatewayProviderAccountBindingId) =>
        inWorker(runtime, scope, ({ ledger, scope: worker }) =>
          ledger.readByProviderRef({ bindingId, providerRef: session, scope: worker }),
        );
      expect((yield* byRef(fixture.bindingId)).pipe(Option.map((record) => record.operationId))).toEqual(
        Option.some(fixture.collect.operationId),
      );
      expect(Option.isNone(yield* byRef(other.bindingId))).toBe(true);
    }),
  ),
);

it.live('#1158 Refunds are serialized per provider payment', () =>
  Effect.scoped(
    Effect.gen(function* refundsSerialized() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const { fixture, paymentRef, refund } = yield* refundableGopayCollect(runtime, runtimeClient);
      const [first, second] = yield* Effect.all([refund('A'), refund('B')], { concurrency: 1 });
      const raced = yield* Effect.all(
        [prepareThroughLedger(runtime, fixture, first), prepareThroughLedger(runtime, fixture, second)],
        { concurrency: 2 },
      );
      const preparedIndex = raced.findIndex((result) => Predicate.isTagged(result, 'PREPARED'));
      expect(preparedIndex).toBeGreaterThanOrEqual(0);
      const [winner, loser] = preparedIndex === 0 ? [first, second] : [second, first];
      const deferred = yield* expectTag(raced[1 - preparedIndex] ?? raced[0], 'DEFERRED');
      expect(deferred.unresolvedRefundOperationIds).toEqual([winner.operationId]);
      expect(yield* dispatchCount(runtimeClient, fixture.scope, loser.operationId)).toBe(0);

      const serialization = inWorker(runtime, fixture.scope, ({ ledger, scope }) =>
        ledger.refundSerialization({ bindingId: fixture.bindingId, providerPaymentRef: paymentRef, scope }),
      );
      const unresolved = serialization.pipe(Effect.map((read) => read.unresolved));
      expect(yield* unresolved).toBe(true);

      // Acknowledged is not resolved yet: refund completion needs definitive refund evidence.
      yield* acknowledge(runtime, fixture, winner.operationId, {});
      expect(yield* unresolved).toBe(true);
      yield* expectTag(yield* prepareThroughLedger(runtime, fixture, loser), 'DEFERRED');

      const confirmation = yield* Schema.decodeUnknownEffect(ProviderEvidenceSchema)({
        discrepancy: Option.none(),
        economicEffectKey: Option.some(`gopay-refund:${GOPAY_PAYMENT_ID}:${winner.operationId}`),
        factFamily: 'REFUND_EXECUTION',
        factKind: 'REFUND_CONFIRMED',
        observedAmount: Option.some(REFUND_AMOUNT),
        observedAt: RESPONDED_AT,
        providerOccurredAt: Option.none(),
        providerRefs: [paymentRef],
        reason: Option.none(),
        sourceOccurrenceId: `gopay:RECOVERY_LOOKUP:${GOPAY_PAYMENT_ID}:${winner.operationId}:REFUND_CONFIRMED:10000`,
        sourceRevision: 0,
      });
      yield* inWorker(runtime, fixture.scope, ({ evidence, scope, workerContext }) =>
        evidence.append({
          bindingId: fixture.bindingId,
          evidence: confirmation,
          notificationId: Option.none(),
          operationId: winner.operationId,
          origin: 'RECOVERY_LOOKUP',
          paymentId: fixture.paymentId,
          scope,
          workerContext,
        }),
      );
      // #1158: a baseline read under the old count (no refund dispatch yet) is refused; under the current one it is not.
      const { refundDispatchCount } = yield* serialization;
      expect([yield* unresolved, refundDispatchCount]).toEqual([false, 1]);
      yield* expectTag(yield* prepareThroughLedger(runtime, fixture, loser), 'REFUND_BASELINE_STALE');
      expect(yield* dispatchCount(runtimeClient, fixture.scope, loser.operationId)).toBe(0);
      yield* expectTag(
        yield* prepareThroughLedger(runtime, fixture, loser, undefined, refundDispatchCount),
        'PREPARED',
      );
    }),
  ),
);

it.live('#1158 The replay guarantee is returned only for a Stripe dispatch inside its window', () =>
  Effect.scoped(
    Effect.gen(function* replayGuaranteeWindow() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const stripe = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const gopay = yield* gatewayFixture(runtime, runtimeClient, scope, 'GOPAY');
      const prepared = yield* expectTag(yield* prepareThroughLedger(runtime, stripe, stripe.collect), 'PREPARED');
      yield* expectTag(yield* prepareThroughLedger(runtime, gopay, gopay.collect), 'PREPARED');
      const startsAt = DateTime.toEpochMillis(Option.getOrThrow(prepared.record.replayStartsAt));

      /** The guarantee as the recovery Action reads it at an exact instant of its clock. */
      const guaranteeAt = (fixture: GatewayFixture, atMs: number, materialHash = fixture.collect.materialHash) =>
        TestClock.setTime(atMs).pipe(
          Effect.andThen(
            inTransaction(runtime, scope, (transaction) =>
              providerReplayEvidenceForTransaction(transaction).readGuarantee({
                binding: gatewayBindingOf(fixture.family, fixture.accountRef),
                materialHash,
                operationId: fixture.collect.operationId,
                operationKind: 'COLLECT',
                paymentId: fixture.paymentId,
                scope: { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId },
              }),
            ),
          ),
          Effect.provide(TestClock.layer()),
        );

      const inside = yield* guaranteeAt(stripe, startsAt + 3_600_000);
      expect(
        inside.pipe(
          Option.map((guarantee) => [
            guarantee.operationId,
            guarantee.endpointRef,
            guarantee.providerRequestHash,
            guarantee.startsAtEpochMs,
            guarantee.expiresAtEpochMs,
          ]),
        ),
      ).toEqual(
        Option.some([
          stripe.collect.operationId,
          'stripe:POST:/v1/checkout/sessions',
          'a'.repeat(64),
          startsAt,
          startsAt + 86_400_000,
        ]),
      );
      // Before or after its window, for other material, or for a family without replay there is none.
      expect(Option.isNone(yield* guaranteeAt(stripe, startsAt - 1))).toBe(true);
      expect(Option.isNone(yield* guaranteeAt(stripe, startsAt + 86_400_000))).toBe(true);
      expect(Option.isNone(yield* guaranteeAt(stripe, startsAt + 1, 'f'.repeat(64)))).toBe(true);
      expect(Option.isNone(yield* guaranteeAt(gopay, startsAt + 1))).toBe(true);

      // Once the provider answered, the response is known and nothing is replayed.
      yield* acknowledge(runtime, stripe, stripe.collect.operationId, {
        payment: yield* providerRef({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_answered' }),
        redirect: 'https://checkout.stripe.test/c/pay/cs_test_answered',
      });
      expect(Option.isNone(yield* guaranteeAt(stripe, startsAt + 1))).toBe(true);
    }),
  ),
);

/** A notification captured for the fixture's binding, as the capture Action stores it. */
const captureNotification = (
  runtimeClient: PgClient.PgClient,
  fixture: GatewayFixture,
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
         $9::jsonb, '{}'::jsonb, convert_to($10, 'UTF8'), '2026-11-12T09:00:00Z', 'CAPTURED', 'relay-delivery-1',
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

it.live('#1158 The evidence pending list and markSubmission are idempotent', () =>
  Effect.scoped(
    Effect.gen(function* evidenceIdempotent() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const other = yield* gatewayFixture(runtime, runtimeClient, scope, 'COMGATE');
      yield* expectTag(yield* prepareThroughLedger(runtime, fixture, fixture.collect), 'PREPARED');
      const intent = yield* providerRef({ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_test_evidence' });
      const notificationId = yield* captureNotification(runtimeClient, fixture, {
        body: '{"id":"evt_test_1","data":{"object":{"id":"pi_test_evidence","object":"payment_intent"}}}',
        deliveryIdentity: 'stripe:evt:evt_test_1',
        providerRefs: '[{"_tag":"STRIPE_PAYMENT_INTENT","id":"pi_test_evidence"}]',
      });
      const foreignNotificationId = yield* captureNotification(runtimeClient, other, {
        body: '{}',
        deliveryIdentity: 'stripe:evt:evt_test_other',
        providerRefs: '[]',
      });
      const observedAt = DateTime.makeUnsafe('2026-11-12T09:00:05.000Z');
      const statement = yield* Schema.decodeUnknownEffect(ProviderEvidenceSchema)({
        discrepancy: Option.none(),
        economicEffectKey: Option.some('pi_test_evidence'),
        factFamily: 'GATEWAY_OUTCOME',
        factKind: 'COLLECTION_CONFIRMED',
        observedAmount: Option.some({ amountMinor: 100_000, currency: 'CZK' }),
        observedAt,
        providerOccurredAt: Option.none(),
        providerRefs: [intent],
        reason: Option.none(),
        sourceOccurrenceId: 'stripe:evt:evt_test_1',
        sourceRevision: 0,
      });
      const append = (overrides: {
        readonly evidence?: typeof statement;
        readonly notification?: typeof notificationId;
      }) =>
        inWorker(runtime, scope, ({ evidence, scope: worker, workerContext }) =>
          evidence.append({
            bindingId: fixture.bindingId,
            evidence: overrides.evidence ?? statement,
            notificationId: Option.some(overrides.notification ?? notificationId),
            operationId: fixture.collect.operationId,
            origin: 'NOTIFICATION_SIGNED',
            paymentId: fixture.paymentId,
            scope: worker,
            workerContext,
          }),
        );

      const stored = yield* append({});
      expect(stored.submissionState).toBe('PENDING_SUBMISSION');
      expect(stored.notificationId).toEqual(Option.some(notificationId));
      // The receipt is the captured notification's, the verification instant the observation's.
      expect(DateTime.formatIso(stored.receivedAt)).toBe('2026-11-12T09:00:00.000Z');
      expect(stored.verifiedAt).toEqual(observedAt);
      expect(stored.evidence).toEqual(statement);
      expect((yield* append({})).evidenceId).toBe(stored.evidenceId);

      // The same occurrence with another statement, or evidence tied to another binding's notification, is refused.
      const changed = yield* Effect.flip(append({ evidence: { ...statement, factKind: 'COLLECTION_NOT_EFFECTED' } }));
      expect(Predicate.isTagged(changed, 'GatewayEvidenceConflict')).toBe(true);
      const misattributed = yield* Effect.flip(
        append({ evidence: { ...statement, sourceRevision: 1 }, notification: foreignNotificationId }),
      );
      expect(Predicate.isTagged(misattributed, 'GatewayEvidenceConflict')).toBe(true);

      const pending = inWorker(runtime, scope, ({ evidence, scope: worker }) =>
        evidence.listPending({ operationId: fixture.collect.operationId, scope: worker }),
      ).pipe(Effect.map((rows) => rows.map((row) => row.evidenceId)));
      expect(yield* pending).toEqual([stored.evidenceId]);
      expect(yield* pending).toEqual([stored.evidenceId]);

      const mark = (outcome: 'ACCEPTED' | 'HELD') =>
        inWorker(runtime, scope, ({ evidence, scope: worker, workerContext }) =>
          evidence.markSubmission({
            evidenceId: stored.evidenceId,
            observationId: Option.none(),
            outcome,
            scope: worker,
            workerContext,
          }),
        );
      expect((yield* mark('HELD')).submissionState).toBe('HELD');
      expect((yield* mark('HELD')).submissionState).toBe('HELD');
      const contradicting = yield* Effect.flip(mark('ACCEPTED'));
      expect(Predicate.isTagged(contradicting, 'GatewayLedgerUnavailable')).toBe(true);
      expect(yield* pending).toEqual([]);

      // The notification maps back to its verified trigger; only its own binding's operation correlates.
      const read = yield* inWorker(runtime, scope, ({ notifications, scope: worker }) =>
        notifications.read({ notificationId, scope: worker }),
      );
      expect(read.pipe(Option.map((row) => [row.state, row.trigger.actionable, row.trigger.providerRefs]))).toEqual(
        Option.some(['CAPTURED', true, [intent]]),
      );
      expect(read.pipe(Option.flatMap((row) => row.trigger.signedObject))).toEqual(
        Option.some({ id: 'pi_test_evidence', object: 'payment_intent' }),
      );
      const transition = (operationId: string) =>
        inWorker(runtime, scope, ({ notifications, scope: worker, workerContext }) =>
          notifications.transition({
            correlatedOperationId: Option.some(operationId),
            notificationId,
            scope: worker,
            to: 'SUBMITTED',
            workerContext,
          }),
        );
      const foreignOperation = yield* Effect.flip(transition(other.collect.operationId));
      expect(foreignOperation.reason).toBe('notification_transition_refused:binding_mismatch');
      expect((yield* transition(fixture.collect.operationId)).state).toBe('SUBMITTED');
      expect((yield* transition(fixture.collect.operationId)).correlatedOperationId).toEqual(
        Option.some(fixture.collect.operationId),
      );
    }),
  ),
);

it.live('#1158 Gateway Reads see redirect, return status and reconciliation debt of their own scope only', () =>
  Effect.scoped(
    Effect.gen(function* gatewayReads() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const [scope, otherScope] = yield* Effect.all([makeTestScope, makeTestScope], { concurrency: 1 });
      const answered = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const lost = yield* gatewayFixture(runtime, runtimeClient, scope, 'GOPAY');
      const foreign = yield* gatewayFixture(runtime, runtimeClient, otherScope, 'STRIPE');
      const [answeredToken, lostToken, foreignToken] = yield* Effect.all([randomUuid, randomUuid, randomUuid], {
        concurrency: 1,
      });
      yield* prepareThroughLedger(runtime, answered, answered.collect, answeredToken);
      yield* prepareThroughLedger(runtime, lost, lost.collect, lostToken);
      yield* prepareThroughLedger(runtime, foreign, foreign.collect, foreignToken);
      const reads = <Value>(read: (persistence: PspDispatchReadPersistence) => Effect.Effect<Value, unknown>) =>
        inTransaction(runtime, scope, (transaction) => read(pspDispatchReadPersistenceForTransaction(transaction)));
      const customerAction = (fixture: GatewayFixture) =>
        reads((persistence) =>
          persistence.selectCustomerAction({ operationId: fixture.collect.operationId, paymentId: fixture.paymentId }),
        );

      expect(yield* customerAction(answered)).toEqual(Option.some({ status: 'AWAITING_PROVIDER' }));
      yield* acknowledge(runtime, answered, answered.collect.operationId, {
        payment: yield* providerRef({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_read' }),
        redirect: 'https://checkout.stripe.test/c/pay/cs_test_read',
      });
      expect(yield* customerAction(answered)).toEqual(
        Option.some({ redirectUrl: 'https://checkout.stripe.test/c/pay/cs_test_read', status: 'REDIRECT_AVAILABLE' }),
      );
      expect(yield* customerAction(foreign)).toEqual(Option.none());

      yield* inWorker(runtime, scope, ({ ledger, scope: worker, workerContext }) =>
        ledger.recordOutcomeUnknown({
          at: RESPONDED_AT,
          operationId: lost.collect.operationId,
          scope: worker,
          workerContext,
        }),
      );
      const status = (seed: string) =>
        returnTokenFor(seed).pipe(
          Effect.flatMap((returnToken) => reads((persistence) => persistence.selectReturnStatus(returnToken))),
        );
      expect(yield* status(answeredToken)).toEqual(Option.some({ dispatchState: 'ACKNOWLEDGED', outcome: 'PENDING' }));
      expect(yield* status(lostToken)).toEqual(Option.some({ dispatchState: 'OUTCOME_UNKNOWN', outcome: 'PENDING' }));
      expect(yield* status(foreignToken)).toEqual(Option.none());

      const debt = yield* reads((persistence) =>
        persistence.selectReconciliationDebt({ afterOperationId: Option.none(), limit: 50 }),
      );
      expect(
        debt.rows.map((row) => [row.operationId, row.ledgerState, row.recommendedTrigger, row.pendingEvidenceCount]),
      ).toEqual([[lost.collect.operationId, 'OUTCOME_UNKNOWN', 'EXECUTION_OUTCOME_UNKNOWN', 0]]);
      expect(Option.isNone(debt.nextAfterOperationId)).toBe(true);
    }),
  ),
);

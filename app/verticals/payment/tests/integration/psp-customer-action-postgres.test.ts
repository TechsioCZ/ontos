import type { ScopedTransactionExecutor } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import type { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { readGatewayCustomerAction } from '../../src/api/gateway-customer-action.read.ts';
import { readGatewayReturnStatus } from '../../src/api/gateway-return-status.read.ts';
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
import { ProviderNotificationStore } from '../../src/integrations/psp/notification-store.ts';
import type { ProviderNotificationStoreContract } from '../../src/integrations/psp/notification-store.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayExecutionTargetSchema, ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import type { ProviderObjectRef } from '../../src/integrations/psp/psp-request.ts';
import { PreparedProviderRequestSchema } from '../../src/integrations/psp/psp-result.ts';
import { pspDispatchReadPersistenceForTransaction } from '../../src/persistence/psp-dispatch-read-persistence.ts';
import {
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
  GatewayReturnTokenSchema,
} from '../../shared/domain/psp-configuration.ts';
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
 * #1156/#1157 gateway Reads: the customer redirect appears only after the provider acknowledged it, and the
 * browser return status never changes Payment state. Each test runs on fresh random identities.
 */

const TestFamily = Schema.Literals(['GOPAY', 'STRIPE']);
type Family = typeof TestFamily.Type;
type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

const WORKER_KEY = 'payment.core.execute-gateway-operation';
const NOTIFICATION_URL = 'https://hooks.example.test/psp';
const RESPONDED_AT = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');
const CHECKOUT_URL = 'https://checkout.stripe.test/c/pay/cs_test_customer_action';

const MERCHANT_IDENTITIES = {
  GOPAY: { _tag: 'GOPAY', goid: '8123456789' },
  STRIPE: { _tag: 'STRIPE', accountId: 'acct_1TestAccount' },
} as const;

const MERCHANT_IDENTITY_DOCUMENTS = {
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<Family, string>;

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

/** One worker delivery in its own Core-scoped runtime transaction, with only the routine invoker. */
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

/** One Core-scoped Read transaction, as the Read's service factory receives it. */
const inReadTransaction = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PaymentTestTransaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope)).pipe(Effect.flatMap(operation)),
  );

const providerRef = (input: typeof ProviderObjectRefSchema.Encoded) =>
  Schema.decodeEffect(ProviderObjectRefSchema)(input);

interface GatewayFixture {
  readonly collect: ProviderDispatchIdentity;
  readonly paymentId: string;
  readonly scope: PaymentTestScope;
}

const gatewayFixture = Effect.fn('PspCustomerActionFixture.gateway')(function* gatewayFixture(
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
  const executionBinding = {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: accountRef,
    providerFamily: family,
  } as const;
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
  return { collect, paymentId, scope } satisfies GatewayFixture;
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
    // The ledger refuses a GoPay refund without its pre-dispatch refund-history baseline, and any other with one.
    refundBaseline:
      family === 'GOPAY' && identity.operationKind === 'REFUND' ? Option.some({ rowIds: [] }) : Option.none(),
    replayWindowMs: stripe ? Option.some(86_400_000) : Option.none(),
    requestHash: 'a'.repeat(64),
  });
};

/** A deterministic 22-character token: the seed reduced to token characters and padded to the token length. */
const returnTokenFor = (seed: string) =>
  Schema.decodeEffect(GatewayReturnTokenSchema)(
    seed
      .replaceAll(/[^A-Za-z0-9_-]/gu, '')
      .padEnd(22, 'A')
      .slice(0, 22),
  );

const prepareThroughLedger = (
  runtime: PaymentTestDatabase,
  fixture: GatewayFixture,
  family: Family,
  returnTokenSeed: string,
): Effect.Effect<ProviderPrepareResult, unknown> =>
  Effect.gen(function* prepareDispatch() {
    const prepared = yield* preparedFor(fixture.collect, family);
    const returnToken = Option.some(yield* returnTokenFor(returnTokenSeed));
    return yield* inWorker(runtime, fixture.scope, ({ ledger, scope, workerContext }) =>
      ledger.prepare({
        identity: fixture.collect,
        prepared,
        refundDispatchCount: Option.none(),
        returnToken,
        scope,
        workerContext,
      }),
    );
  });

const acknowledge = (
  runtime: PaymentTestDatabase,
  fixture: GatewayFixture,
  refs: { readonly payment?: ProviderObjectRef; readonly redirect?: string },
) =>
  inWorker(runtime, fixture.scope, ({ ledger, scope, workerContext }) =>
    ledger.recordAcknowledged({
      customerRedirectUrl: Option.fromUndefinedOr(refs.redirect),
      operationId: fixture.collect.operationId,
      providerPaymentRef: Option.fromUndefinedOr(refs.payment),
      providerRefundRef: Option.none(),
      respondedAt: RESPONDED_AT,
      scope,
      workerContext,
    }),
  );

/** The Payment outcome and the number of provider evidence rows of one operation, read as owner rows. */
const paymentStateOf = (runtimeClient: PgClient.PgClient, scope: PaymentTestScope, operationId: string) =>
  inScope(
    runtimeClient,
    scope,
    Effect.all(
      [
        runtimeClient.unsafe<{ outcome: string }>(
          'select outcome from payment.payment_operations where operation_id = $1',
          [operationId],
        ),
        runtimeClient.unsafe<{ count: number }>(
          'select count(*)::integer as count from payment.psp_provider_evidence where operation_id = $1',
          [operationId],
        ),
      ],
      { concurrency: 1 },
    ),
  ).pipe(
    Effect.map(([outcomes, evidence]) => ({
      evidenceRows: evidence[0]?.count ?? -1,
      outcome: outcomes[0]?.outcome ?? 'MISSING',
    })),
  );

it.live('#1156 The customer redirect appears only after the provider acknowledged it', () =>
  Effect.scoped(
    Effect.gen(function* customerRedirectAfterAck() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const stripe = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const gopay = yield* gatewayFixture(runtime, runtimeClient, scope, 'GOPAY');
      const customerAction = (fixture: GatewayFixture) =>
        inReadTransaction(runtime, scope, (transaction) =>
          readGatewayCustomerAction(
            { operationId: fixture.collect.operationId, paymentId: fixture.paymentId },
            pspDispatchReadPersistenceForTransaction(transaction),
          ),
        );

      // No dispatch row yet: a pending COLLECT is awaiting the provider, never a redirect.
      expect(yield* customerAction(stripe)).toEqual({ status: 'AWAITING_PROVIDER' });

      // Prepared but not yet acknowledged: still awaiting, and no redirect URL.
      yield* prepareThroughLedger(runtime, stripe, 'STRIPE', 'customer-action-stripe-1');
      expect(yield* customerAction(stripe)).toEqual({ status: 'AWAITING_PROVIDER' });

      // Acknowledged with a redirect URL: the redirect is shown.
      yield* acknowledge(runtime, stripe, {
        payment: yield* providerRef({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_customer_action' }),
        redirect: CHECKOUT_URL,
      });
      expect(yield* customerAction(stripe)).toEqual({ redirectUrl: CHECKOUT_URL, status: 'REDIRECT_AVAILABLE' });

      // Acknowledged without a redirect URL: nothing to show, and no redirect URL is invented.
      yield* prepareThroughLedger(runtime, gopay, 'GOPAY', 'customer-action-gopay-1');
      yield* acknowledge(runtime, gopay, {});
      expect(yield* customerAction(gopay)).toEqual({ status: 'NOT_AVAILABLE' });
    }),
  ),
);

it.live('#1157 Browser return without financial evidence does not change payment state', () =>
  Effect.scoped(
    Effect.gen(function* browserReturnChangesNothing() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const seed = 'browser-return-stripe-1';
      yield* prepareThroughLedger(runtime, fixture, 'STRIPE', seed);
      yield* acknowledge(runtime, fixture, {
        payment: yield* providerRef({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_browser_return' }),
        redirect: CHECKOUT_URL,
      });
      const before = yield* paymentStateOf(runtimeClient, scope, fixture.collect.operationId);
      expect(before).toEqual({ evidenceRows: 0, outcome: 'PENDING' });

      const returnToken = yield* returnTokenFor(seed);
      const status = yield* inReadTransaction(runtime, scope, (transaction) =>
        readGatewayReturnStatus({ returnToken }, pspDispatchReadPersistenceForTransaction(transaction)),
      );
      expect(status).toEqual({ dispatchState: 'ACKNOWLEDGED', outcome: 'PENDING' });

      // The return only read: no evidence row was appended and the Payment outcome did not move.
      expect(yield* paymentStateOf(runtimeClient, scope, fixture.collect.operationId)).toEqual(before);
    }),
  ),
);

it.live('#1157 Return token from another legal entity is not found', () =>
  Effect.scoped(
    Effect.gen(function* foreignReturnTokenNotFound() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      // Same Tenant, another Selling Legal Entity: the token must not resolve across the boundary.
      const otherLegalEntity = { ...(yield* makeTestScope), tenantId: scope.tenantId };
      const own = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const foreign = yield* gatewayFixture(runtime, runtimeClient, otherLegalEntity, 'STRIPE');
      const ownSeed = 'return-scope-own-1';
      const foreignSeed = 'return-scope-foreign-1';
      yield* prepareThroughLedger(runtime, own, 'STRIPE', ownSeed);
      yield* prepareThroughLedger(runtime, foreign, 'STRIPE', foreignSeed);

      const statusOf = (seed: string) =>
        Effect.gen(function* statusOfToken() {
          const returnToken = yield* returnTokenFor(seed);
          return yield* inReadTransaction(runtime, scope, (transaction) =>
            readGatewayReturnStatus({ returnToken }, pspDispatchReadPersistenceForTransaction(transaction)),
          );
        });

      expect(yield* statusOf(ownSeed)).toEqual({ dispatchState: 'PREPARED', outcome: 'PENDING' });
      expect(Predicate.isTagged(yield* statusOf(foreignSeed).pipe(Effect.flip), 'ReadHandlerNotFound')).toBe(true);
      expect(Predicate.isTagged(yield* statusOf('unknown-token-seed-1').pipe(Effect.flip), 'ReadHandlerNotFound')).toBe(
        true,
      );

      // The foreign operation is not in scope for the customer action either.
      const foreignAction = yield* inReadTransaction(runtime, scope, (transaction) =>
        readGatewayCustomerAction(
          { operationId: foreign.collect.operationId, paymentId: foreign.paymentId },
          pspDispatchReadPersistenceForTransaction(transaction),
        ).pipe(Effect.flip),
      );
      expect(Predicate.isTagged(foreignAction, 'ReadHandlerNotFound')).toBe(true);
    }),
  ),
);

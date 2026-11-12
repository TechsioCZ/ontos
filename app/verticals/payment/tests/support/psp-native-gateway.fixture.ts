/**
 * #1159 level-3 native gateway fixture. The executor and the notification processor run against the native
 * Payment database: the real scoped routines of the binding resolver, dispatch ledger, evidence and notification
 * stores, inside one Core-scoped runtime transaction per legal-entity step (as the Outbox legal-entity fan-out
 * hands them to a worker). Unlike the executor and notification suites, the provider side is the production
 * adapter set over a recorded HttpClient (`psp-conformance-provider.fixture.ts`), so provider bytes, the real
 * credential store and the HTTP mutation policy take part.
 *
 * Replaced, and named as such in every test: the Outbox claim loop (one delivery is run directly), the capture
 * Action (its stored row is inserted the way it writes it), and the two remote hops of the governed A8 submission
 * (Shell gateway and A8 client; the RegisteredWorkload issuance itself is the Shell native suite).
 */
import { OutboxWorkerLegalEntityScopeError, OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import type { OutboxPayload } from '@app/payment/outbox/payment-core-operation-requested-v1';
import { GatewayContextResponseSchema } from '@app/shared-contracts';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, DateTime, Effect, Layer, Option, Ref, Schema } from 'effect';
import { SqlError } from 'effect/sql/SqlError';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { AcceptPaymentObservationPayload } from '../../shared/actions/accept-payment-observation.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import { PaymentMonetaryAmountSchema } from '../../shared/domain/payment-money.ts';
import { PaymentRefundBasisSchema } from '../../shared/domain/payment-refund-basis.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { PaymentSourceStatementResultSchema } from '../../shared/domain/source-statement.ts';
import { GatewayProviderAccountRefSchema } from '../../shared/domain/psp-configuration.ts';
import { operationRequestedPayloadOf, refundMaterialRequest } from '../../src/domain/refund-admission.ts';
import { GatewayBindingResolverLive } from '../../src/integrations/psp/binding-resolver-live.ts';
import { ProviderDispatchLedgerLive } from '../../src/integrations/psp/dispatch-ledger-live.ts';
import { ProviderEvidenceStoreLive } from '../../src/integrations/psp/evidence-store-live.ts';
import {
  ProviderEvidenceSubmissionTransport,
  ProviderEvidenceSubmitterLive,
} from '../../src/integrations/psp/evidence-submission-live.ts';
import { executeGatewayOperation } from '../../src/integrations/psp/gateway-operation-executor.ts';
import { ProviderNotificationStoreLive } from '../../src/integrations/psp/notification-store-live.ts';
import { ProviderNotificationIdSchema } from '../../src/integrations/psp/notification-store.ts';
import {
  processProviderNotification,
  ProviderNotificationProcessingSchema,
} from '../../src/integrations/psp/provider-notification-processor.ts';
import type { ProviderNotificationProcessing } from '../../src/integrations/psp/provider-notification-processor.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import type { GatewayProviderAdaptersContract } from '../../src/integrations/psp/psp-adapter.ts';
import { ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import type { ProviderObjectRef } from '../../src/integrations/psp/psp-request.ts';
import { paymentEvidencePersistenceForTransaction } from '../../src/persistence/payment-evidence-persistence.ts';
import { paymentSourcePersistenceForTransaction } from '../../src/persistence/payment-source-persistence.ts';
import {
  COMPOSITION_REVISION,
  collectInput,
  inScope,
  newPaymentInput,
  operationalScopeOf,
  provenanceFor,
  randomUuid,
  withPersistence,
} from '../integration/database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from '../integration/database-fixture.ts';
import { configuredRefundExecutionRouteFor } from './refund-execution-route.fixture.ts';

export type NativeFamily = typeof PaymentGatewayProviderFamilySchema.Type;
type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

export const NATIVE_RETURN_URL = 'https://shop.example.test/return';
const NOTIFICATION_URL = 'https://hooks.example.test/psp';
const CUSTOMER_CONFIGURATION_ID = 'customer-configuration-1';
const MERCHANT_IDENTITY_DOCUMENTS = {
  COMGATE: '{"_tag":"COMGATE","merchantId":"123456"}',
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<NativeFamily, string>;

export interface NativeHarness {
  readonly crypto: { draws: number };
  readonly database: PaymentTestDatabase;
  readonly runtimeClient: PgClient.PgClient;
  readonly scope: PaymentTestScope;
}

/** The test builds its database and scope (Core test constructors) and hands them in. */
export const nativeHarnessOf = (
  database: PaymentTestDatabase,
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
): NativeHarness => ({ crypto: { draws: 0 }, database, runtimeClient, scope });

export interface NativeBinding {
  readonly bindingId: string;
  readonly executionBinding: Extract<PaymentExecutionBinding, { readonly _tag: 'GATEWAY_ACCOUNT' }>;
}

/**
 * One CURRENT SANDBOX binding with its ACTIVE credential revision naming `secretRef`, and the Gateway Enablement
 * of the test Customer Configuration (its return URL), as the configuration Actions write them.
 */
export const nativeBindingFor = Effect.fn('PspNativeGateway.binding')(function* nativeBindingFor(
  harness: NativeHarness,
  family: NativeFamily,
  secretRef: string,
) {
  const [refSeed, bindingId] = yield* Effect.all([randomUuid, randomUuid], { concurrency: 1 });
  const accountRef = yield* Schema.decodeEffect(GatewayProviderAccountRefSchema)(`pab_${refSeed.replaceAll('-', '')}`);
  const { runtimeClient, scope } = harness;
  const common = [scope.tenantId, scope.legalEntityId, scope.principalId, COMPOSITION_REVISION, bindingId];
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
          [...common, MERCHANT_IDENTITY_DOCUMENTS[family], NOTIFICATION_URL, accountRef, family],
        ),
        runtimeClient.unsafe(
          `insert into payment.psp_credential_revisions (tenant_id, legal_entity_id, action_invocation_id,
             actor_principal_id, composition_revision, binding_id, recorded_at, revision, secret_ref, status)
           values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, $6, 'ACTIVE')`,
          [...common, secretRef],
        ),
        runtimeClient.unsafe(
          `insert into payment.psp_gateway_enablements (tenant_id, legal_entity_id, action_invocation_id,
             actor_principal_id, composition_revision, binding_id, configured_at, customer_configuration_id, enabled,
             environment, provider_family, reason, return_url, revision)
           values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), $6, true, 'SANDBOX', $7,
             'Enable the sandbox gateway', $8, 1)`,
          [...common, CUSTOMER_CONFIGURATION_ID, family, NATIVE_RETURN_URL],
        ),
      ],
      { concurrency: 1 },
    ),
  );
  return {
    bindingId,
    executionBinding: {
      _tag: 'GATEWAY_ACCOUNT',
      environment: 'SANDBOX',
      providerAccountRef: accountRef,
      providerFamily: family,
    },
  } satisfies NativeBinding;
});

const payloadFor = (harness: NativeHarness, paymentId: string, operationId: string) =>
  withPersistence(harness.database, harness.scope, (persistence) => persistence.loadAggregate(paymentId)).pipe(
    Effect.flatMap((aggregate) =>
      Effect.fromOption(Option.fromUndefinedOr(aggregate.operations.find((op) => op.operationId === operationId))).pipe(
        Effect.map((operation) => operationRequestedPayloadOf(aggregate, operation)),
      ),
    ),
  );

/** A gateway Payment with its COLLECT, and the operation-requested payload exactly as A4 builds it. */
export const nativeCollectionFor = Effect.fn('PspNativeGateway.collection')(function* nativeCollectionFor(
  harness: NativeHarness,
  binding: NativeBinding,
  amountMinor: number,
) {
  const { database, scope } = harness;
  const paymentInput = yield* newPaymentInput(scope, amountMinor);
  const created = yield* withPersistence(database, scope, (persistence) =>
    persistence.insertPayment({ ...paymentInput, executionBinding: binding.executionBinding }),
  );
  const { paymentId } = created.record;
  const request = yield* collectInput(scope, { amountMinor, paymentId }, 'collect-1');
  const collected = yield* withPersistence(database, scope, (persistence) =>
    persistence.insertOperation({ ...request, binding: binding.executionBinding }),
  );
  return yield* payloadFor(harness, paymentId, collected.record.operationId);
});

/**
 * Stands in for Payment's A8 transition of a proven collection, then admits one REFUND of `amountMinor` on the
 * original binding with a single-item basis, with the payload A7 builds.
 */
export const nativeRefundFor = Effect.fn('PspNativeGateway.refund')(function* nativeRefundFor(
  harness: NativeHarness,
  binding: NativeBinding,
  collection: OutboxPayload,
  amountMinor: number,
) {
  const { database, scope } = harness;
  const amount = { amountMinor, currency: 'CZK' } as const;
  const [confirm, provenance, basis, refundExecutionRoute] = yield* Effect.all(
    [
      provenanceFor(scope),
      provenanceFor(scope),
      Schema.decodeUnknownEffect(PaymentRefundBasisSchema)({
        _tag: 'REFUNDABLE_ITEMS',
        items: [{ amountMinor, currency: 'CZK', itemRef: 'A', sourceEvidenceRef: 'order:item:A' }],
      }),
      configuredRefundExecutionRouteFor(database, scope, binding.executionBinding),
    ],
    { concurrency: 1 },
  );
  yield* withPersistence(database, scope, (persistence) =>
    persistence.transitionOperationOutcome({
      causedBy: { kind: 'OBSERVATION', sourceId: 'observation:native-notification' },
      expectedOutcomeRevision: 1,
      operationId: collection.operationId,
      paymentId: collection.paymentId,
      provenance: confirm,
      to: 'EFFECT_CONFIRMED',
    }),
  );
  const created = yield* withPersistence(database, scope, (persistence) =>
    persistence.insertOperation({
      amount,
      binding: binding.executionBinding,
      initialOutcome: 'PENDING',
      kind: 'REFUND',
      materialRequest: refundMaterialRequest({ amount, basis, reason: 'Returned goods' }),
      operationKey: 'refund-A',
      paymentId: collection.paymentId,
      provenance,
      refundBasis: basis,
      refundExecutionRoute,
      targetOperationId: collection.operationId,
    }),
  );
  const payload = yield* payloadFor(harness, collection.paymentId, created.record.operationId);
  return {
    ...payload,
    refundBasis: basis,
    refundExecutionRoute,
    targetOperationId: collection.operationId,
  } satisfies OutboxPayload;
});

// -------------------------------------------------------------------------------------------------
// Worker runtime: one Core-scoped transaction per legal-entity step
// -------------------------------------------------------------------------------------------------

const NO_COMPLETION: OutboxWorkerLegalEntityScope['completionPublisher'] = {
  publish: () => Effect.die('These gateway workers publish no completion'),
};

const scopeUnavailable = (cause: unknown) =>
  new OutboxWorkerLegalEntityScopeError({
    cause,
    code: 'outbox_worker_scope_unavailable',
    reason: 'The test legal-entity scope is unavailable',
    retryable: true,
  });

const workerScopeOf = (scope: PaymentTestScope, routineInvoker: OutboxWorkerLegalEntityScope['routineInvoker']) => ({
  completionPublisher: NO_COMPLETION,
  legalEntityId: scope.legalEntityId,
  routineInvoker,
  tenantId: scope.tenantId,
});

const fanoutOf = (harness: NativeHarness) =>
  Layer.succeed(OutboxWorkerLegalEntityScopeFanout, {
    forEachScope: (_context, observe) =>
      harness.database
        .transaction((transaction) =>
          installOperationalScope(transaction, operationalScopeOf(harness.scope)).pipe(
            Effect.mapError(scopeUnavailable),
            Effect.flatMap((routineInvoker) => observe(workerScopeOf(harness.scope, routineInvoker))),
          ),
        )
        .pipe(Effect.mapError((failure) => (Schema.is(SqlError)(failure) ? scopeUnavailable(failure) : failure))),
  });

/** Distinct deterministic bytes per draw, so every return token of a scope is unique. */
const testCryptoOf = (seed: { draws: number }) =>
  Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      digest: (_algorithm, data) => Effect.succeed(data),
      randomBytes: (size) => {
        seed.draws += 1;
        return new Uint8Array(size).fill(seed.draws % 256);
      },
    }),
  );

const workerContextOf = (scope: PaymentTestScope, workerKey: string, topic: string) =>
  Effect.all([randomUuid, randomUuid, randomUuid], { concurrency: 1 }).pipe(
    Effect.map(([deliveryId, invocationId, messageId]): OutboxWorkerHandlerContext => ({
      attemptNumber: 1,
      claimId: messageId,
      compositionRevision: COMPOSITION_REVISION,
      consumerModuleKey: 'payment.core',
      deliveryId,
      domainEventId: messageId,
      legalEntityScope: 'required',
      messageId,
      originatorInvocationId: invocationId,
      producerModuleKey: 'payment.core',
      tenantId: scope.tenantId,
      tenantSequenceNo: 1n,
      topic,
      workerKey,
    })),
  );

const adaptersLayer = (adapters: GatewayProviderAdaptersContract) => Layer.succeed(GatewayProviderAdapters, adapters);

/** One execution delivery of `payload` through the production executor and the given adapters. */
export const deliverExecution = (
  harness: NativeHarness,
  payload: OutboxPayload,
  adapters: GatewayProviderAdaptersContract,
) =>
  Effect.gen(function* executionDelivery() {
    const context = yield* workerContextOf(
      harness.scope,
      'payment.core.execute-gateway-operation',
      'payment.core.operation-requested.v1',
    );
    return yield* Effect.exit(executeGatewayOperation(payload, context)).pipe(
      Effect.provide(
        Layer.mergeAll(
          fanoutOf(harness),
          GatewayBindingResolverLive,
          adaptersLayer(adapters),
          ProviderDispatchLedgerLive,
          ProviderEvidenceStoreLive,
          testCryptoOf(harness.crypto),
        ),
      ),
    );
  });

// -------------------------------------------------------------------------------------------------
// Native reads
// -------------------------------------------------------------------------------------------------

interface DispatchRow extends Record<string, unknown> {
  readonly not_sent_reason: string | null;
  readonly provider_payment_ref: string | null;
  readonly state: string;
}

export const dispatchStateOf = (harness: NativeHarness, operationId: string) =>
  inScope(
    harness.runtimeClient,
    harness.scope,
    harness.runtimeClient.unsafe<DispatchRow>(
      `select state, not_sent_reason, provider_payment_ref from payment.psp_provider_dispatches where operation_id = $1`,
      [operationId],
    ),
  ).pipe(
    Effect.map((rows) =>
      Option.fromUndefinedOr(rows[0]).pipe(
        Option.map((row) => [row.state, row.not_sent_reason, row.provider_payment_ref] as const),
      ),
    ),
  );

interface EvidenceRow extends Record<string, unknown> {
  readonly fact_kind: string;
  readonly operation_id: string;
  readonly submission_state: string;
}

export const evidenceOf = (harness: NativeHarness, paymentId: string) =>
  inScope(
    harness.runtimeClient,
    harness.scope,
    harness.runtimeClient.unsafe<EvidenceRow>(
      `select operation_id::text, fact_kind, submission_state from payment.psp_provider_evidence
        where payment_id = $1 order by recorded_at, fact_kind`,
      [paymentId],
    ),
  ).pipe(Effect.map((rows) => rows.map((row) => [row.operation_id, row.fact_kind, row.submission_state] as const)));

// -------------------------------------------------------------------------------------------------
// Notification capture row and processing
// -------------------------------------------------------------------------------------------------

/** A captured, signature-verified Stripe event row exactly as the capture Action stores it. */
export const capturedStripeNotification = Effect.fn('PspNativeGateway.capture')(function* capturedStripeNotification(
  harness: NativeHarness,
  binding: NativeBinding,
  input: {
    readonly body: string;
    readonly eventId: string;
    readonly receivedAt: string;
    readonly refs: readonly ProviderObjectRef[];
  },
) {
  const { runtimeClient, scope } = harness;
  const refs = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ProviderObjectRefSchema)))(input.refs);
  const rows = yield* inScope(
    runtimeClient,
    scope,
    runtimeClient.unsafe<{ notification_id: string }>(
      `insert into payment.psp_provider_notifications (tenant_id, legal_entity_id, action_invocation_id,
         actor_principal_id, composition_revision, authenticity, binding_id, delivery_identity, environment, headers,
         provider_account_ref, provider_family, provider_refs, query, raw_body, received_at, state,
         transport_delivery_ref, verified_at, provider_occurrence_id)
       values ($1, $2, gen_random_uuid(), $3, $4, 'SIGNATURE_VERIFIED', $5, $6, 'SANDBOX', '{}'::jsonb, $7, 'STRIPE',
         $8::jsonb, '{}'::jsonb, convert_to($9, 'UTF8'), $10::timestamptz, 'CAPTURED', 'relay-delivery-1',
         $10::timestamptz, $6)
       returning notification_id`,
      [
        scope.tenantId,
        scope.legalEntityId,
        scope.principalId,
        COMPOSITION_REVISION,
        binding.bindingId,
        `stripe:evt:${input.eventId}`,
        binding.executionBinding.providerAccountRef,
        refs,
        input.body,
        input.receivedAt,
      ],
    ),
  );
  return yield* Schema.decodeUnknownEffect(ProviderNotificationIdSchema)(rows[0]?.notification_id);
});

const issuedGrantOf = () => {
  const issued = Schema.decodeUnknownSync(GatewayContextResponseSchema)({
    apiBaseUrl: '/payment-api',
    compositionRevision: COMPOSITION_REVISION,
    expiresAt: 1_762_934_460,
    machineContext: {
      authContextRef: 'job:payment.core.process-provider-notification:run:delivery',
      bindingIncarnation: 'abababab-abab-4bab-8bab-abababababab',
      principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    },
    token: 'native-test-assertion',
  });
  return {
    apiBaseUrl: `http://shell.test${issued.apiBaseUrl}`,
    authorization: `Bearer ${issued.token}` as const,
    compositionRevision: issued.compositionRevision,
    expiresAt: issued.expiresAt,
    machineContext: issued.machineContext,
  };
};

/** An absent optional input of the persistence contract (its keys are required, its values may be absent). */
const notGiven = <Value>(): Value | undefined => Option.getOrUndefined(Option.none<Value>());

/**
 * Stands in for the receiving A8 Action's committed acceptance: a real Payment observation under an ACTIVE
 * PAYMENT_GATEWAY authority, so the evidence row can reference what A8 recorded.
 */
const recordAcceptedObservation = (harness: NativeHarness, payload: AcceptPaymentObservationPayload) =>
  harness.database.transaction((transaction: PaymentTestTransaction) =>
    Effect.gen(function* acceptObservation() {
      const { scope } = harness;
      const scoped = yield* installOperationalScope(transaction, operationalScopeOf(scope));
      const sources = paymentSourcePersistenceForTransaction(
        scoped,
        scope,
        paymentEvidencePersistenceForTransaction(scoped),
      );
      const provenance = yield* provenanceFor(scope);
      const configured = yield* sources.configureAuthority({
        expectedRevision: notGiven(),
        factFamily: payload.factFamily,
        method: notGiven(),
        provenance,
        reason: 'Gateway outcomes of the test account',
        refundRoute: false,
        source: payload.source,
        status: 'ACTIVE',
        submitterPrincipalIds: [scope.principalId],
      });
      const amount = yield* Schema.decodeUnknownEffect(PaymentMonetaryAmountSchema)(payload.amount);
      const receivedAt = payload.receivedAt ?? (yield* DateTime.now);
      return yield* sources.insertObservation({
        acceptanceOutcome: 'ACCEPTED_OBSERVATION',
        amount,
        authority: configured.authority,
        capabilityCorrelated: notGiven(),
        correctsObservationId: notGiven(),
        economicEffectKey: payload.economicEffectKey,
        evidenceRef: notGiven(),
        factFamily: payload.factFamily,
        factKind: payload.factKind,
        operationId: payload.operationId,
        paymentId: payload.paymentId,
        provenance,
        receivedAt,
        source: payload.source,
        sourceOccurredAt: notGiven(),
        sourceOccurrenceId: payload.sourceOccurrenceId,
        sourceRevision: payload.sourceRevision,
        statementHash: 'e'.repeat(64),
        verifiedAt: receivedAt,
      });
    }),
  );

const summaryOf = (result: ProviderNotificationProcessing) =>
  ProviderNotificationProcessingSchema.match(result, {
    ALREADY_PROCESSED: ({ state }) => `ALREADY_PROCESSED ${state}`,
    HELD_UNCORRELATED: ({ reason }) => `HELD_UNCORRELATED ${reason}`,
    NOT_FOUND: () => 'NOT_FOUND',
    SETTLED: ({ operationId, outcomes, state }) => `SETTLED ${operationId} ${state} [${outcomes.join(',')}]`,
    SUBMISSION_PENDING: ({ operationId, reason }) => `SUBMISSION_PENDING ${operationId} ${reason}`,
  });

const storesLayer = Layer.mergeAll(
  ProviderDispatchLedgerLive,
  ProviderNotificationStoreLive,
  GatewayBindingResolverLive,
  ProviderEvidenceSubmitterLive,
).pipe(Layer.provideMerge(ProviderEvidenceStoreLive), Layer.provide(nodeCryptoLayer));

/**
 * Processes one captured notification in a fresh worker delivery through the production processor and the given
 * adapters. A8 is the stand-in above (accepted), reached through the production submitter.
 */
export const processNotification = (
  harness: NativeHarness,
  notificationId: typeof ProviderNotificationIdSchema.Type,
  adapters: GatewayProviderAdaptersContract,
) =>
  Effect.gen(function* processNotificationEffect() {
    const statements = yield* Ref.make<readonly AcceptPaymentObservationPayload[]>([]);
    const grant = issuedGrantOf();
    const transport = {
      acquire: () => Effect.succeed(grant),
      execute: (payload: AcceptPaymentObservationPayload) =>
        Ref.update(statements, (all) => [...all, payload]).pipe(
          Effect.andThen(recordAcceptedObservation(harness, payload)),
          Effect.flatMap((observationId) =>
            Schema.decodeUnknownEffect(PaymentSourceStatementResultSchema)({
              acceptanceOutcome: 'ACCEPTED_OBSERVATION',
              interpretation: 'TRANSITION',
              observationId,
              operationId: payload.operationId,
              paymentId: payload.paymentId,
              sourceAuthorityId: '99999999-9999-4999-8999-999999999999',
            }),
          ),
          Effect.orDie,
        ),
    };
    const workerContext = yield* workerContextOf(
      harness.scope,
      'payment.core.process-provider-notification',
      'payment.core.provider-notification-captured.v1',
    );
    const result = yield* harness.database
      .transaction((transaction: PaymentTestTransaction) =>
        installOperationalScope(transaction, operationalScopeOf(harness.scope)).pipe(
          Effect.flatMap((invoker) =>
            processProviderNotification({
              notificationId,
              scope: workerScopeOf(harness.scope, invoker),
              workerContext,
            }),
          ),
        ),
      )
      .pipe(
        Effect.provide(Layer.merge(storesLayer, adaptersLayer(adapters))),
        Effect.provideService(ProviderEvidenceSubmissionTransport, transport),
      );
    return { result: summaryOf(result), statements: yield* Ref.get(statements) };
  });

import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { GatewayContextResponseSchema } from '@app/shared-contracts';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import type { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Layer, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { AcceptPaymentObservationActionForbiddenProblemSchema } from '../../shared/apis/accept-payment-observation-action.ts';
import type { AcceptPaymentObservationPayload } from '../../shared/actions/accept-payment-observation.ts';
import { PaymentMonetaryAmountSchema } from '../../shared/domain/payment-money.ts';
import { PaymentSourceStatementResultSchema } from '../../shared/domain/source-statement.ts';
import {
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
} from '../../shared/domain/psp-configuration.ts';
import type { GatewayEnvironment } from '../../shared/domain/psp-vocabulary.ts';
import { GatewayBindingResolverLive } from '../../src/integrations/psp/binding-resolver-live.ts';
import { ProviderDispatchLedgerLive } from '../../src/integrations/psp/dispatch-ledger-live.ts';
import { ProviderDispatchLedger } from '../../src/integrations/psp/dispatch-ledger.ts';
import type { ProviderDispatchIdentity } from '../../src/integrations/psp/dispatch-ledger.ts';
import { ProviderEvidenceStoreLive } from '../../src/integrations/psp/evidence-store-live.ts';
import {
  ProviderEvidenceSubmissionTransport,
  ProviderEvidenceSubmitterLive,
} from '../../src/integrations/psp/evidence-submission-live.ts';
import { ProviderNotificationStoreLive } from '../../src/integrations/psp/notification-store-live.ts';
import {
  ProviderNotificationIdSchema,
  ProviderNotificationStore,
} from '../../src/integrations/psp/notification-store.ts';
import {
  processProviderNotification,
  ProviderNotificationProcessingSchema,
} from '../../src/integrations/psp/provider-notification-processor.ts';
import type { ProviderNotificationProcessing } from '../../src/integrations/psp/provider-notification-processor.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayExecutionTargetSchema, ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import type { GatewayLookupRequest, ProviderObjectRef } from '../../src/integrations/psp/psp-request.ts';
import { PreparedProviderRequestSchema, ProviderFindingResultSchema } from '../../src/integrations/psp/psp-result.ts';
import type { ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import { paymentEvidencePersistenceForTransaction } from '../../src/persistence/payment-evidence-persistence.ts';
import { paymentSourcePersistenceForTransaction } from '../../src/persistence/payment-source-persistence.ts';
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

/**
 * #1156 #1157 Notification processing on the native Payment database: the real scoped routines of the ledger,
 * evidence and notification stores and the real worker binding resolver, inside one Core-scoped worker
 * transaction. Only the provider lookup and the two remote hops of the governed A8 submission (Shell gateway,
 * A8 client) are replaced; the RegisteredWorkload issuance itself is proven by the Shell probe.
 */

type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

const WORKER_KEY = 'payment.core.process-provider-notification';
const NOTIFICATION_URL = 'https://hooks.example.test/psp';
const RECEIVED_AT = '2026-11-12T09:00:00.000Z';
const OBSERVED_AT = '2026-11-12T09:00:05.000Z';
const STRIPE_IDENTITY = '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}';
const AMOUNT = { amountMinor: 100_000, currency: 'CZK' } as const;

const storesLayer = Layer.mergeAll(
  ProviderDispatchLedgerLive,
  ProviderNotificationStoreLive,
  GatewayBindingResolverLive,
  ProviderEvidenceSubmitterLive,
).pipe(Layer.provideMerge(ProviderEvidenceStoreLive), Layer.provide(nodeCryptoLayer));

const NO_COMPLETION: OutboxWorkerLegalEntityScope['completionPublisher'] = {
  publish: () => Effect.die('Notification processing publishes no completion'),
};

const deliveryOf = (scope: PaymentTestScope) =>
  Effect.all([randomUuid, randomUuid, randomUuid], { concurrency: 1 }).pipe(
    Effect.map(([deliveryId, invocationId, messageId]): OutboxWorkerHandlerContext => ({
      attemptNumber: 1,
      claimId: messageId,
      compositionRevision: COMPOSITION_REVISION,
      consumerModuleKey: 'payment.core',
      deliveryId,
      domainEventId: messageId,
      messageId,
      originatorInvocationId: invocationId,
      producerModuleKey: 'payment.core',
      tenantId: scope.tenantId,
      tenantSequenceNo: 1n,
      topic: 'payment.core.provider-notification-captured.v1',
      workerKey: WORKER_KEY,
    })),
  );

/** One worker call in its own Core-scoped runtime transaction: only the routine invoker, no executor. */
const inWorker = <Value, Failure, Requirements>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  call: (worker: {
    readonly scope: OutboxWorkerLegalEntityScope;
    readonly workerContext: OutboxWorkerHandlerContext;
  }) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* workerCall() {
    const workerContext = yield* deliveryOf(scope);
    return yield* database.transaction((transaction: PaymentTestTransaction) =>
      installOperationalScope(transaction, operationalScopeOf(scope)).pipe(
        Effect.flatMap((invoker) =>
          call({
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
  });

interface BindingFixture {
  readonly accountRef: string;
  readonly bindingId: string;
  readonly environment: GatewayEnvironment;
}

/** One CURRENT Stripe binding with its ACTIVE credential, as the configuration Action writes it. */
const stripeBinding = Effect.fn('PspNotificationFixture.binding')(function* stripeBinding(
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  environment: GatewayEnvironment,
) {
  const [refSeed, bindingSeed] = yield* Effect.all([randomUuid, randomUuid], { concurrency: 1 });
  const accountRef = yield* Schema.decodeEffect(GatewayProviderAccountRefSchema)(`pab_${refSeed.replaceAll('-', '')}`);
  const bindingId = yield* Schema.decodeEffect(GatewayProviderAccountBindingIdSchema)(bindingSeed);
  yield* inScope(
    runtimeClient,
    scope,
    Effect.all(
      [
        runtimeClient.unsafe(
          `insert into payment.psp_provider_account_bindings (tenant_id, legal_entity_id, action_invocation_id,
             actor_principal_id, composition_revision, binding_id, configured_at, current_credential_revision,
             environment, merchant_identity, notification_url, provider_account_ref, provider_family, reason, revision, status)
           values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, $6, $7::jsonb, $8, $9, 'STRIPE',
             'Configure the gateway account', 1, 'CURRENT')`,
          [
            scope.tenantId,
            scope.legalEntityId,
            scope.principalId,
            COMPOSITION_REVISION,
            bindingId,
            environment,
            STRIPE_IDENTITY,
            NOTIFICATION_URL,
            accountRef,
          ],
        ),
        runtimeClient.unsafe(
          `insert into payment.psp_credential_revisions (tenant_id, legal_entity_id, action_invocation_id,
             actor_principal_id, composition_revision, binding_id, recorded_at, revision, secret_ref, status)
           values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, 'stripe-credential-1', 'ACTIVE')`,
          [scope.tenantId, scope.legalEntityId, scope.principalId, COMPOSITION_REVISION, bindingId],
        ),
      ],
      { concurrency: 1 },
    ),
  );
  return { accountRef, bindingId, environment } satisfies BindingFixture;
});

/** A Payment with one gateway COLLECT on the binding, prepared through the live ledger. */
const preparedCollect = Effect.fn('PspNotificationFixture.collect')(function* preparedCollect(
  runtime: PaymentTestDatabase,
  scope: PaymentTestScope,
  binding: BindingFixture,
) {
  const executionBinding = {
    _tag: 'GATEWAY_ACCOUNT',
    environment: binding.environment,
    providerAccountRef: binding.accountRef,
    providerFamily: 'STRIPE',
  } as const;
  const paymentInput = yield* newPaymentInput(scope);
  const created = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertPayment({ ...paymentInput, executionBinding }),
  );
  const { paymentId } = created.record;
  const request = yield* collectInput(scope, { amountMinor: AMOUNT.amountMinor, paymentId }, 'collect-1');
  const collected = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertOperation({ ...request, binding: executionBinding }),
  );
  const target = yield* Schema.decodeUnknownEffect(GatewayExecutionTargetSchema)({
    binding: executionBinding,
    bindingId: binding.bindingId,
    credentialRevision: 1,
    credentialSecretRef: 'stripe-credential-1',
    legalEntityId: scope.legalEntityId,
    merchantIdentity: { _tag: 'STRIPE', accountId: 'acct_1TestAccount' },
    notificationUrl: NOTIFICATION_URL,
    returnUrl: Option.none(),
    tenantId: scope.tenantId,
  });
  const identity: ProviderDispatchIdentity = {
    materialHash: collected.record.materialHash,
    operationId: collected.record.operationId,
    operationKind: 'COLLECT',
    paymentId,
    target,
    targetOperationId: Option.none(),
  };
  const { idempotencyKey, orderReference } = deriveProviderCorrelation(identity.operationId);
  const prepared = yield* Schema.decodeUnknownEffect(PreparedProviderRequestSchema)({
    body: new TextEncoder().encode(`operation=${identity.operationId}&amount=100000`),
    endpointRef: 'stripe:POST:/v1/checkout/sessions',
    family: 'STRIPE',
    headers: [
      { name: 'content-type', value: 'application/x-www-form-urlencoded' },
      { name: 'idempotency-key', value: idempotencyKey },
    ],
    idempotencyKey: Option.some(idempotencyKey),
    orderReference,
    replayWindowMs: Option.some(86_400_000),
    requestHash: 'a'.repeat(64),
  });
  yield* inWorker(runtime, scope, ({ scope: worker, workerContext }) =>
    Effect.service(ProviderDispatchLedger).pipe(
      Effect.flatMap((ledger) =>
        ledger.prepare({ identity, prepared, returnToken: Option.none(), scope: worker, workerContext }),
      ),
    ),
  ).pipe(Effect.provide(storesLayer));
  return identity;
});

/** A captured Stripe event row as the capture Action stores it (provenance of the capture Action). */
const captureNotification = (
  runtimeClient: PgClient.PgClient,
  scope: PaymentTestScope,
  binding: BindingFixture,
  input: { readonly body: string; readonly eventId: string; readonly refs: readonly ProviderObjectRef[] },
) =>
  Effect.gen(function* capture() {
    const refs = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ProviderObjectRefSchema)))(input.refs);
    const rows = yield* inScope(
      runtimeClient,
      scope,
      runtimeClient.unsafe<{ notification_id: string }>(
        `insert into payment.psp_provider_notifications (tenant_id, legal_entity_id, action_invocation_id,
           actor_principal_id, composition_revision, authenticity, binding_id, delivery_identity, environment, headers,
           provider_account_ref, provider_family, provider_refs, query, raw_body, received_at, state,
           transport_delivery_ref, verified_at, provider_occurrence_id)
         values ($1, $2, gen_random_uuid(), $3, $4, 'SIGNATURE_VERIFIED', $5, $6, $7, '{}'::jsonb, $8, 'STRIPE',
           $9::jsonb, '{}'::jsonb, convert_to($10, 'UTF8'), $11::timestamptz, 'CAPTURED', 'relay-delivery-1',
           $11::timestamptz, $6)
         returning notification_id`,
        [
          scope.tenantId,
          scope.legalEntityId,
          scope.principalId,
          COMPOSITION_REVISION,
          binding.bindingId,
          `stripe:evt:${input.eventId}`,
          binding.environment,
          binding.accountRef,
          refs,
          input.body,
          RECEIVED_AT,
        ],
      ),
    );
    return yield* Schema.decodeUnknownEffect(ProviderNotificationIdSchema)(rows[0]?.notification_id);
  });

const confirmedFinding = (operationId: string, ref: ProviderObjectRef) =>
  Schema.decodeUnknownEffect(ProviderFindingResultSchema)({
    customerAction: Option.none(),
    evidence: Option.some({
      discrepancy: Option.none(),
      economicEffectKey: Option.some('pi_native_notification'),
      factFamily: 'GATEWAY_OUTCOME',
      factKind: 'COLLECTION_CONFIRMED',
      observedAmount: Option.some(AMOUNT),
      observedAt: DateTime.makeUnsafe(OBSERVED_AT),
      providerOccurredAt: Option.none(),
      providerRefs: [ref],
      reason: Option.none(),
      sourceOccurrenceId: `stripe:notification_lookup:pi_native_notification:${operationId}:COLLECTION_CONFIRMED:100000`,
      sourceRevision: 0,
    }),
    finding: 'EFFECT_CONFIRMED',
    orderReference: Option.some(
      deriveProviderCorrelation(
        Schema.decodeUnknownSync(ProviderFindingResultSchema.fields.target.fields.operationId)(operationId),
      ).orderReference,
    ),
    providerRefs: [ref],
    target: { operationId, operationKind: 'COLLECT' },
  });

const sameRef = Schema.toEquivalence(ProviderObjectRefSchema);

const unexpected = (name: string) => () => Effect.die(`${name} is not used by notification processing`);

const issuedContext = Schema.decodeUnknownSync(GatewayContextResponseSchema)({
  apiBaseUrl: '/payment-api',
  compositionRevision: COMPOSITION_REVISION,
  expiresAt: 1_762_934_460,
  machineContext: {
    authContextRef: `job:${WORKER_KEY}:run:delivery`,
    bindingIncarnation: 'abababab-abab-4bab-8bab-abababababab',
    principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  },
  token: 'native-test-assertion',
});
const { machineContext: issuedMachineContext } = issuedContext;
const issuedGrant = {
  apiBaseUrl: `http://shell.test${issuedContext.apiBaseUrl}`,
  authorization: `Bearer ${issuedContext.token}` as const,
  compositionRevision: issuedContext.compositionRevision,
  expiresAt: issuedContext.expiresAt,
  machineContext: issuedMachineContext,
};

const A8ModeSchema = Schema.Literals(['ACCEPT', 'SOURCE_FORBIDDEN']);
type A8Mode = typeof A8ModeSchema.Type;

const sourceForbidden = Schema.decodeUnknownSync(AcceptPaymentObservationActionForbiddenProblemSchema)({
  _tag: 'AcceptPaymentObservationActionForbiddenProblem',
  code: 'payment_source_authority_forbidden',
  detail: 'No configured source authority',
  status: 403,
  title: 'Forbidden',
  type: 'about:blank',
});

const summaryOf = (result: ProviderNotificationProcessing) =>
  ProviderNotificationProcessingSchema.match(result, {
    ALREADY_PROCESSED: ({ state }) => `ALREADY_PROCESSED ${state}`,
    HELD_UNCORRELATED: ({ reason }) => `HELD_UNCORRELATED ${reason}`,
    NOT_FOUND: () => 'NOT_FOUND',
    SETTLED: ({ operationId, outcomes, state }) => `SETTLED ${operationId} ${state} [${outcomes.join(',')}]`,
    SUBMISSION_PENDING: ({ operationId, reason }) => `SUBMISSION_PENDING ${operationId} ${reason}`,
  });

/** An absent optional input of the persistence contract (its keys are required, its values may be absent). */
const notGiven = <Value>(): Value | undefined => Option.getOrUndefined(Option.none<Value>());

/**
 * Stands in for the receiving A8 Action's committed acceptance: a real Payment observation under an ACTIVE
 * PAYMENT_GATEWAY authority, so the evidence row can reference what A8 recorded (FK to `payment.observations`).
 */
const recordAcceptedObservation = (
  runtime: PaymentTestDatabase,
  scope: PaymentTestScope,
  payload: AcceptPaymentObservationPayload,
) =>
  runtime.transaction((transaction: PaymentTestTransaction) =>
    Effect.gen(function* acceptObservation() {
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
      const receivedAt = payload.receivedAt ?? DateTime.makeUnsafe(RECEIVED_AT);
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

/** Processes one notification in a fresh worker delivery with scripted lookup findings and A8 answers. */
const processNative = (
  runtime: PaymentTestDatabase,
  scope: PaymentTestScope,
  input: {
    readonly a8: A8Mode;
    readonly findings: (
      request: GatewayLookupRequest,
    ) => Effect.Effect<readonly ProviderFindingResult[], Schema.SchemaError>;
    readonly notificationId: typeof ProviderNotificationIdSchema.Type;
  },
) =>
  Effect.gen(function* processNotification() {
    const lookups = yield* Ref.make<readonly GatewayLookupRequest[]>([]);
    const statements = yield* Ref.make<readonly AcceptPaymentObservationPayload[]>([]);
    const recordLookup = (request: GatewayLookupRequest) =>
      Ref.update(lookups, (all) => [...all, request]).pipe(Effect.andThen(input.findings(request)), Effect.orDie);
    const adapters = Layer.succeed(GatewayProviderAdapters, {
      forFamily: () =>
        Effect.succeed({
          capabilities: {
            CANCEL_OR_VOID: 'SUPPORTED',
            COLLECT: 'SUPPORTED',
            NOTIFICATION: 'SUPPORTED',
            REFUND: 'SUPPORTED',
            RETRIEVE: 'SUPPORTED',
          },
          family: 'STRIPE',
          lookup: (_target, request) => recordLookup(request),
          prepareCancel: unexpected('prepareCancel'),
          prepareCollect: unexpected('prepareCollect'),
          prepareRefund: unexpected('prepareRefund'),
          replay: unexpected('replay'),
          send: unexpected('send'),
          verifyNotification: unexpected('verifyNotification'),
        }),
    });
    const transport = {
      acquire: () => Effect.succeed(issuedGrant),
      execute: (payload: AcceptPaymentObservationPayload) =>
        Ref.update(statements, (all) => [...all, payload]).pipe(
          Effect.andThen(
            input.a8 === 'SOURCE_FORBIDDEN'
              ? Effect.fail(sourceForbidden)
              : recordAcceptedObservation(runtime, scope, payload).pipe(
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
          ),
        ),
    };
    const result = yield* inWorker(runtime, scope, ({ scope: worker, workerContext }) =>
      processProviderNotification({ notificationId: input.notificationId, scope: worker, workerContext }),
    ).pipe(
      Effect.provide(Layer.merge(storesLayer, adapters)),
      Effect.provideService(ProviderEvidenceSubmissionTransport, transport),
    );
    return {
      lookups: yield* Ref.get(lookups),
      result: summaryOf(result),
      statements: yield* Ref.get(statements),
    };
  });

interface EvidenceRow {
  readonly notification_id: string | null;
  readonly operation_id: string;
  readonly received_at: string;
  readonly submission_state: string;
}

const evidenceRows = (runtimeClient: PgClient.PgClient, scope: PaymentTestScope, bindingId: string) =>
  inScope(
    runtimeClient,
    scope,
    runtimeClient.unsafe<EvidenceRow>(
      `select notification_id::text, operation_id::text, to_char(received_at at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as received_at, submission_state
       from payment.psp_provider_evidence where binding_id = $1 order by recorded_at`,
      [bindingId],
    ),
  );

const notificationRow = (runtimeClient: PgClient.PgClient, scope: PaymentTestScope, notificationId: string) =>
  inScope(
    runtimeClient,
    scope,
    runtimeClient.unsafe<{ correlated_operation_id: string | null; state: string }>(
      `select correlated_operation_id::text, state from payment.psp_provider_notifications where notification_id = $1`,
      [notificationId],
    ),
  ).pipe(Effect.map((rows) => rows[0]));

const signedPaymentIntentBody = (eventId: string, intentId: string, orderReference: string) =>
  `{"id":"${eventId}","object":"event","type":"payment_intent.succeeded","data":{"object":{"id":"${intentId}","object":"payment_intent","metadata":{"ontos_order_reference":"${orderReference}"}}}}`;

it.live('#1157 Create response lost then notification arrives correlates and enables a later refund', () =>
  Effect.scoped(
    Effect.gen(function* lostResponse() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const binding = yield* stripeBinding(runtimeClient, scope, 'SANDBOX');
      const collect = yield* preparedCollect(runtime, scope, binding);
      // The create response was lost: the dispatch is OUTCOME_UNKNOWN and knows no provider object.
      yield* inWorker(runtime, scope, ({ scope: worker, workerContext }) =>
        Effect.service(ProviderDispatchLedger).pipe(
          Effect.flatMap((ledger) =>
            ledger.recordOutcomeUnknown({
              at: DateTime.makeUnsafe(OBSERVED_AT),
              operationId: collect.operationId,
              scope: worker,
              workerContext,
            }),
          ),
        ),
      ).pipe(Effect.provide(storesLayer));
      const intent = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
        _tag: 'STRIPE_PAYMENT_INTENT',
        id: 'pi_native_notification',
      });
      const { orderReference } = deriveProviderCorrelation(collect.operationId);
      const notificationId = yield* captureNotification(runtimeClient, scope, binding, {
        body: signedPaymentIntentBody('evt_native_lost', 'pi_native_notification', orderReference),
        eventId: 'evt_native_lost',
        refs: [intent],
      });

      const processed = yield* processNative(runtime, scope, {
        a8: 'ACCEPT',
        findings: () => Effect.all([confirmedFinding(collect.operationId, intent)]),
        notificationId,
      });

      expect(processed.result).toBe(`SETTLED ${collect.operationId} SUBMITTED [ACCEPTED]`);
      const after = yield* inWorker(runtime, scope, ({ scope: worker }) =>
        Effect.service(ProviderDispatchLedger).pipe(
          Effect.flatMap((ledger) =>
            Effect.all(
              [
                ledger.readByOperation({ operationId: collect.operationId, scope: worker }),
                ledger.readByProviderRef({ bindingId: binding.bindingId, providerRef: intent, scope: worker }),
              ],
              { concurrency: 1 },
            ),
          ),
        ),
      ).pipe(Effect.provide(storesLayer));
      const [byOperation, byRef] = after;
      expect(byOperation.pipe(Option.map(({ state }) => state))).toEqual(Option.some('ACKNOWLEDGED'));
      // A later refund or cancel of this collection now resolves its provider target from the ledger.
      expect(byRef.pipe(Option.map(({ operationId }) => operationId))).toEqual(Option.some(collect.operationId));
      expect(
        byOperation.pipe(
          Option.flatMap(({ providerPaymentRef }) => providerPaymentRef),
          Option.exists((ref) => sameRef(ref, intent)),
        ),
      ).toBe(true);
      // Evidence is linked to the notification and keeps its receipt instant; A8 got the same receipt instant.
      const rows = yield* evidenceRows(runtimeClient, scope, binding.bindingId);
      expect(rows).toEqual([
        {
          notification_id: notificationId,
          operation_id: collect.operationId,
          received_at: RECEIVED_AT,
          submission_state: 'ACCEPTED',
        },
      ]);
      const [statement] = processed.statements;
      expect(Option.map(Option.fromUndefinedOr(statement?.receivedAt), DateTime.formatIso)).toEqual(
        Option.some(RECEIVED_AT),
      );
      expect(yield* notificationRow(runtimeClient, scope, notificationId)).toEqual({
        correlated_operation_id: collect.operationId,
        state: 'SUBMITTED',
      });
    }),
  ),
);

it.live('#1157 Browser-independent: notification alone drives the outcome', () =>
  Effect.scoped(
    Effect.gen(function* browserIndependent() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const binding = yield* stripeBinding(runtimeClient, scope, 'SANDBOX');
      const collect = yield* preparedCollect(runtime, scope, binding);
      const intent = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
        _tag: 'STRIPE_PAYMENT_INTENT',
        id: 'pi_native_notification',
      });
      // No browser return, no return token read: the acknowledged dispatch and one notification suffice.
      yield* inWorker(runtime, scope, ({ scope: worker, workerContext }) =>
        Effect.service(ProviderDispatchLedger).pipe(
          Effect.flatMap((ledger) =>
            ledger.recordAcknowledged({
              customerRedirectUrl: Option.none(),
              operationId: collect.operationId,
              providerPaymentRef: Option.some(intent),
              providerRefundRef: Option.none(),
              respondedAt: DateTime.makeUnsafe(OBSERVED_AT),
              scope: worker,
              workerContext,
            }),
          ),
        ),
      ).pipe(Effect.provide(storesLayer));
      const notificationId = yield* captureNotification(runtimeClient, scope, binding, {
        body: signedPaymentIntentBody('evt_native_alone', 'pi_native_notification', 'f'.repeat(32)),
        eventId: 'evt_native_alone',
        refs: [intent],
      });
      const processed = yield* processNative(runtime, scope, {
        a8: 'ACCEPT',
        findings: () => Effect.all([confirmedFinding(collect.operationId, intent)]),
        notificationId,
      });
      expect(processed.result).toBe(`SETTLED ${collect.operationId} SUBMITTED [ACCEPTED]`);
      expect(processed.statements).toHaveLength(1);
      // A redelivery of the processed notification neither looks up nor submits again.
      const redelivered = yield* processNative(runtime, scope, {
        a8: 'ACCEPT',
        findings: () => Effect.all([confirmedFinding(collect.operationId, intent)]),
        notificationId,
      });
      expect(redelivered.result).toBe('ALREADY_PROCESSED SUBMITTED');
      expect(redelivered.lookups).toEqual([]);
      expect(redelivered.statements).toEqual([]);
    }),
  ),
);

it.live("#1157 Verified notification still needs the receiver's normal write admission", () =>
  Effect.scoped(
    Effect.gen(function* receiverAdmission() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const binding = yield* stripeBinding(runtimeClient, scope, 'SANDBOX');
      const collect = yield* preparedCollect(runtime, scope, binding);
      const intent = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
        _tag: 'STRIPE_PAYMENT_INTENT',
        id: 'pi_native_notification',
      });
      yield* inWorker(runtime, scope, ({ scope: worker, workerContext }) =>
        Effect.service(ProviderDispatchLedger).pipe(
          Effect.flatMap((ledger) =>
            ledger.recordAcknowledged({
              customerRedirectUrl: Option.none(),
              operationId: collect.operationId,
              providerPaymentRef: Option.some(intent),
              providerRefundRef: Option.none(),
              respondedAt: DateTime.makeUnsafe(OBSERVED_AT),
              scope: worker,
              workerContext,
            }),
          ),
        ),
      ).pipe(Effect.provide(storesLayer));
      const notificationId = yield* captureNotification(runtimeClient, scope, binding, {
        body: signedPaymentIntentBody('evt_native_denied', 'pi_native_notification', 'f'.repeat(32)),
        eventId: 'evt_native_denied',
        refs: [intent],
      });
      const processed = yield* processNative(runtime, scope, {
        a8: 'SOURCE_FORBIDDEN',
        findings: () => Effect.all([confirmedFinding(collect.operationId, intent)]),
        notificationId,
      });
      expect(processed.result).toBe(`SETTLED ${collect.operationId} SUBMISSION_DENIED [DENIED]`);
      const rows = yield* evidenceRows(runtimeClient, scope, binding.bindingId);
      expect(rows.map((row) => row.submission_state)).toEqual(['DENIED']);
      expect(yield* notificationRow(runtimeClient, scope, notificationId)).toEqual({
        correlated_operation_id: collect.operationId,
        state: 'SUBMISSION_DENIED',
      });
    }),
  ),
);

it.live('#1156 Notification for another binding is never applied', () =>
  Effect.scoped(
    Effect.gen(function* otherBinding() {
      const { runtime: runtimeClient } = yield* testDatabaseClients;
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
      const scope = yield* makeTestScope;
      const owning = yield* stripeBinding(runtimeClient, scope, 'SANDBOX');
      const other = yield* stripeBinding(runtimeClient, scope, 'LIVE');
      const collect = yield* preparedCollect(runtime, scope, owning);
      const intent = Schema.decodeUnknownSync(ProviderObjectRefSchema)({
        _tag: 'STRIPE_PAYMENT_INTENT',
        id: 'pi_native_notification',
      });
      yield* inWorker(runtime, scope, ({ scope: worker, workerContext }) =>
        Effect.service(ProviderDispatchLedger).pipe(
          Effect.flatMap((ledger) =>
            ledger.recordOutcomeUnknown({
              at: DateTime.makeUnsafe(OBSERVED_AT),
              operationId: collect.operationId,
              scope: worker,
              workerContext,
            }),
          ),
        ),
      ).pipe(Effect.provide(storesLayer));
      // Another merchant's notification names the same provider object id and even this operation's order reference.
      const { orderReference } = deriveProviderCorrelation(collect.operationId);
      const notificationId = yield* captureNotification(runtimeClient, scope, other, {
        body: signedPaymentIntentBody('evt_native_foreign', 'pi_native_notification', orderReference),
        eventId: 'evt_native_foreign',
        refs: [intent],
      });
      const processed = yield* processNative(runtime, scope, {
        a8: 'ACCEPT',
        findings: () => Effect.all([confirmedFinding(collect.operationId, intent)]),
        notificationId,
      });
      expect(processed.result).toBe('HELD_UNCORRELATED order_reference_unknown');
      expect(processed.lookups).toEqual([]);
      expect(processed.statements).toEqual([]);
      expect(yield* evidenceRows(runtimeClient, scope, owning.bindingId)).toEqual([]);
      expect(yield* evidenceRows(runtimeClient, scope, other.bindingId)).toEqual([]);
      const owningDispatch = yield* inWorker(runtime, scope, ({ scope: worker }) =>
        Effect.service(ProviderDispatchLedger).pipe(
          Effect.flatMap((ledger) => ledger.readByOperation({ operationId: collect.operationId, scope: worker })),
        ),
      ).pipe(Effect.provide(storesLayer));
      expect(owningDispatch.pipe(Option.map(({ state }) => state))).toEqual(Option.some('OUTCOME_UNKNOWN'));
      expect(yield* notificationRow(runtimeClient, scope, notificationId)).toEqual({
        correlated_operation_id: null,
        state: 'HELD_UNCORRELATED',
      });
      // The notification store itself refuses to correlate another binding's operation.
      const refused = yield* inWorker(runtime, scope, ({ scope: worker, workerContext }) =>
        Effect.service(ProviderNotificationStore).pipe(
          Effect.flatMap((store) =>
            store.transition({
              correlatedOperationId: Option.some(collect.operationId),
              notificationId,
              scope: worker,
              to: 'SUBMITTED',
              workerContext,
            }),
          ),
          Effect.flip,
        ),
      ).pipe(Effect.provide(storesLayer));
      expect(refused.reason).toBe('notification_transition_refused:binding_mismatch');
    }),
  ),
);

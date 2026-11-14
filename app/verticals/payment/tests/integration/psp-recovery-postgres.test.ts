import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime/outbox/worker';
import type { PgClient } from '@effect/sql-pg';
import { readFileSync } from 'node:fs';

import { DateTime, Effect, Exit, Layer, Option, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { PaymentGatewayAccountBindingSchema } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import {
  GatewayCredentialSecretRefSchema,
  GatewayMerchantIdentitySchema,
  GatewayProviderAccountBindingIdSchema,
  GatewayProviderAccountRefSchema,
} from '../../shared/domain/psp-configuration.ts';
import type {
  GatewayProviderAccountBindingId,
  GatewayProviderAccountRef,
} from '../../shared/domain/psp-configuration.ts';
import type { OutboxPayload as RecoveryRequested } from '../../shared/outbox/payment-core-operation-recovery-requested-v1.ts';
import { GatewayBindingResolverLive } from '../../src/integrations/psp/binding-resolver-live.ts';
import { GATEWAY_LAUNCH_CAPABILITIES } from '../../src/integrations/psp/capability-matrix.ts';
import { ProviderDispatchLedgerLive } from '../../src/integrations/psp/dispatch-ledger-live.ts';
import { ProviderDispatchLedger } from '../../src/integrations/psp/dispatch-ledger.ts';
import type { ProviderDispatchIdentity, ProviderDispatchRecord } from '../../src/integrations/psp/dispatch-ledger.ts';
import { ProviderEvidenceStoreLive } from '../../src/integrations/psp/evidence-store-live.ts';
import { ProviderEvidenceStore } from '../../src/integrations/psp/evidence-store.ts';
import type { ProviderEvidenceSubmissionOutcome } from '../../src/integrations/psp/evidence-store.ts';
import { ProviderEvidenceSubmitter } from '../../src/integrations/psp/evidence-submission.ts';
import { recoverGatewayOperationInScope } from '../../src/integrations/psp/gateway-operation-recovery.ts';
import type { GatewayRecoveryReport } from '../../src/integrations/psp/gateway-operation-recovery.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import { GatewayProviderUnavailable } from '../../src/integrations/psp/psp-errors.ts';
import type { GatewayProviderUnavailableError } from '../../src/integrations/psp/psp-errors.ts';
import { GatewayExecutionTargetSchema, ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import type {
  GatewayExecutionTarget,
  GatewayLookupRequest,
  ProviderObjectRef,
} from '../../src/integrations/psp/psp-request.ts';
import {
  PreparedProviderRequestSchema,
  ProviderEvidenceSchema,
  ProviderFindingResultSchema,
} from '../../src/integrations/psp/psp-result.ts';
import type { ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';
import { pspBindingPersistenceForTransaction } from '../../src/persistence/psp-binding-persistence.ts';
import { testNotificationRouteOf } from '../support/route-scope.fixture.ts';
import {
  GOPAY_FIXTURE_GOID,
  GOPAY_FIXTURE_PAYMENT_ID,
  gopayCreateResponseBody,
  gopayInquiryResponseBody,
} from '../fixtures/gopay/payment-responses.ts';
import {
  GOPAY_BANK_REFUND_ROW_ID,
  gopayEmptyRefundHistoryBody,
  gopayRefundHistoryBody,
  gopayRefundResponseBody,
} from '../fixtures/gopay/refund-responses.ts';
import {
  credentialConfig,
  dropAfterWrite,
  recordedGatewayAdapters,
  respond,
} from '../support/psp-conformance-provider.fixture.ts';
import type { CredentialDocument, RouteScript } from '../support/psp-conformance-provider.fixture.ts';
import {
  deliverExecution,
  dispatchRecordOf,
  evidenceOf,
  nativeBindingFor,
  nativeCollectionFor,
  nativeHarnessOf,
  nativeRefundFor,
} from '../support/psp-native-gateway.fixture.ts';
import type { NativeBinding, NativeHarness } from '../support/psp-native-gateway.fixture.ts';
import { pspPayerContactPersistenceForTransaction } from '../../src/persistence/psp-payer-contact-persistence.ts';
import type { OutboxPayload as OperationRequested } from '../../shared/outbox/payment-core-operation-requested-v1.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
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

/*
 * #1156 #1157 #1158 the recovery worker over the live C17 routines, ledger, evidence store and binding resolver.
 * The provider adapter and the A8 RegisteredWorkload submitter are scripted: the submitter answers what Shell
 * and A8 decide (L-DELEGATION-PROBE proves that decision natively), so these cases prove what the worker does
 * with each answer.
 */

type Family = typeof PaymentGatewayProviderFamilySchema.Type;
type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

const WORKER_KEY = 'payment.core.recover-gateway-operation';
const NOTIFICATION_URL = 'https://hooks.example.test/psp';
const HOUR_MS = 3_600_000;
const AMOUNT = { amountMinor: 100_000, currency: 'CZK' } as const;
const MERCHANT_IDENTITIES = {
  COMGATE: { _tag: 'COMGATE', merchantId: '123456' },
  GOPAY: { _tag: 'GOPAY', goid: '8123456789' },
  STRIPE: { _tag: 'STRIPE', accountId: 'acct_1TestAccount' },
} as const;
const MERCHANT_IDENTITY_DOCUMENTS = {
  COMGATE: '{"_tag":"COMGATE","merchantId":"123456"}',
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<Family, string>;

const storesLayer = Layer.mergeAll(ProviderDispatchLedgerLive, ProviderEvidenceStoreLive, GatewayBindingResolverLive);

const NO_COMPLETION = { publish: () => Effect.die('Recovery publishes no completion') };

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
      topic: 'payment.core.operation-recovery-requested.v1',
      workerKey: WORKER_KEY,
    })),
  );

/** One worker delivery in its own Core-scoped runtime transaction: only the routine invoker, no executor. */
const inWorker = <Value, Failure, Requirements>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  call: (worker: {
    readonly scope: Parameters<typeof recoverGatewayOperationInScope>[1];
    readonly workerContext: OutboxWorkerHandlerContext;
  }) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* workerCall() {
    const workerContext = yield* deliveryOf(scope);
    return yield* database.transaction((transaction: PaymentTestTransaction) =>
      installOperationalScope(transaction, operationalScopeOf(scope), defineDatabaseIdentityEnrollment([])).pipe(
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

const gatewayBindingOf = (family: Family, accountRef: string): PaymentGatewayAccountBinding =>
  Schema.decodeUnknownSync(PaymentGatewayAccountBindingSchema)({
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: accountRef,
    providerFamily: family,
  });

interface GatewayFixture {
  readonly accountRef: GatewayProviderAccountRef;
  readonly binding: PaymentGatewayAccountBinding;
  readonly bindingId: GatewayProviderAccountBindingId;
  readonly collect: ProviderDispatchIdentity;
  readonly family: Family;
  readonly operationKey: string;
  readonly originalProvenance: { readonly actionInvocationId: string; readonly compositionRevision: string };
  readonly paymentId: string;
  readonly scope: PaymentTestScope;
}

/** One CURRENT binding with its ACTIVE credential, a Payment and its gateway COLLECT. */
const gatewayFixture = Effect.fn('PspRecoveryFixture.gateway')(function* gatewayFixture(
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
  const binding = gatewayBindingOf(family, accountRef);
  const paymentInput = yield* newPaymentInput(scope);
  const created = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertPayment({ ...paymentInput, executionBinding: binding }),
  );
  const { paymentId } = created.record;
  const collectRequest = yield* collectInput(scope, { amountMinor: AMOUNT.amountMinor, paymentId }, 'collect-1');
  const collected = yield* withPersistence(runtime, scope, (persistence) =>
    persistence.insertOperation({ ...collectRequest, binding }),
  );
  const target = yield* Schema.decodeUnknownEffect(GatewayExecutionTargetSchema)({
    binding,
    bindingId,
    credentialRevision: 1,
    credentialSecretRef: 'sandbox-credential-1',
    legalEntityId: scope.legalEntityId,
    merchantIdentity: MERCHANT_IDENTITIES[family],
    notificationUrl: NOTIFICATION_URL,
    returnUrl: Option.none(),
    tenantId: scope.tenantId,
  });
  return {
    accountRef,
    binding,
    bindingId,
    collect: {
      materialHash: collected.record.materialHash,
      operationId: collected.record.operationId,
      operationKind: 'COLLECT',
      paymentId,
      target,
      targetOperationId: Option.none(),
    },
    family,
    operationKey: collected.record.operationKey,
    originalProvenance: collected.record.provenance,
    paymentId,
    scope,
  } satisfies GatewayFixture;
});

/** The executor's committed dispatch: Stripe with its exact replayable bytes, key and window. */
const prepareCollect = (runtime: PaymentTestDatabase, fixture: GatewayFixture) =>
  Effect.gen(function* prepareDispatch() {
    const { idempotencyKey, orderReference } = deriveProviderCorrelation(fixture.collect.operationId);
    const stripe = fixture.family === 'STRIPE';
    const prepared = yield* Schema.decodeUnknownEffect(PreparedProviderRequestSchema)({
      body: new TextEncoder().encode(`operation=${fixture.collect.operationId}&amount=100000`),
      endpointRef: stripe ? 'stripe:POST:/v1/checkout/sessions' : `${fixture.family.toLowerCase()}:payment-create`,
      family: fixture.family,
      headers: stripe ? [{ name: 'idempotency-key', value: idempotencyKey }] : [],
      idempotencyKey: stripe ? Option.some(idempotencyKey) : Option.none(),
      orderReference,
      refundBaseline: Option.none(),
      replayWindowMs: stripe ? Option.some(86_400_000) : Option.none(),
      requestHash: 'a'.repeat(64),
    });
    const result = yield* inWorker(runtime, fixture.scope, ({ scope, workerContext }) =>
      ProviderDispatchLedger.pipe(
        Effect.flatMap((ledger) =>
          ledger.prepare({
            identity: fixture.collect,
            prepared,
            refundDispatchCount: Option.none(),
            returnToken: Option.none(),
            scope,
            workerContext,
          }),
        ),
      ),
    ).pipe(Effect.provide(storesLayer));
    // Only a freshly committed dispatch is a valid starting point for these cases.
    return yield* Predicate.isTagged(result, 'PREPARED')
      ? Effect.succeed(result.record)
      : Effect.die('The fixture dispatch was not freshly prepared');
  });

/** The executor's send outcome: a lost response, or an acknowledgement with the provider ref. */
const recordSendOutcome = (
  runtime: PaymentTestDatabase,
  fixture: GatewayFixture,
  outcome: Option.Option<ProviderObjectRef>,
) =>
  inWorker(runtime, fixture.scope, ({ scope, workerContext }) =>
    ProviderDispatchLedger.pipe(
      Effect.flatMap((ledger) =>
        Option.match(outcome, {
          onNone: () =>
            ledger.recordOutcomeUnknown({
              at: DateTime.nowUnsafe(),
              operationId: fixture.collect.operationId,
              scope,
              workerContext,
            }),
          onSome: (providerPaymentRef) =>
            ledger.recordAcknowledged({
              customerRedirectUrl: Option.none(),
              operationId: fixture.collect.operationId,
              providerPaymentRef: Option.some(providerPaymentRef),
              providerRefundRef: Option.none(),
              respondedAt: DateTime.nowUnsafe(),
              scope,
              workerContext,
            }),
        }),
      ),
    ),
  ).pipe(Effect.provide(storesLayer));

/** The A10 message of a lookup recovery of the fixture's COLLECT, as A10 builds it from the stored operation. */
const recoveryRequested = Effect.fn('PspRecoveryFixture.message')(function* recoveryRequested(fixture: GatewayFixture) {
  const [provenance, recoveryId] = yield* Effect.all([provenanceFor(fixture.scope), randomUuid], { concurrency: 1 });
  const message: RecoveryRequested = {
    amount: AMOUNT,
    binding: fixture.binding,
    materialHash: fixture.collect.materialHash,
    mode: 'AUTHORITATIVE_LOOKUP',
    operationId: fixture.collect.operationId,
    operationKey: fixture.operationKey,
    operationKind: 'COLLECT',
    operationOutcome: 'INDETERMINATE',
    originalActionInvocationId: fixture.originalProvenance.actionInvocationId,
    originalCompositionRevision: fixture.originalProvenance.compositionRevision,
    paymentId: fixture.paymentId,
    provenance,
    recoveryId,
  };
  return message;
});

interface ProviderScript {
  readonly lookup: (target: GatewayExecutionTarget, request: GatewayLookupRequest) => readonly ProviderFindingResult[];
  /** A8's decision, or the failure the live submitter raises when the governed path refuses the delivery. */
  readonly submit: ProviderEvidenceSubmissionOutcome | GatewayProviderUnavailableError;
}

interface ProviderCalls {
  readonly lookups: { readonly request: GatewayLookupRequest; readonly target: GatewayExecutionTarget }[];
  readonly submitted: string[];
}

/** Runs one recovery delivery with the scripted provider and A8 answer at `atMs` of the worker clock. */
const recover = (
  runtime: PaymentTestDatabase,
  fixture: GatewayFixture,
  message: RecoveryRequested,
  script: ProviderScript,
  atMs: number,
) => {
  const calls: ProviderCalls = { lookups: [], submitted: [] };
  const adapters = Layer.succeed(GatewayProviderAdapters, {
    forFamily: (family) =>
      Effect.succeed({
        capabilities: GATEWAY_LAUNCH_CAPABILITIES[family],
        family,
        lookup: (target, request) =>
          Effect.sync(() => {
            calls.lookups.push({ request, target });
            return script.lookup(target, request);
          }),
        prepareCancel: () => Effect.die('recovery never prepares'),
        prepareCollect: () => Effect.die('recovery never prepares'),
        prepareRefund: () => Effect.die('recovery never prepares'),
        readOrderReference: () => Effect.die('recovery never reads order references'),
        replay: () => Effect.die('no replay in these cases'),
        send: () => Effect.die('recovery never sends'),
        verifyNotification: () => Effect.die('recovery never verifies notifications'),
      }),
  });
  const submitter = Layer.succeed(ProviderEvidenceSubmitter, {
    submit: (submission) =>
      Effect.suspend(() => {
        calls.submitted.push(submission.evidence.evidenceId);
        const answer = script.submit;
        return Predicate.isTagged(answer, 'GatewayProviderUnavailable')
          ? Effect.fail(answer)
          : Effect.succeed({ observationId: Option.none(), outcome: answer });
      }),
  });
  return TestClock.setTime(atMs).pipe(
    Effect.andThen(
      inWorker(runtime, fixture.scope, ({ scope, workerContext }) =>
        recoverGatewayOperationInScope(message, scope, workerContext),
      ),
    ),
    Effect.provide(Layer.mergeAll(storesLayer, adapters, submitter)),
    Effect.provide(TestClock.layer()),
    Effect.map((report) => ({ calls, report: Option.getOrThrow(report) satisfies GatewayRecoveryReport })),
  );
};

const providerRef = (input: typeof ProviderObjectRefSchema.Encoded) =>
  Schema.decodeEffect(ProviderObjectRefSchema)(input);

/** A lookup finding about the fixture's COLLECT with its evidence (or a miss without one). */
const lookupFinding = (
  fixture: GatewayFixture,
  input: {
    readonly finding: ProviderFindingResult['finding'];
    readonly objectId: string;
    readonly observedAt: DateTime.Utc;
    readonly ref: typeof ProviderObjectRefSchema.Encoded;
    readonly withOrderReference?: boolean;
  },
) =>
  Schema.decodeUnknownSync(ProviderFindingResultSchema)({
    customerAction: Option.none(),
    evidence:
      input.finding === 'INDETERMINATE'
        ? Option.none()
        : Option.some(
            Schema.decodeUnknownSync(ProviderEvidenceSchema)({
              discrepancy: Option.none(),
              economicEffectKey: Option.some(input.objectId),
              factFamily: 'GATEWAY_OUTCOME',
              factKind: 'COLLECTION_CONFIRMED',
              observedAmount: Option.some(AMOUNT),
              observedAt: input.observedAt,
              providerOccurredAt: Option.none(),
              providerRefs: [input.ref],
              reason: Option.none(),
              sourceOccurrenceId: `${fixture.family.toLowerCase()}:RECOVERY_LOOKUP:${input.objectId}:${fixture.collect.operationId}:COLLECTION_CONFIRMED:100000`,
              sourceRevision: 0,
            }),
          ),
    finding: input.finding,
    orderReference:
      input.withOrderReference === true
        ? Option.some(deriveProviderCorrelation(fixture.collect.operationId).orderReference)
        : Option.none(),
    providerRefs: [input.ref],
    target: { operationId: fixture.collect.operationId, operationKind: 'COLLECT' },
  });

interface EvidenceRow {
  readonly binding_id: string;
  readonly evidence_origin: string;
  readonly source_occurrence_id: string;
  readonly submission_state: string;
}

const evidenceRows = (runtimeClient: PgClient.PgClient, fixture: GatewayFixture) =>
  inScope(
    runtimeClient,
    fixture.scope,
    runtimeClient.unsafe<EvidenceRow>(
      `select binding_id::text, evidence_origin, source_occurrence_id, submission_state
       from payment.psp_provider_evidence where operation_id = $1 order by recorded_at, source_occurrence_id`,
      [fixture.collect.operationId],
    ),
  );

const dispatchState = (runtimeClient: PgClient.PgClient, fixture: GatewayFixture) =>
  inScope(
    runtimeClient,
    fixture.scope,
    runtimeClient.unsafe<{ provider_payment_ref: string | null; state: string }>(
      'select state, provider_payment_ref from payment.psp_provider_dispatches where operation_id = $1',
      [fixture.collect.operationId],
    ),
  ).pipe(Effect.map((rows) => rows[0]));

const preparedAtMs = (record: ProviderDispatchRecord) => DateTime.toEpochMillis(Option.getOrThrow(record.preparedAt));

const databases = Effect.gen(function* recoveryDatabases() {
  const { runtime: runtimeClient } = yield* testDatabaseClients;
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
  return { runtime, runtimeClient };
});

it.live('#1158 Timeout or lost response becomes INDETERMINATE and recovery uses lookup', () =>
  Effect.scoped(
    Effect.gen(function* lostResponseLookup() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_REVISION);
      const { runtime, runtimeClient } = yield* databases;
      const fixture = yield* gatewayFixture(runtime, runtimeClient, yield* makeTestScope, 'STRIPE');
      const prepared = yield* prepareCollect(runtime, fixture);
      yield* recordSendOutcome(runtime, fixture, Option.none());
      // A10 made the C16 operation INDETERMINATE: the effect may or may not exist (never NOT_EFFECTED).
      const provenance = yield* provenanceFor(fixture.scope);
      const transitioned = yield* withPersistence(runtime, fixture.scope, (persistence) =>
        persistence.transitionOperationOutcome({
          causedBy: { kind: 'OBSERVATION', sourceId: 'observation:transport-lost' },
          expectedOutcomeRevision: 1,
          operationId: fixture.collect.operationId,
          paymentId: fixture.paymentId,
          provenance,
          to: 'INDETERMINATE',
        }),
      );
      expect(transitioned.record.outcome).toBe('INDETERMINATE');
      const message = { ...(yield* recoveryRequested(fixture)), operationOutcome: 'INDETERMINATE' as const };
      const record = prepared;
      const after = preparedAtMs(record) + 25 * HOUR_MS;
      const intent = { _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_test_recovered' } as const;
      const { calls, report } = yield* recover(
        runtime,
        fixture,
        message,
        {
          lookup: () => [
            lookupFinding(fixture, {
              finding: 'EFFECT_CONFIRMED',
              objectId: 'pi_test_recovered',
              observedAt: DateTime.makeUnsafe(after),
              ref: intent,
              withOrderReference: true,
            }),
          ],
          submit: 'ACCEPTED',
        },
        after,
      );
      expect([report.mode, report.providerCall, Option.getOrNull(report.indeterminate)]).toEqual([
        'AUTHORITATIVE_LOOKUP',
        'LOOKUP_ORDER_REFERENCE',
        null,
      ]);
      expect(calls.lookups.map(({ request }) => request.target)).toEqual([
        { _tag: 'ORDER_REFERENCE', orderReference: record.orderReference },
      ]);
      // The search hit correlated the lost dispatch, so a later refund or cancel has its provider target.
      expect(yield* dispatchState(runtimeClient, fixture)).toEqual({
        provider_payment_ref: 'STRIPE_PAYMENT_INTENT:pi_test_recovered',
        state: 'ACKNOWLEDGED',
      });
      expect(
        (yield* evidenceRows(runtimeClient, fixture)).map(({ evidence_origin, submission_state }) => [
          evidence_origin,
          submission_state,
        ]),
      ).toEqual([['RECOVERY_LOOKUP', 'ACCEPTED']]);
    }),
  ),
);

it.live('#1158 Lookup miss stays INDETERMINATE', () =>
  Effect.scoped(
    Effect.gen(function* lookupMiss() {
      const { runtime, runtimeClient } = yield* databases;
      const scope = yield* makeTestScope;
      const stripe = yield* gatewayFixture(runtime, runtimeClient, scope, 'STRIPE');
      const prepared = yield* prepareCollect(runtime, stripe);
      const session = yield* providerRef({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_missing' });
      yield* recordSendOutcome(runtime, stripe, Option.some(session));
      const at = preparedAtMs(prepared) + HOUR_MS;
      const miss = yield* recover(
        runtime,
        stripe,
        yield* recoveryRequested(stripe),
        {
          lookup: () => [
            lookupFinding(stripe, {
              finding: 'INDETERMINATE',
              objectId: 'cs_test_missing',
              observedAt: DateTime.makeUnsafe(at),
              ref: { _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_missing' },
            }),
          ],
          submit: 'ACCEPTED',
        },
        at,
      );
      expect([miss.report.providerCall, Option.getOrNull(miss.report.indeterminate)]).toEqual([
        'LOOKUP_PROVIDER_OBJECT',
        'provider_indeterminate',
      ]);
      expect(miss.calls.lookups.map(({ request }) => request.target)).toEqual([
        { _tag: 'PROVIDER_OBJECT', ref: session },
      ]);
      expect([yield* evidenceRows(runtimeClient, stripe), miss.calls.submitted]).toEqual([[], []]);
      expect((yield* dispatchState(runtimeClient, stripe))?.state).toBe('ACKNOWLEDGED');

      // A GoPay response lost without a provider ref: GoPay has no order-reference lookup, so nothing is asked.
      const gopay = yield* gatewayFixture(runtime, runtimeClient, scope, 'GOPAY');
      yield* prepareCollect(runtime, gopay);
      yield* recordSendOutcome(runtime, gopay, Option.none());
      const blind = yield* recover(
        runtime,
        gopay,
        yield* recoveryRequested(gopay),
        { lookup: () => [], submit: 'ACCEPTED' },
        at + 25 * HOUR_MS,
      );
      expect([blind.report.providerCall, Option.getOrNull(blind.report.indeterminate), blind.calls.lookups]).toEqual([
        'NONE',
        'lookup_not_possible_without_provider_ref',
        [],
      ]);
      expect((yield* dispatchState(runtimeClient, gopay))?.state).toBe('OUTCOME_UNKNOWN');
    }),
  ),
);

/** A GoPay COLLECT the provider acknowledged with its payment id. */
const acknowledgedGopay = Effect.fn('PspRecoveryFixture.acknowledgedGopay')(function* acknowledgedGopay(
  runtime: PaymentTestDatabase,
  runtimeClient: PgClient.PgClient,
) {
  const fixture = yield* gatewayFixture(runtime, runtimeClient, yield* makeTestScope, 'GOPAY');
  yield* prepareCollect(runtime, fixture);
  const paymentRef = yield* providerRef({ _tag: 'GOPAY_PAYMENT', id: '3000006529' });
  yield* recordSendOutcome(runtime, fixture, Option.some(paymentRef));
  return { fixture, paymentRef };
});

const gopayConfirmed = (fixture: GatewayFixture, observedAt: DateTime.Utc) => () => [
  lookupFinding(fixture, {
    finding: 'EFFECT_CONFIRMED',
    objectId: '3000006529',
    observedAt,
    ref: { _tag: 'GOPAY_PAYMENT', id: '3000006529' },
  }),
];

it.live('#1157 Human-admitted recovery records evidence but does not submit', () =>
  Effect.scoped(
    Effect.gen(function* humanAdmitted() {
      const { runtime, runtimeClient } = yield* databases;
      const { fixture } = yield* acknowledgedGopay(runtime, runtimeClient);
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const message = yield* recoveryRequested(fixture);
      const first = yield* recover(
        runtime,
        fixture,
        message,
        // Shell refuses the RegisteredWorkload delegation of a human-origin A10 delivery; the live submitter
        // fails with this permanent refusal (evidence-submission-live.ts).
        {
          lookup: gopayConfirmed(fixture, DateTime.makeUnsafe(now)),
          submit: new GatewayProviderUnavailable({
            code: 'gateway_provider_unavailable',
            family: fixture.family,
            reason: 'submission_delegation_forbidden',
          }),
        },
        now,
      );
      expect([first.report.appended.length, first.report.submissionDenied, first.report.submissions]).toEqual([
        1,
        true,
        [],
      ]);
      // One attempt only; the evidence stays pending and visible as reconciliation debt.
      expect(first.calls.submitted.length).toBe(1);
      expect(
        (yield* evidenceRows(runtimeClient, fixture)).map(({ evidence_origin, submission_state }) => [
          evidence_origin,
          submission_state,
        ]),
      ).toEqual([['RECOVERY_LOOKUP', 'PENDING_SUBMISSION']]);
    }),
  ),
);

it.live('#1158 Workload-admitted recovery submits pending evidence through A8', () =>
  Effect.scoped(
    Effect.gen(function* workloadAdmitted() {
      const { runtime, runtimeClient } = yield* databases;
      const { fixture, paymentRef } = yield* acknowledgedGopay(runtime, runtimeClient);
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      // Evidence the executor left pending earlier (its own dispatch response).
      const earlier = yield* Schema.decodeUnknownEffect(ProviderEvidenceSchema)({
        discrepancy: Option.none(),
        economicEffectKey: Option.some('3000006529'),
        factFamily: 'GATEWAY_OUTCOME',
        factKind: 'COLLECTION_PENDING',
        observedAmount: Option.some(AMOUNT),
        observedAt: DateTime.makeUnsafe(now - HOUR_MS),
        providerOccurredAt: Option.none(),
        providerRefs: [paymentRef],
        reason: Option.none(),
        sourceOccurrenceId: `gopay:DISPATCH_RESPONSE:3000006529:${fixture.collect.operationId}:COLLECTION_PENDING:100000`,
        sourceRevision: 0,
      });
      yield* inWorker(runtime, fixture.scope, ({ scope, workerContext }) =>
        ProviderEvidenceStore.pipe(
          Effect.flatMap((store) =>
            store.append({
              bindingId: fixture.bindingId,
              evidence: earlier,
              notificationId: Option.none(),
              operationId: fixture.collect.operationId,
              origin: 'DISPATCH_RESPONSE',
              paymentId: fixture.paymentId,
              scope,
              workerContext,
            }),
          ),
        ),
      ).pipe(Effect.provide(storesLayer));
      const message = yield* recoveryRequested(fixture);
      const script = { lookup: gopayConfirmed(fixture, DateTime.makeUnsafe(now)), submit: 'ACCEPTED' } as const;
      const first = yield* recover(runtime, fixture, message, script, now);
      expect(first.report.submissions.map(({ outcome }) => outcome)).toEqual(['ACCEPTED', 'ACCEPTED']);
      expect(first.calls.submitted.length).toBe(2);
      expect(
        (yield* evidenceRows(runtimeClient, fixture)).map(({ evidence_origin, submission_state }) => [
          evidence_origin,
          submission_state,
        ]),
      ).toEqual([
        ['DISPATCH_RESPONSE', 'ACCEPTED'],
        ['RECOVERY_LOOKUP', 'ACCEPTED'],
      ]);
      // A redelivery finds the same occurrence already stored and nothing left pending.
      const again = yield* recover(runtime, fixture, message, script, now + 60_000);
      expect([again.report.appended.length, again.calls.submitted]).toEqual([1, []]);
      expect((yield* evidenceRows(runtimeClient, fixture)).length).toBe(2);
    }),
  ),
);

it.live('#1156 Lookup through the original binding after a binding is retired for new intents', () =>
  Effect.scoped(
    Effect.gen(function* retiredBindingLookup() {
      const { runtime, runtimeClient } = yield* databases;
      const { fixture } = yield* acknowledgedGopay(runtime, runtimeClient);
      // A new Current binding replaces the original for new intents; the original's credential is rotated.
      const [replaceProvenance, rotateProvenance] = yield* Effect.all(
        [provenanceFor(fixture.scope), provenanceFor(fixture.scope)],
        { concurrency: 1 },
      );
      const [merchantIdentity, secretRef] = yield* Effect.all(
        [
          Schema.decodeUnknownEffect(GatewayMerchantIdentitySchema)(MERCHANT_IDENTITIES.GOPAY),
          Schema.decodeUnknownEffect(GatewayCredentialSecretRefSchema)('sandbox-credential-2'),
        ],
        { concurrency: 1 },
      );
      const replacement = yield* runtime.transaction((transaction: PaymentTestTransaction) =>
        installOperationalScope(
          transaction,
          operationalScopeOf(fixture.scope),
          defineDatabaseIdentityEnrollment([]),
        ).pipe(
          Effect.flatMap((scoped) =>
            pspBindingPersistenceForTransaction(scoped).createBinding({
              environment: 'SANDBOX',
              merchantIdentity,
              provenance: replaceProvenance,
              reason: 'Replace the gateway account for new payments',
              replaces: Option.some({ expectedRevision: 1, providerAccountRef: fixture.accountRef }),
              route: testNotificationRouteOf(fixture.scope.tenantId, 'GOPAY'),
              secretRef: Schema.decodeUnknownSync(GatewayCredentialSecretRefSchema)('sandbox-credential-new'),
            }),
          ),
        ),
      );
      yield* runtime.transaction((transaction: PaymentTestTransaction) =>
        installOperationalScope(
          transaction,
          operationalScopeOf(fixture.scope),
          defineDatabaseIdentityEnrollment([]),
        ).pipe(
          Effect.flatMap((scoped) =>
            pspBindingPersistenceForTransaction(scoped).rotateCredential({
              expectedRevision: 2,
              provenance: rotateProvenance,
              providerAccountRef: fixture.accountRef,
              reason: 'Rotate the retired account credential',
              secretRef,
            }),
          ),
        ),
      );
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const { calls, report } = yield* recover(
        runtime,
        fixture,
        yield* recoveryRequested(fixture),
        { lookup: gopayConfirmed(fixture, DateTime.makeUnsafe(now)), submit: 'ACCEPTED' },
        now,
      );
      expect(report.providerCall).toBe('LOOKUP_PROVIDER_OBJECT');
      // The original (retired) binding with its current credential is asked; never the replacement.
      expect(
        calls.lookups.map(({ target }) => [
          target.bindingId,
          target.binding.providerAccountRef,
          target.credentialSecretRef,
        ]),
      ).toEqual([[fixture.bindingId, fixture.accountRef, 'sandbox-credential-2']]);
      expect(replacement.binding.view.providerAccountRef).not.toBe(fixture.accountRef);
      expect((yield* evidenceRows(runtimeClient, fixture)).map(({ binding_id }) => binding_id)).toEqual([
        fixture.bindingId,
      ]);
    }),
  ),
);

/*
 * Refund recovery through the production adapters (#1156 #1158, phase 2 D-P2): the executor acknowledged a
 * refund on native PostgreSQL; the recovery worker then looks it up through the original binding with the
 * production GoPay or Comgate adapter over recorded documented bodies. The A8 submitter stays scripted.
 */

const GOPAY_API = 'https://gw.sandbox.gopay.com/api';
const GOPAY_TOKEN = `POST ${GOPAY_API}/oauth2/token`;
const GOPAY_PAYMENT = `GET ${GOPAY_API}/payments/payment/${GOPAY_FIXTURE_PAYMENT_ID}`;
const GOPAY_REFUND = `POST ${GOPAY_API}/payments/payment/${GOPAY_FIXTURE_PAYMENT_ID}/refund`;
const GOPAY_REFUND_HISTORY = `${GOPAY_PAYMENT}/refunds`;
const gopayToken = respond(
  200,
  '{"token_type":"bearer","access_token":"gopay-access-token-recovery","expires_in":1800}',
);
/** The GoPay inquiry of the collection `orderReference`, partially refunded. */
const gopayPartiallyRefunded = (orderReference: string) =>
  respond(
    200,
    gopayInquiryResponseBody({
      amount: 10_000,
      goid: GOPAY_FIXTURE_GOID,
      orderNumber: orderReference,
      state: 'PARTIALLY_REFUNDED',
    }),
  );
/** The GoPay refund history (captured row shape) with the one 40 CZK row the refund created, in `state`. */
const gopayRefundHistory = (state: string) =>
  respond(200, gopayRefundHistoryBody([{ amount: 4000, id: GOPAY_BANK_REFUND_ROW_ID, state }]));
const PROVIDER_CREDENTIALS: CredentialDocument = {
  'comgate.recovery': { family: 'COMGATE', secret: 'comgate-recovery-not-a-secret' },
  'gopay.recovery': { clientId: 'gopay-client-recovery', clientSecret: 'gopay-recovery-not-a-secret', family: 'GOPAY' },
};
const COMGATE_API = 'https://payments.comgate.cz/v2.0';
const comgateFixture = (name: string) => readFileSync(new URL(`../fixtures/comgate/${name}`, import.meta.url), 'utf-8');

/** The payer contact a Comgate collection Action input carries; a GoPay collection takes none (plan D-P3). */
const payerContactOf = (binding: NativeBinding) =>
  binding.executionBinding.providerFamily === 'COMGATE'
    ? Option.some({ email: 'payer@example.test', fullName: 'Test Payer' })
    : Option.none();

/** One production executor delivery over recorded provider answers; it must complete. */
const executeThrough = Effect.fn('PspRecoveryFixture.executeThrough')(function* executeThrough(
  harness: NativeHarness,
  payload: OperationRequested,
  routes: RouteScript,
) {
  const provider = yield* recordedGatewayAdapters(routes);
  const exit = yield* deliverExecution(harness, payload, provider.adapters);
  expect(Exit.isSuccess(exit)).toBe(true);
  return provider.sent.map(({ route }) => route);
});

/**
 * An acknowledged collection of 100 CZK and a refund of 40 CZK on it, on native PostgreSQL: acknowledged, or with
 * `LOST` a GoPay refund whose response was lost after the request was written (OUTCOME_UNKNOWN).
 */
const acknowledgedRefund = Effect.fn('PspRecoveryFixture.acknowledgedRefund')(function* acknowledgedRefund(
  harness: NativeHarness,
  family: 'COMGATE' | 'GOPAY',
  gopayRefundResponse: 'ACCEPTED' | 'LOST',
) {
  const binding = yield* nativeBindingFor(harness, family, `${family.toLowerCase()}.recovery`);
  const collect = yield* nativeCollectionFor(harness, binding, 10_000);
  const contact = payerContactOf(binding);
  if (Option.isSome(contact)) {
    yield* harness.database.transaction((transaction: PaymentTestTransaction) =>
      installOperationalScope(
        transaction,
        operationalScopeOf(harness.scope),
        defineDatabaseIdentityEnrollment([]),
      ).pipe(
        Effect.flatMap((scoped) =>
          pspPayerContactPersistenceForTransaction(scoped).rememberForCollect(collect.operationId, contact.value),
        ),
      ),
    );
  }
  const { orderReference } = deriveProviderCorrelation(collect.operationId);
  yield* executeThrough(
    harness,
    collect,
    family === 'GOPAY'
      ? {
          [`POST ${GOPAY_API}/payments/payment`]: [respond(200, gopayCreateResponseBody(orderReference))],
          [GOPAY_TOKEN]: [gopayToken],
        }
      : { [`POST ${COMGATE_API}/payment.json`]: [respond(200, comgateFixture('create-success.json'))] },
  );
  const refund = yield* nativeRefundFor(harness, binding, collect, 4000);
  // GoPay: prepare reads the empty history (the pre-dispatch baseline); the accepted refund is followed by one
  // refund-history read that still shows its new row REQUESTED (pending).
  const gopayRefundRoutes: RouteScript =
    gopayRefundResponse === 'LOST'
      ? {
          [GOPAY_REFUND]: [dropAfterWrite],
          [GOPAY_REFUND_HISTORY]: [respond(200, gopayEmptyRefundHistoryBody)],
          [GOPAY_TOKEN]: [gopayToken],
        }
      : {
          [GOPAY_PAYMENT]: [gopayPartiallyRefunded(orderReference)],
          [GOPAY_REFUND]: [respond(200, gopayRefundResponseBody(GOPAY_FIXTURE_PAYMENT_ID, 'ACCEPTED'))],
          [GOPAY_REFUND_HISTORY]: [respond(200, gopayEmptyRefundHistoryBody), gopayRefundHistory('REQUESTED')],
          [GOPAY_TOKEN]: [gopayToken],
        };
  yield* executeThrough(
    harness,
    refund,
    family === 'GOPAY'
      ? gopayRefundRoutes
      : { [`POST ${COMGATE_API}/refund.json`]: [respond(200, comgateFixture('result-ok.json'))] },
  );
  return { binding, orderReference, refund };
});

/** One recovery delivery of `refund` with the production adapters over `routes`; the A8 answer is ACCEPTED. */
const recoverRefundThrough = Effect.fn('PspRecoveryFixture.recoverRefundThrough')(function* recoverRefundThrough(
  harness: NativeHarness,
  refund: OperationRequested,
  routes: RouteScript,
) {
  const provider = yield* recordedGatewayAdapters(routes);
  const [provenance, recoveryId] = yield* Effect.all([provenanceFor(harness.scope), randomUuid], { concurrency: 1 });
  const message: RecoveryRequested = {
    amount: refund.amount,
    binding: refund.binding,
    materialHash: refund.materialHash,
    mode: 'AUTHORITATIVE_LOOKUP',
    operationId: refund.operationId,
    operationKey: refund.operationKey,
    operationKind: 'REFUND',
    operationOutcome: 'INDETERMINATE',
    originalActionInvocationId: refund.provenance.actionInvocationId,
    originalCompositionRevision: refund.provenance.compositionRevision,
    paymentId: refund.paymentId,
    provenance,
    recoveryId,
  };
  const submitted: string[] = [];
  const submitter = Layer.succeed(ProviderEvidenceSubmitter, {
    submit: (submission) =>
      Effect.sync(() => {
        submitted.push(submission.evidence.evidence.factKind);
        return { observationId: Option.none(), outcome: 'ACCEPTED' as const };
      }),
  });
  const report = yield* inWorker(harness.database, harness.scope, ({ scope, workerContext }) =>
    recoverGatewayOperationInScope(message, scope, workerContext),
  ).pipe(
    Effect.provide(Layer.mergeAll(storesLayer, Layer.succeed(GatewayProviderAdapters, provider.adapters), submitter)),
  );
  return { report: Option.getOrThrow(report), sent: provider.sent.map(({ route }) => route), submitted };
});

const nativeRecoveryHarness = Effect.gen(function* nativeRecoveryHarness() {
  const { runtime, runtimeClient } = yield* databases;
  return nativeHarnessOf(runtime, runtimeClient, yield* makeTestScope);
});

const refundEvidenceOf = (harness: NativeHarness, refund: OperationRequested) =>
  evidenceOf(harness, refund.paymentId).pipe(
    Effect.map((rows) =>
      rows.filter(([id]) => id === refund.operationId).map(([, factKind, state]) => [factKind, state]),
    ),
  );

it.live(
  '#1156 #1158 GoPay refund recovery confirms the one refund-history row new since the pre-dispatch baseline',
  () =>
    Effect.scoped(
      Effect.gen(function* gopayRefundRecovery() {
        yield* installPaymentTestCompositionAuthority(COMPOSITION_REVISION);
        const harness = yield* nativeRecoveryHarness;
        const { orderReference, refund } = yield* acknowledgedRefund(harness, 'GOPAY', 'ACCEPTED');
        const recovered = yield* recoverRefundThrough(harness, refund, {
          [GOPAY_PAYMENT]: [gopayPartiallyRefunded(orderReference)],
          [GOPAY_REFUND_HISTORY]: [gopayRefundHistory('SUCCESS')],
          [GOPAY_TOKEN]: [gopayToken],
        }).pipe(Effect.provide(credentialConfig(PROVIDER_CREDENTIALS)));
        // The payment and its refund history are read through the original binding; the refund is never resent.
        expect(recovered.sent).toEqual([GOPAY_TOKEN, GOPAY_PAYMENT, GOPAY_REFUND_HISTORY]);
        expect([recovered.report.providerCall, Option.getOrNull(recovered.report.indeterminate)]).toEqual([
          'LOOKUP_PROVIDER_OBJECT',
          null,
        ]);
        expect(recovered.submitted).toContain('REFUND_CONFIRMED');
        expect(yield* refundEvidenceOf(harness, refund)).toEqual([
          ['REFUND_PENDING', 'ACCEPTED'],
          ['REFUND_CONFIRMED', 'ACCEPTED'],
        ]);
      }),
    ).pipe(Effect.provide(credentialConfig(PROVIDER_CREDENTIALS))),
);

it.live('#1158 A GoPay refund whose response was lost is never confirmed from the refund history', () =>
  Effect.scoped(
    Effect.gen(function* gopayLostRefundRecovery() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_REVISION);
      const harness = yield* nativeRecoveryHarness;
      const { orderReference, refund } = yield* acknowledgedRefund(harness, 'GOPAY', 'LOST');
      const lost = yield* dispatchRecordOf(harness, refund.operationId).pipe(Effect.flatMap(Effect.fromOption));
      // The baseline was committed before the send, but the dispatch was never acknowledged by GoPay.
      expect([lost.state, lost.providerRefundBaseline]).toEqual(['OUTCOME_UNKNOWN', []]);
      // A new matching SUCCESS row proves that a refund of this amount exists, not that this request made it.
      const recovered = yield* recoverRefundThrough(harness, refund, {
        [GOPAY_PAYMENT]: [gopayPartiallyRefunded(orderReference)],
        [GOPAY_REFUND_HISTORY]: [gopayRefundHistory('SUCCESS')],
        [GOPAY_TOKEN]: [gopayToken],
      }).pipe(Effect.provide(credentialConfig(PROVIDER_CREDENTIALS)));
      expect(recovered.sent).not.toContain(GOPAY_REFUND);
      expect(Option.getOrNull(recovered.report.indeterminate)).toBe('provider_indeterminate');
      expect(recovered.submitted).not.toContain('REFUND_CONFIRMED');
      expect(yield* refundEvidenceOf(harness, refund)).toEqual([]);
      const after = yield* dispatchRecordOf(harness, refund.operationId).pipe(Effect.flatMap(Effect.fromOption));
      expect(after.state).toBe('OUTCOME_UNKNOWN');
    }),
  ).pipe(Effect.provide(credentialConfig(PROVIDER_CREDENTIALS))),
);

it.live('#1156 #1158 Comgate SANDBOX refund recovery asks no statement and the refund stays pending', () =>
  Effect.scoped(
    Effect.gen(function* comgateSandboxRefundRecovery() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_REVISION);
      const harness = yield* nativeRecoveryHarness;
      const { refund } = yield* acknowledgedRefund(harness, 'COMGATE', 'ACCEPTED');
      // Statements exist only for production payments (D-P2): a sandbox lookup makes no provider call.
      const recovered = yield* recoverRefundThrough(harness, refund, {}).pipe(
        Effect.provide(credentialConfig(PROVIDER_CREDENTIALS)),
      );
      expect(recovered.sent).toEqual([]);
      expect([recovered.report.providerCall, Option.getOrNull(recovered.report.indeterminate)]).toEqual([
        'LOOKUP_PROVIDER_OBJECT',
        'provider_indeterminate',
      ]);
      expect(yield* refundEvidenceOf(harness, refund)).toEqual([['REFUND_PENDING', 'ACCEPTED']]);
    }),
  ).pipe(Effect.provide(credentialConfig(PROVIDER_CREDENTIALS))),
);

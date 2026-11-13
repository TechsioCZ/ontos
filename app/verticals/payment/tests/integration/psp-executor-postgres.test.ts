import {
  OutboxWorkerDeferred,
  OutboxWorkerLegalEntityScopeError,
  OutboxWorkerLegalEntityScopeFanout,
} from '@app/core-runtime/outbox/worker';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import type { OutboxPayload } from '@app/payment/outbox/payment-core-operation-requested-v1';
import type { PgClient } from '@effect/sql-pg';
import { Cause, Crypto, DateTime, Effect, Exit, Layer, Option, Predicate, Schema } from 'effect';
import { SqlError } from 'effect/sql/SqlError';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { PaymentRefundBasisSchema } from '../../shared/domain/payment-refund-basis.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { GatewayProviderAccountRefSchema } from '../../shared/domain/psp-configuration.ts';
import {
  cancellationMaterialRequest,
  operationRequestedPayloadOf,
  refundMaterialRequest,
} from '../../src/domain/refund-admission.ts';
import { GatewayBindingResolverLive } from '../../src/integrations/psp/binding-resolver-live.ts';
import { ProviderDispatchLedgerLive } from '../../src/integrations/psp/dispatch-ledger-live.ts';
import { ProviderEvidenceStoreLive } from '../../src/integrations/psp/evidence-store-live.ts';
import { executeGatewayOperation } from '../../src/integrations/psp/gateway-operation-executor.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import type { GatewayProviderAdapter } from '../../src/integrations/psp/psp-adapter.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import {
  GatewayProviderOutcomeUnknown,
  GatewayProviderUnavailable,
  GatewayProviderUnsupported,
} from '../../src/integrations/psp/psp-errors.ts';
import type {
  GatewayProviderOutcomeUnknownError,
  GatewayProviderUnavailableError,
  GatewayProviderUnsupportedError,
} from '../../src/integrations/psp/psp-errors.ts';
import { ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import type {
  GatewayExpectedEffect,
  GatewayPayerContact,
  ProviderObjectRef,
} from '../../src/integrations/psp/psp-request.ts';
import { PreparedProviderRequestSchema, ProviderFindingResultSchema } from '../../src/integrations/psp/psp-result.ts';
import type { PreparedProviderRequest, ProviderDispatchResponse } from '../../src/integrations/psp/psp-result.ts';
import { computePaymentMaterialHash } from '../../src/persistence/payment-aggregate-persistence.ts';
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

/**
 * #1153 #1156 #1158 The gateway executor against the native C17 scoped routines: the real binding resolver,
 * dispatch ledger and evidence store run through a routine invoker of a Core-scoped runtime transaction per
 * legal-entity step, exactly as the Outbox legal-entity fan-out hands them to a worker. Only the provider
 * adapters are fakes (no HTTP). Operations are inserted through Payment persistence, so no Action runtime and
 * no Composition authority is involved.
 */

type Family = typeof PaymentGatewayProviderFamilySchema.Type;
type AnyProviderFailure =
  | GatewayProviderOutcomeUnknownError
  | GatewayProviderUnavailableError
  | GatewayProviderUnsupportedError;

const NOTIFICATION_URL = 'https://hooks.example.test/psp';
const HOUR_MS = 3_600_000;
const MERCHANT_IDENTITY_DOCUMENTS = {
  COMGATE: '{"_tag":"COMGATE","merchantId":"123456"}',
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<Family, string>;

const refOf = (encoded: typeof ProviderObjectRefSchema.Encoded) =>
  Schema.decodeUnknownSync(ProviderObjectRefSchema)(encoded);
const PAYMENT_REFS = {
  COMGATE: refOf({ _tag: 'COMGATE_TRANSACTION', transId: 'AB12-CD34-EF56' }),
  GOPAY: refOf({ _tag: 'GOPAY_PAYMENT', id: '3000006529' }),
  STRIPE: refOf({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_native_1' }),
} satisfies Record<Family, ProviderObjectRef>;

// ---------------------------------------------------------------------------------------------
// Fake provider adapters (one attempt per call, recorded)
// ---------------------------------------------------------------------------------------------

interface ProviderCall {
  readonly family: Family;
  readonly kind: 'PREPARE_CANCEL' | 'PREPARE_COLLECT' | 'PREPARE_REFUND' | 'REPLAY' | 'SEND';
  readonly operationId: string;
  /** The payer contact a COLLECT prepare received; none for every other call. */
  readonly payerContact: Option.Option<GatewayPayerContact>;
  readonly providerTarget: Option.Option<ProviderObjectRef>;
}

interface Provider {
  calls: ProviderCall[];
  /** Overrides one call kind of one family; anything else answers with a plain acknowledgement. */
  failures: Map<string, (call: ProviderCall) => Effect.Effect<never, AnyProviderFailure>>;
}

const newProvider = (): Provider => ({ calls: [], failures: new Map() });

const preparedOf = (family: Family, operationId: string, kind: string): PreparedProviderRequest => {
  const { idempotencyKey, orderReference } = deriveProviderCorrelation(operationId);
  const stripe = family === 'STRIPE';
  const headers = [{ name: 'content-type', value: 'application/x-www-form-urlencoded' }];
  return Schema.decodeUnknownSync(PreparedProviderRequestSchema)({
    body: new TextEncoder().encode(`${kind}=${operationId}`),
    endpointRef: `${family.toLowerCase()}:${kind.toLowerCase()}`,
    family,
    headers: stripe ? [...headers, { name: 'idempotency-key', value: idempotencyKey }] : headers,
    idempotencyKey: stripe ? Option.some(idempotencyKey) : Option.none(),
    orderReference,
    // The ledger refuses a GoPay refund without its pre-dispatch refund-history baseline, and any other with one.
    refundBaseline: family === 'GOPAY' && kind === 'REFUND' ? Option.some({ rowIds: [] }) : Option.none(),
    replayWindowMs: stripe ? Option.some(86_400_000) : Option.none(),
    requestHash: 'a'.repeat(64),
  });
};

const ACKNOWLEDGEMENTS = {
  CANCEL_OR_VOID: {
    factFamily: 'GATEWAY_OUTCOME',
    factKind: 'CANCEL_CONFIRMED',
    finding: 'ACCEPTED_PENDING',
    redirect: false,
  },
  COLLECT: {
    factFamily: 'GATEWAY_OUTCOME',
    factKind: 'COLLECTION_PENDING',
    finding: 'CUSTOMER_ACTION_REQUIRED',
    redirect: true,
  },
  REFUND: { factFamily: 'REFUND_EXECUTION', factKind: 'REFUND_PENDING', finding: 'ACCEPTED_PENDING', redirect: false },
} as const;

const acknowledgement = (family: Family, expected: GatewayExpectedEffect): ProviderDispatchResponse => {
  const { factFamily, factKind, finding, redirect } = ACKNOWLEDGEMENTS[expected._tag];
  return {
    _tag: 'ACKNOWLEDGED',
    finding: Schema.decodeUnknownSync(ProviderFindingResultSchema)({
      customerAction: redirect ? Option.some({ redirectUrl: 'https://pay.example.test/1' }) : Option.none(),
      evidence: Option.some({
        discrepancy: Option.none(),
        economicEffectKey: Option.none(),
        factFamily,
        factKind,
        observedAmount: Option.none(),
        observedAt: DateTime.makeUnsafe('2026-11-12T10:00:00.000Z'),
        providerOccurredAt: Option.none(),
        providerRefs: [PAYMENT_REFS[family]],
        reason: Option.none(),
        sourceOccurrenceId: `${family.toLowerCase()}:dispatch_response:x:${expected.operationId}:${factKind}:1`,
        sourceRevision: 0,
      }),
      finding,
      orderReference: Option.none(),
      providerRefs: [PAYMENT_REFS[family]],
      target: { operationId: expected.operationId, operationKind: expected._tag },
    }),
    targetFinding: Option.none(),
  };
};

const adapterOf = (provider: Provider, family: Family): GatewayProviderAdapter => {
  const run = <Value>(call: ProviderCall, success: () => Value): Effect.Effect<Value, AnyProviderFailure> =>
    Effect.suspend(() => {
      provider.calls.push(call);
      const failure = provider.failures.get(`${family}:${call.kind}`);
      return failure === undefined ? Effect.sync(success) : failure(call);
    });
  const call = (
    kind: ProviderCall['kind'],
    operationId: string,
    providerTarget?: ProviderObjectRef,
    payerContact: Option.Option<GatewayPayerContact> = Option.none(),
  ) => ({
    family,
    kind,
    operationId,
    payerContact,
    providerTarget: Option.fromUndefinedOr(providerTarget),
  });
  return {
    capabilities: {
      CANCEL_OR_VOID: family === 'GOPAY' ? 'UNSUPPORTED' : 'SUPPORTED',
      COLLECT: 'SUPPORTED',
      NOTIFICATION: 'SUPPORTED',
      REFUND: 'SUPPORTED',
      RETRIEVE: 'SUPPORTED',
    },
    family,
    lookup: () => Effect.die('The executor never looks up'),
    prepareCancel: (_target, request) =>
      run(call('PREPARE_CANCEL', request.operationId, request.providerTarget), () =>
        preparedOf(family, request.operationId, 'CANCEL'),
      ).pipe(Effect.catchTag('GatewayProviderOutcomeUnknown', (failure) => Effect.die(failure))),
    prepareCollect: (_target, request) =>
      run(call('PREPARE_COLLECT', request.operationId, undefined, request.payerContact), () =>
        preparedOf(family, request.operationId, 'COLLECT'),
      ).pipe(Effect.catchTag('GatewayProviderOutcomeUnknown', (failure) => Effect.die(failure))),
    prepareRefund: (_target, request) =>
      run(call('PREPARE_REFUND', request.operationId, request.providerTarget), () =>
        preparedOf(family, request.operationId, 'REFUND'),
      ).pipe(Effect.catchTag('GatewayProviderOutcomeUnknown', (failure) => Effect.die(failure))),
    readOrderReference: () => Effect.die('The executor never reads order references'),
    replay: (_target, _request, expected) =>
      run(call('REPLAY', expected.operationId), () => acknowledgement(family, expected)),
    send: (_target, _prepared, expected) =>
      run(call('SEND', expected.operationId), () => acknowledgement(family, expected)).pipe(
        Effect.catchTag('GatewayProviderUnsupported', (failure) => Effect.die(failure)),
      ),
    verifyNotification: () => Effect.die('The executor never verifies notifications'),
  };
};

const unavailable = (family: Family, reason: string) => () =>
  Effect.fail(new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family, reason }));
const outcomeUnknown = (family: Family) => (providerCall: ProviderCall) =>
  Effect.fail(
    new GatewayProviderOutcomeUnknown({
      code: 'gateway_provider_outcome_unknown',
      family,
      operationId: providerCall.operationId,
      reason: 'timeout',
    }),
  );
const processCrash = () => Effect.die('the worker process crashed');

// ---------------------------------------------------------------------------------------------
// Worker runtime: one Core-scoped transaction per legal-entity step
// ---------------------------------------------------------------------------------------------

const NO_COMPLETION: OutboxWorkerLegalEntityScope['completionPublisher'] = {
  publish: () => Effect.die('The executor publishes no completion'),
};

const scopeUnavailable = (cause: unknown) =>
  new OutboxWorkerLegalEntityScopeError({
    cause,
    code: 'outbox_worker_scope_unavailable',
    reason: 'The test legal-entity scope is unavailable',
    retryable: true,
  });

interface WorkerOptions {
  /** Simulates a process crash after the decide step ran but before its transaction committed. */
  readonly crashBeforeCommit?: boolean;
}

const fanoutOf = (database: PaymentTestDatabase, scope: PaymentTestScope, options: WorkerOptions) => {
  let steps = 0;
  return Layer.succeed(OutboxWorkerLegalEntityScopeFanout, {
    forEachScope: (_context, observe) =>
      database
        .transaction((transaction) =>
          installOperationalScope(transaction, operationalScopeOf(scope)).pipe(
            Effect.mapError(scopeUnavailable),
            Effect.flatMap((routineInvoker) =>
              observe({
                completionPublisher: NO_COMPLETION,
                legalEntityId: scope.legalEntityId,
                routineInvoker,
                tenantId: scope.tenantId,
              }),
            ),
            Effect.andThen(
              Effect.suspend(() => {
                steps += 1;
                return options.crashBeforeCommit === true && steps === 1 ? processCrash() : Effect.void;
              }),
            ),
          ),
        )
        .pipe(Effect.mapError((failure) => (Schema.is(SqlError)(failure) ? scopeUnavailable(failure) : failure))),
  });
};

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

const contextOf = (scope: PaymentTestScope) =>
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
      topic: 'payment.core.operation-requested.v1',
      workerKey: 'payment.core.execute-gateway-operation',
    })),
  );

interface Harness {
  /** Owner connection: only it can read the insert-only payer contact table. */
  readonly admin: PgClient.PgClient;
  readonly crypto: { draws: number };
  readonly database: PaymentTestDatabase;
  readonly provider: Provider;
  readonly runtimeClient: PgClient.PgClient;
  readonly scope: PaymentTestScope;
}

/** One delivery of `payload`, optionally at an exact instant of the worker clock. */
const deliver = (harness: Harness, payload: OutboxPayload, options: WorkerOptions & { readonly atMs?: number } = {}) =>
  Effect.gen(function* delivery() {
    const context = yield* contextOf(harness.scope);
    const run = Effect.exit(executeGatewayOperation(payload, context)).pipe(
      Effect.provide(
        Layer.mergeAll(
          fanoutOf(harness.database, harness.scope, options),
          GatewayBindingResolverLive,
          Layer.succeed(GatewayProviderAdapters, {
            forFamily: (family) => Effect.succeed(adapterOf(harness.provider, family)),
          }),
          ProviderDispatchLedgerLive,
          ProviderEvidenceStoreLive,
          testCryptoOf(harness.crypto),
        ),
      ),
    );
    return yield* options.atMs === undefined
      ? run
      : TestClock.setTime(options.atMs).pipe(Effect.andThen(run), Effect.provide(TestClock.layer()));
  });

const deferredWake = (exit: Exit.Exit<void, unknown>) =>
  Exit.isFailure(exit)
    ? Cause.findErrorOption(exit.cause).pipe(
        Option.flatMap((failure) =>
          Schema.is(OutboxWorkerDeferred)(failure) ? Option.some(failure.wakeAtMs) : Option.none(),
        ),
      )
    : Option.none();

const failureTag = (exit: Exit.Exit<void, unknown>) =>
  Exit.isFailure(exit)
    ? Cause.findErrorOption(exit.cause).pipe(
        Option.flatMap((failure) =>
          Predicate.hasProperty(failure, '_tag') ? Option.some(failure._tag) : Option.none(),
        ),
      )
    : Option.none();

// ---------------------------------------------------------------------------------------------
// Native fixture: bindings, a Payment and its operations
// ---------------------------------------------------------------------------------------------

const harnessOf = Effect.gen(function* harness() {
  const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
  const database = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
  const scope = yield* makeTestScope;
  return { admin, crypto: { draws: 0 }, database, provider: newProvider(), runtimeClient, scope } satisfies Harness;
});

const gatewayBindingOf = (family: Family, accountRef: string) =>
  ({
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: accountRef,
    providerFamily: family,
  }) as const;

/** One CURRENT binding with its ACTIVE credential, as the configuration Action writes it. */
const bindingFor = Effect.fn('PspExecutorFixture.binding')(function* bindingFor(harness: Harness, family: Family) {
  const [refSeed, bindingId] = yield* Effect.all([randomUuid, randomUuid], { concurrency: 1 });
  const accountRef = yield* Schema.decodeEffect(GatewayProviderAccountRefSchema)(`pab_${refSeed.replaceAll('-', '')}`);
  const { runtimeClient, scope } = harness;
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
  return gatewayBindingOf(family, accountRef);
});

const payloadFor = (harness: Harness, paymentId: string, operationId: string) =>
  withPersistence(harness.database, harness.scope, (persistence) => persistence.loadAggregate(paymentId)).pipe(
    Effect.flatMap((aggregate) =>
      Effect.fromOption(Option.fromUndefinedOr(aggregate.operations.find((op) => op.operationId === operationId))).pipe(
        Effect.map((operation) => operationRequestedPayloadOf(aggregate, operation)),
      ),
    ),
  );

/** A gateway Payment with its COLLECT, and its operation-requested payload exactly as A4 builds it. */
const collectionFor = Effect.fn('PspExecutorFixture.collection')(function* collectionFor(
  harness: Harness,
  family: Family,
) {
  const { database, scope } = harness;
  const binding = yield* bindingFor(harness, family);
  const paymentInput = yield* newPaymentInput(scope);
  const created = yield* withPersistence(database, scope, (persistence) =>
    persistence.insertPayment({ ...paymentInput, executionBinding: binding }),
  );
  const { paymentId } = created.record;
  const collectRequest = yield* collectInput(scope, { amountMinor: 100_000, paymentId }, 'collect-1');
  const collected = yield* withPersistence(database, scope, (persistence) =>
    persistence.insertOperation({ ...collectRequest, binding }),
  );
  const payload = yield* payloadFor(harness, collected.record.paymentId, collected.record.operationId);
  return { binding, payload };
});

/** A CANCEL_OR_VOID of the collection, with the payload A6 builds. */
const cancellationFor = Effect.fn('PspExecutorFixture.cancellation')(function* cancellationFor(
  harness: Harness,
  collection: { readonly binding: ReturnType<typeof gatewayBindingOf>; readonly payload: OutboxPayload },
) {
  const provenance = yield* provenanceFor(harness.scope);
  const { operationId: targetOperationId, paymentId } = collection.payload;
  const cancelled = yield* withPersistence(harness.database, harness.scope, (persistence) =>
    persistence.insertOperation({
      amount: collection.payload.amount,
      binding: collection.binding,
      initialOutcome: 'PENDING',
      kind: 'CANCEL_OR_VOID',
      materialRequest: cancellationMaterialRequest({ reason: 'Customer cancelled', targetOperationId }),
      operationKey: 'cancel-1',
      paymentId,
      provenance,
      targetOperationId,
    }),
  );
  const payload = yield* payloadFor(harness, paymentId, cancelled.record.operationId);
  return { ...payload, targetOperationId } satisfies OutboxPayload;
});

const REFUND_AMOUNT = { amountMinor: 10_000, currency: 'CZK' } as const;
const refundBasisOf = (itemRef: string) =>
  Schema.decodeUnknownEffect(PaymentRefundBasisSchema)({
    _tag: 'REFUNDABLE_ITEMS',
    items: [{ amountMinor: 10_000, currency: 'CZK', itemRef, sourceEvidenceRef: `order:item:${itemRef}` }],
  });

/** A REFUND of a confirmed collection, with the payload A7 builds. */
const refundFor = Effect.fn('PspExecutorFixture.refund')(function* refundFor(
  harness: Harness,
  collection: { readonly binding: ReturnType<typeof gatewayBindingOf>; readonly payload: OutboxPayload },
) {
  const { database, scope } = harness;
  const { operationId: targetOperationId, paymentId } = collection.payload;
  const [confirm, provenance, basis, refundExecutionRoute] = yield* Effect.all(
    [
      provenanceFor(scope),
      provenanceFor(scope),
      refundBasisOf('A'),
      configuredRefundExecutionRouteFor(database, scope, collection.binding),
    ],
    { concurrency: 1 },
  );
  yield* withPersistence(database, scope, (persistence) =>
    persistence.transitionOperationOutcome({
      causedBy: { kind: 'OBSERVATION', sourceId: 'observation:captured' },
      expectedOutcomeRevision: 1,
      operationId: targetOperationId,
      paymentId,
      provenance: confirm,
      to: 'EFFECT_CONFIRMED',
    }),
  );
  const created = yield* withPersistence(database, scope, (persistence) =>
    persistence.insertOperation({
      amount: REFUND_AMOUNT,
      binding: collection.binding,
      initialOutcome: 'PENDING',
      kind: 'REFUND',
      materialRequest: refundMaterialRequest({ amount: REFUND_AMOUNT, basis, reason: 'Returned goods' }),
      operationKey: 'refund-A',
      paymentId,
      provenance,
      refundBasis: basis,
      refundExecutionRoute,
      targetOperationId,
    }),
  );
  const payload = yield* payloadFor(harness, paymentId, created.record.operationId);
  return { ...payload, refundBasis: basis, refundExecutionRoute, targetOperationId } satisfies OutboxPayload;
});

// ---------------------------------------------------------------------------------------------
// Native reads
// ---------------------------------------------------------------------------------------------

interface DispatchRow extends Record<string, unknown> {
  readonly not_sent_reason: string | null;
  readonly provider_payment_ref: string | null;
  readonly state: string;
}

const dispatchOf = (harness: Harness, operationId: string) =>
  inScope(
    harness.runtimeClient,
    harness.scope,
    harness.runtimeClient.unsafe<DispatchRow>(
      `select state, not_sent_reason, provider_payment_ref
         from payment.psp_provider_dispatches where operation_id = $1`,
      [operationId],
    ),
  ).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])));

const stateOf = (harness: Harness, operationId: string) =>
  dispatchOf(harness, operationId).pipe(Effect.map(Option.map((row) => [row.state, row.not_sent_reason])));

interface EvidenceRow extends Record<string, unknown> {
  readonly evidence_origin: string;
  readonly fact_kind: string;
  readonly operation_id: string;
  readonly reason: string | null;
  readonly submission_state: string;
}

const evidenceOf = (harness: Harness, paymentId: string) =>
  inScope(
    harness.runtimeClient,
    harness.scope,
    harness.runtimeClient.unsafe<EvidenceRow>(
      `select operation_id, fact_kind, reason, submission_state, evidence_origin
         from payment.psp_provider_evidence where payment_id = $1 order by recorded_at, fact_kind`,
      [paymentId],
    ),
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => [row.operation_id, row.fact_kind, row.reason, row.submission_state, row.evidence_origin]),
    ),
  );

/** The payer contact of a COLLECT as the collection Action stores it: an insert on the runtime role. */
const rememberContact = (
  harness: Harness,
  operationId: string,
  contact: { readonly email?: string; readonly fullName?: string; readonly phone?: string },
) =>
  inScope(
    harness.runtimeClient,
    harness.scope,
    harness.runtimeClient.unsafe(
      `insert into payment.psp_operation_payer_contacts (tenant_id, legal_entity_id, operation_id, full_name, email, phone)
       values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
      [
        harness.scope.tenantId,
        harness.scope.legalEntityId,
        operationId,
        contact.fullName ?? null,
        contact.email ?? null,
        contact.phone ?? null,
      ],
    ),
  );

interface CountRow extends Record<string, unknown> {
  readonly count: number;
}

const storedContactCount = (harness: Harness, operationId: string) =>
  harness.admin
    .unsafe<CountRow>(
      'select count(*)::integer as count from payment.psp_operation_payer_contacts where operation_id = $1',
      [operationId],
    )
    .pipe(Effect.map((rows) => rows[0]?.count ?? -1));

const prepareContacts = (harness: Harness) =>
  harness.provider.calls
    .filter((providerCall) => providerCall.kind === 'PREPARE_COLLECT')
    .map((providerCall) => providerCall.payerContact);

const callsOf = (harness: Harness, kind: ProviderCall['kind']) =>
  harness.provider.calls.filter((providerCall) => providerCall.kind === kind).length;

const createdAtMs = (payload: OutboxPayload) => DateTime.toEpochMillis(DateTime.makeUnsafe(payload.requestedAt));

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

it.live('#1158 Crash before durable handoff sends nothing', () =>
  Effect.scoped(
    Effect.gen(function* crashBeforeHandoff() {
      const harness = yield* harnessOf;
      const { payload } = yield* collectionFor(harness, 'GOPAY');
      const crashed = yield* deliver(harness, payload, { crashBeforeCommit: true });
      expect(Exit.isFailure(crashed)).toBe(true);
      expect(callsOf(harness, 'SEND')).toBe(0);
      expect(Option.isNone(yield* dispatchOf(harness, payload.operationId))).toBe(true);

      expect(Exit.isSuccess(yield* deliver(harness, payload))).toBe(true);
      expect(callsOf(harness, 'SEND')).toBe(1);
      const row = yield* dispatchOf(harness, payload.operationId);
      expect(row.pipe(Option.map((dispatch) => [dispatch.state, dispatch.provider_payment_ref]))).toEqual(
        Option.some(['ACKNOWLEDGED', 'GOPAY_PAYMENT:3000006529']),
      );
      // COLLECTION_PENDING is not kept as submission debt.
      expect(yield* evidenceOf(harness, payload.paymentId)).toEqual([]);
    }),
  ),
);

it.live('#1158 Crash after handoff never double-sends', () =>
  Effect.scoped(
    Effect.gen(function* crashAfterHandoff() {
      const harness = yield* harnessOf;
      const gopay = yield* collectionFor(harness, 'GOPAY');
      harness.provider.failures.set('GOPAY:SEND', processCrash);
      expect(Exit.isFailure(yield* deliver(harness, gopay.payload))).toBe(true);
      expect(yield* stateOf(harness, gopay.payload.operationId)).toEqual(Option.some(['PREPARED', null]));
      harness.provider.failures.clear();
      expect(Exit.isSuccess(yield* deliver(harness, gopay.payload))).toBe(true);
      expect(yield* stateOf(harness, gopay.payload.operationId)).toEqual(Option.some(['OUTCOME_UNKNOWN', null]));
      expect([callsOf(harness, 'PREPARE_COLLECT'), callsOf(harness, 'SEND'), callsOf(harness, 'REPLAY')]).toEqual([
        1, 1, 0,
      ]);

      // Stripe continues from the persisted request: one replay with the same bytes and key, never a new send.
      const other = yield* harnessOf;
      const stripe = yield* collectionFor(other, 'STRIPE');
      other.provider.failures.set('STRIPE:SEND', processCrash);
      expect(Exit.isFailure(yield* deliver(other, stripe.payload))).toBe(true);
      other.provider.failures.clear();
      expect(Exit.isSuccess(yield* deliver(other, stripe.payload))).toBe(true);
      expect([callsOf(other, 'PREPARE_COLLECT'), callsOf(other, 'SEND'), callsOf(other, 'REPLAY')]).toEqual([1, 1, 1]);
      expect(yield* stateOf(other, stripe.payload.operationId)).toEqual(Option.some(['ACKNOWLEDGED', null]));
    }),
  ),
);

it.live('#1156 Cancellation races with collection (cancel first)', () =>
  Effect.scoped(
    Effect.gen(function* cancelFirst() {
      const harness = yield* harnessOf;
      const collection = yield* collectionFor(harness, 'STRIPE');
      const cancel = yield* cancellationFor(harness, collection);
      expect(Exit.isSuccess(yield* deliver(harness, cancel))).toBe(true);
      expect(yield* stateOf(harness, collection.payload.operationId)).toEqual(
        Option.some(['NOT_SENT', 'WITHHELD_FOR_CANCELLATION']),
      );
      expect(yield* stateOf(harness, cancel.operationId)).toEqual(Option.some(['NOT_SENT', 'TARGET_WITHHELD']));
      expect(yield* evidenceOf(harness, cancel.paymentId)).toEqual([
        [cancel.operationId, 'CANCEL_CONFIRMED', 'withheld_for_cancellation', 'PENDING_SUBMISSION', 'LOCAL_NOT_SENT'],
        [
          collection.payload.operationId,
          'COLLECTION_NOT_EFFECTED',
          'withheld_for_cancellation',
          'PENDING_SUBMISSION',
          'LOCAL_NOT_SENT',
        ],
      ]);
      // The collection delivery arrives afterwards and finds nothing to send.
      expect(Exit.isSuccess(yield* deliver(harness, collection.payload))).toBe(true);
      expect(harness.provider.calls).toEqual([]);
    }),
  ),
);

it.live('#1156 Cancellation races with collection (collection first)', () =>
  Effect.scoped(
    Effect.gen(function* collectionFirst() {
      const harness = yield* harnessOf;
      const collection = yield* collectionFor(harness, 'STRIPE');
      expect(Exit.isSuccess(yield* deliver(harness, collection.payload))).toBe(true);
      const cancel = yield* cancellationFor(harness, collection);
      expect(Exit.isSuccess(yield* deliver(harness, cancel))).toBe(true);
      const prepareCancel = harness.provider.calls.find((providerCall) => providerCall.kind === 'PREPARE_CANCEL');
      expect(prepareCancel?.providerTarget).toEqual(Option.some(PAYMENT_REFS.STRIPE));
      expect(yield* stateOf(harness, cancel.operationId)).toEqual(Option.some(['ACKNOWLEDGED', null]));
      expect(callsOf(harness, 'SEND')).toBe(2);
    }),
  ),
);

it.live('#1156 Concurrent collection and cancellation never send a withheld collection', () =>
  Effect.scoped(
    Effect.gen(function* concurrentRace() {
      const harness = yield* harnessOf;
      const collection = yield* collectionFor(harness, 'STRIPE');
      const cancel = yield* cancellationFor(harness, collection);
      yield* Effect.all([deliver(harness, collection.payload), deliver(harness, cancel)], { concurrency: 2 });
      const collectState = yield* stateOf(harness, collection.payload.operationId);
      const collectSent = harness.provider.calls.some(
        (providerCall) => providerCall.kind === 'SEND' && providerCall.operationId === collection.payload.operationId,
      );
      // Either the collection was withheld and never sent, or it was sent and the cancel never confirmed locally.
      const withheld = Option.exists(
        collectState,
        ([state, reason]) => state === 'NOT_SENT' && reason === 'WITHHELD_FOR_CANCELLATION',
      );
      expect(collectSent).toBe(!withheld);
      const confirmedLocally = (yield* evidenceOf(harness, cancel.paymentId)).some(
        (row) => row[1] === 'CANCEL_CONFIRMED' && row[4] === 'LOCAL_NOT_SENT',
      );
      expect(confirmedLocally && collectSent).toBe(false);
    }),
  ),
);

it.live('#1156 Unrelated gateway is unavailable', () =>
  Effect.scoped(
    Effect.gen(function* unrelatedUnavailable() {
      const harness = yield* harnessOf;
      const gopay = yield* collectionFor(harness, 'GOPAY');
      const stripe = yield* collectionFor(harness, 'STRIPE');
      harness.provider.failures.set('GOPAY:PREPARE_COLLECT', unavailable('GOPAY', 'credential_entry_malformed'));
      expect(Option.isSome(deferredWake(yield* deliver(harness, gopay.payload)))).toBe(true);
      expect(Exit.isSuccess(yield* deliver(harness, stripe.payload))).toBe(true);
      expect(yield* stateOf(harness, stripe.payload.operationId)).toEqual(Option.some(['ACKNOWLEDGED', null]));
      expect(Option.isNone(yield* dispatchOf(harness, gopay.payload.operationId))).toBe(true);
      expect(
        harness.provider.calls.filter((providerCall) => providerCall.kind === 'SEND').map((c) => c.family),
      ).toEqual(['STRIPE']);
    }),
  ),
);

it.live('#1158 Same logical refund but changed basis conflicts', () =>
  Effect.scoped(
    Effect.gen(function* changedBasis() {
      const harness = yield* harnessOf;
      const collection = yield* collectionFor(harness, 'GOPAY');
      expect(Exit.isSuccess(yield* deliver(harness, collection.payload))).toBe(true);
      const refund = yield* refundFor(harness, collection);
      expect(Exit.isSuccess(yield* deliver(harness, refund))).toBe(true);
      expect(yield* stateOf(harness, refund.operationId)).toEqual(Option.some(['ACKNOWLEDGED', null]));
      const callsBefore = harness.provider.calls.length;

      // The same refund operation with another basis hashes to other material: no provider call at all.
      const changedHash = yield* computePaymentMaterialHash(
        refundMaterialRequest({ amount: REFUND_AMOUNT, basis: yield* refundBasisOf('B'), reason: 'Returned goods' }),
      );
      expect(changedHash).not.toBe(refund.materialHash);
      const conflicted = yield* deliver(harness, { ...refund, materialHash: changedHash });
      expect(failureTag(conflicted)).toEqual(Option.some('GatewayDispatchConflict'));
      expect(harness.provider.calls.length).toBe(callsBefore);
    }),
  ),
);

it.live('#1156 Unsupported provider operation yields typed unsupported, no fallback', () =>
  Effect.scoped(
    Effect.gen(function* unsupportedCancel() {
      const harness = yield* harnessOf;
      const collection = yield* collectionFor(harness, 'GOPAY');
      yield* collectionFor(harness, 'STRIPE');
      expect(Exit.isSuccess(yield* deliver(harness, collection.payload))).toBe(true);
      const cancel = yield* cancellationFor(harness, collection);
      harness.provider.failures.set('GOPAY:PREPARE_CANCEL', () =>
        Effect.fail(
          new GatewayProviderUnsupported({
            capability: 'CANCEL_OR_VOID',
            code: 'gateway_provider_unsupported',
            family: 'GOPAY',
            reason: 'provider_cancel_unsupported',
          }),
        ),
      );
      expect(Exit.isSuccess(yield* deliver(harness, cancel))).toBe(true);
      expect(yield* stateOf(harness, cancel.operationId)).toEqual(Option.some(['UNSUPPORTED', null]));
      expect(yield* evidenceOf(harness, cancel.paymentId)).toEqual([
        [
          cancel.operationId,
          'CANCEL_NOT_EFFECTED',
          'provider_cancel_unsupported',
          'PENDING_SUBMISSION',
          'LOCAL_NOT_SENT',
        ],
      ]);
      expect(harness.provider.calls.every((providerCall) => providerCall.family === 'GOPAY')).toBe(true);
      expect(callsOf(harness, 'SEND')).toBe(1);
    }),
  ),
);

it.live('#1158 Stripe lost response recovered inside 24 h', () =>
  Effect.scoped(
    Effect.gen(function* stripeLostResponse() {
      const harness = yield* harnessOf;
      const { payload } = yield* collectionFor(harness, 'STRIPE');
      harness.provider.failures.set('STRIPE:SEND', outcomeUnknown('STRIPE'));
      const first = yield* deliver(harness, payload);
      expect(Option.isSome(deferredWake(first))).toBe(true);
      expect(yield* stateOf(harness, payload.operationId)).toEqual(Option.some(['OUTCOME_UNKNOWN', null]));

      harness.provider.failures.clear();
      expect(Exit.isSuccess(yield* deliver(harness, payload, { atMs: createdAtMs(payload) + 3 * HOUR_MS }))).toBe(true);
      expect([callsOf(harness, 'SEND'), callsOf(harness, 'REPLAY')]).toEqual([1, 1]);
      expect(yield* stateOf(harness, payload.operationId)).toEqual(Option.some(['ACKNOWLEDGED', null]));
    }),
  ),
);

it.live('#1156 A missing Comgate payer contact ends NOT_SENT and never dead-letters', () =>
  Effect.scoped(
    Effect.gen(function* comgatePayerContact() {
      const harness = yield* harnessOf;
      const { payload } = yield* collectionFor(harness, 'COMGATE');
      harness.provider.failures.set('COMGATE:PREPARE_COLLECT', unavailable('COMGATE', 'payer_contact_unavailable'));
      expect(Option.isSome(deferredWake(yield* deliver(harness, payload)))).toBe(true);
      expect(Option.isNone(yield* dispatchOf(harness, payload.operationId))).toBe(true);

      const exhausted = yield* deliver(harness, payload, { atMs: createdAtMs(payload) + 24 * HOUR_MS });
      expect(Exit.isSuccess(exhausted)).toBe(true);
      expect(yield* stateOf(harness, payload.operationId)).toEqual(Option.some(['NOT_SENT', 'PREPARE_UNAVAILABLE']));
      expect(yield* evidenceOf(harness, payload.paymentId)).toEqual([
        [payload.operationId, 'COLLECTION_NOT_EFFECTED', 'prepare_unavailable', 'PENDING_SUBMISSION', 'LOCAL_NOT_SENT'],
      ]);
      expect(callsOf(harness, 'SEND')).toBe(0);
      // The routine returned no payer contact, so no prepare received one.
      expect(prepareContacts(harness).every(Option.isNone)).toBe(true);
    }),
  ),
);

it.live('#1154 A Comgate collect prepares with the stored payer contact, which PREPARED deletes', () =>
  Effect.scoped(
    Effect.gen(function* comgateContactPrepared() {
      const harness = yield* harnessOf;
      const { payload } = yield* collectionFor(harness, 'COMGATE');
      yield* rememberContact(harness, payload.operationId, { email: 'payer@example.test', fullName: 'Test Payer' });
      expect(yield* storedContactCount(harness, payload.operationId)).toBe(1);

      expect(Exit.isSuccess(yield* deliver(harness, payload))).toBe(true);
      expect(prepareContacts(harness)).toEqual([
        Option.some({
          email: Option.some('payer@example.test'),
          fullName: Option.some('Test Payer'),
          phone: Option.none(),
        }),
      ]);
      expect(yield* stateOf(harness, payload.operationId)).toEqual(Option.some(['ACKNOWLEDGED', null]));
      expect(yield* storedContactCount(harness, payload.operationId)).toBe(0);
    }),
  ),
);

it.live('#1153 A collect withheld for its cancellation deletes its payer contact', () =>
  Effect.scoped(
    Effect.gen(function* contactDeletedWhenWithheld() {
      const harness = yield* harnessOf;
      const collection = yield* collectionFor(harness, 'COMGATE');
      yield* rememberContact(harness, collection.payload.operationId, {
        email: 'payer@example.test',
        fullName: 'Test Payer',
      });
      const cancel = yield* cancellationFor(harness, collection);
      expect(Exit.isSuccess(yield* deliver(harness, cancel))).toBe(true);
      expect(yield* stateOf(harness, collection.payload.operationId)).toEqual(
        Option.some(['NOT_SENT', 'WITHHELD_FOR_CANCELLATION']),
      );
      expect(yield* storedContactCount(harness, collection.payload.operationId)).toBe(0);
      expect(callsOf(harness, 'PREPARE_COLLECT')).toBe(0);
    }),
  ),
);

it.live('#1153 A collect that is never sent deletes its payer contact', () =>
  Effect.scoped(
    Effect.gen(function* contactDeletedWhenNotSent() {
      const harness = yield* harnessOf;
      const { payload } = yield* collectionFor(harness, 'COMGATE');
      yield* rememberContact(harness, payload.operationId, { email: 'payer@example.test', fullName: 'Test Payer' });
      harness.provider.failures.set('COMGATE:PREPARE_COLLECT', unavailable('COMGATE', 'credential_entry_malformed'));
      expect(Option.isSome(deferredWake(yield* deliver(harness, payload)))).toBe(true);
      // A deferred prepare keeps the contact for the next attempt.
      expect(yield* storedContactCount(harness, payload.operationId)).toBe(1);

      expect(Exit.isSuccess(yield* deliver(harness, payload, { atMs: createdAtMs(payload) + 24 * HOUR_MS }))).toBe(
        true,
      );
      expect(yield* stateOf(harness, payload.operationId)).toEqual(Option.some(['NOT_SENT', 'PREPARE_UNAVAILABLE']));
      expect(yield* storedContactCount(harness, payload.operationId)).toBe(0);
      expect(callsOf(harness, 'SEND')).toBe(0);
    }),
  ),
);

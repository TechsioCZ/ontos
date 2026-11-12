import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { OutboxWorkerDeferred, OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { OutboxPayloadSchema } from '@app/payment/outbox/payment-core-operation-requested-v1';
import type { OutboxPayload } from '@app/payment/outbox/payment-core-operation-requested-v1';
import { Cause, Crypto, DateTime, Effect, Exit, Layer, Option, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import type { ProviderNotSentReason } from '../../shared/domain/psp-vocabulary.ts';
import { GatewayBindingResolver } from '../../src/integrations/psp/binding-resolver.ts';
import { providerRefText } from '../../src/integrations/psp/dispatch-ledger-live.ts';
import {
  idempotencyKeyHashOf,
  ProviderDispatchLedger,
  ProviderDispatchRecordSchema,
} from '../../src/integrations/psp/dispatch-ledger.ts';
import type {
  ProviderDispatchIdentity,
  ProviderDispatchLedgerContract,
  ProviderDispatchRecord,
} from '../../src/integrations/psp/dispatch-ledger.ts';
import { ProviderEvidenceIdSchema, ProviderEvidenceStore } from '../../src/integrations/psp/evidence-store.ts';
import type { StoredProviderEvidence } from '../../src/integrations/psp/evidence-store.ts';
import { executeGatewayOperation, nextWakeAt } from '../../src/integrations/psp/gateway-operation-executor.ts';
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
import { GatewayExecutionTargetSchema, ProviderObjectRefSchema } from '../../src/integrations/psp/psp-request.ts';
import type { GatewayExecutionTarget, ProviderObjectRef } from '../../src/integrations/psp/psp-request.ts';
import { PreparedProviderRequestSchema, ProviderFindingResultSchema } from '../../src/integrations/psp/psp-result.ts';
import type { PreparedProviderRequest, ProviderDispatchResponse } from '../../src/integrations/psp/psp-result.ts';

/**
 * #1153 #1156 #1158 The gateway executor over in-memory fakes of its ports. The fake legal-entity fan-out
 * runs each scope step as a transaction: a failing step rolls the ledger and evidence back, as PostgreSQL
 * does. The native routines are exercised in `psp-executor-postgres.test.ts`.
 */

type Family = typeof PaymentGatewayProviderFamilySchema.Type;

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const LEGAL_ENTITY_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_LEGAL_ENTITY_ID = '33333333-3333-4333-8333-333333333333';
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444';
const COLLECT_ID = '55555555-5555-4555-8555-555555555551';
const CANCEL_ID = '55555555-5555-4555-8555-555555555552';
const REFUND_ID = '55555555-5555-4555-8555-555555555553';
const REQUESTED_AT = DateTime.makeUnsafe('2026-11-12T10:00:00.000Z');
const HOUR_MS = 3_600_000;

const BINDINGS = {
  COMGATE: { bindingId: '66666666-6666-4666-8666-666666666663', ref: `pab_${'c'.repeat(32)}` },
  GOPAY: { bindingId: '66666666-6666-4666-8666-666666666661', ref: `pab_${'a'.repeat(32)}` },
  STRIPE: { bindingId: '66666666-6666-4666-8666-666666666662', ref: `pab_${'b'.repeat(32)}` },
} as const satisfies Record<Family, { readonly bindingId: string; readonly ref: string }>;
const MERCHANTS = {
  COMGATE: { _tag: 'COMGATE', merchantId: '123456' },
  GOPAY: { _tag: 'GOPAY', goid: '8123456789' },
  STRIPE: { _tag: 'STRIPE', accountId: 'acct_1TestAccount' },
} as const;

const bindingOf = (family: Family) => ({
  _tag: 'GATEWAY_ACCOUNT' as const,
  environment: 'SANDBOX',
  providerAccountRef: BINDINGS[family].ref,
  providerFamily: family,
});

const targetOf = (family: Family): GatewayExecutionTarget =>
  Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
    binding: bindingOf(family),
    bindingId: BINDINGS[family].bindingId,
    credentialRevision: 1,
    credentialSecretRef: `${family.toLowerCase()}-sandbox-1`,
    legalEntityId: LEGAL_ENTITY_ID,
    merchantIdentity: MERCHANTS[family],
    notificationUrl: 'https://hooks.example.test/psp',
    returnUrl: Option.some('https://shop.example.test/return'),
    tenantId: TENANT_ID,
  });

// ---------------------------------------------------------------------------------------------
// The C16 operations and their delivery
// ---------------------------------------------------------------------------------------------

interface OperationSpec {
  readonly amountMinor?: number;
  readonly family: Family;
  readonly kind: 'CANCEL_OR_VOID' | 'COLLECT' | 'REFUND';
  readonly materialHash?: string;
  readonly operationId: string;
  readonly outcome?: string;
  readonly targetOperationId?: string;
}

const materialOf = (spec: OperationSpec) => spec.materialHash ?? spec.operationId.slice(-1).repeat(64);

const REFUND_BASIS = {
  _tag: 'REFUNDABLE_ITEMS',
  items: [{ amountMinor: 10_000, currency: 'CZK', itemRef: 'item-a', sourceEvidenceRef: 'order:item:a' }],
} as const;

/** Adds the optional target and refund basis keys only when the operation has them. */
const withOptionalKeys = <Base extends object>(spec: OperationSpec, base: Base) => {
  const targeted = spec.targetOperationId === undefined ? base : { ...base, targetOperationId: spec.targetOperationId };
  return spec.kind === 'REFUND' ? { ...targeted, refundBasis: REFUND_BASIS } : targeted;
};

const payloadOf = (spec: OperationSpec, overrides: { readonly materialHash?: string } = {}): OutboxPayload =>
  Schema.decodeUnknownSync(OutboxPayloadSchema)(
    withOptionalKeys(spec, {
      amount: { amountMinor: spec.amountMinor ?? 100_000, currency: 'CZK' },
      binding: bindingOf(spec.family),
      kind: spec.kind,
      materialHash: overrides.materialHash ?? materialOf(spec),
      method: 'ONLINE_GATEWAY',
      operationId: spec.operationId,
      operationKey: `key-${spec.operationId}`,
      paymentId: PAYMENT_ID,
      provenance: {
        actionInvocationId: '77777777-7777-4777-8777-777777777777',
        actorPrincipalId: '88888888-8888-4888-8888-888888888888',
        compositionRevision: 'd'.repeat(64),
      },
      purchaseCorrelationId: 'purchase-1',
      requestedAt: DateTime.formatIso(REQUESTED_AT),
    }),
  );

const contextOf = (attempt = 1): OutboxWorkerHandlerContext => ({
  attemptNumber: attempt,
  claimId: `claim-${attempt}`,
  compositionRevision: 'd'.repeat(64),
  consumerModuleKey: 'payment.core',
  deliveryId: '99999999-9999-4999-8999-999999999999',
  domainEventId: 'event-1',
  legalEntityScope: 'required',
  messageId: 'message-1',
  originatorInvocationId: '77777777-7777-4777-8777-777777777777',
  producerModuleKey: 'payment.core',
  tenantId: TENANT_ID,
  tenantSequenceNo: 1n,
  topic: 'payment.core.operation-requested.v1',
  workerKey: 'payment.core.execute-gateway-operation',
});

// ---------------------------------------------------------------------------------------------
// In-memory world: ledger, evidence, operations, provider calls
// ---------------------------------------------------------------------------------------------

interface ProviderCall {
  readonly family: Family;
  readonly kind: 'LOOKUP' | 'PREPARE_CANCEL' | 'PREPARE_COLLECT' | 'PREPARE_REFUND' | 'REPLAY' | 'SEND';
  readonly operationId: string;
  readonly providerTarget?: ProviderObjectRef;
}

type AnyProviderFailure =
  | GatewayProviderOutcomeUnknownError
  | GatewayProviderUnavailableError
  | GatewayProviderUnsupportedError;
type AdapterScript = (call: ProviderCall) => Effect.Effect<ProviderDispatchResponse, AnyProviderFailure> | 'DEFAULT';

interface World {
  brokenResolverFamilies: Set<Family>;
  calls: ProviderCall[];
  crashOnPrepareCommit: boolean;
  dispatches: Map<string, ProviderDispatchRecord>;
  evidence: StoredProviderEvidence[];
  failures: Map<string, (call: ProviderCall) => Effect.Effect<never, AnyProviderFailure>>;
  operations: Map<string, OperationSpec & { cancelOperationExists?: boolean }>;
  script: AdapterScript;
}

const newWorld = (): World => ({
  brokenResolverFamilies: new Set(),
  calls: [],
  crashOnPrepareCommit: false,
  dispatches: new Map(),
  evidence: [],
  failures: new Map(),
  operations: new Map(),
  script: () => 'DEFAULT',
});

const operationRow = (world: World, spec: OperationSpec & { cancelOperationExists?: boolean }) => {
  const result = {
    amountMinor: spec.amountMinor ?? 100_000,
    binding: bindingOf(spec.family),
    cancelDispatchExists: [...world.dispatches.values()].some(
      (row) => row.operationKind === 'CANCEL_OR_VOID' && Option.contains(row.targetOperationId, spec.operationId),
    ),
    cancelOperationExists: spec.cancelOperationExists ?? false,
    createdAt: '2020-01-01T00:00:00.000Z',
    currency: 'CZK',
    customerConfigurationId: 'customer-configuration-1',
    kind: spec.kind,
    materialHash: materialOf(spec),
    operationId: spec.operationId,
    outcome: spec.outcome ?? 'PENDING',
    paymentId: PAYMENT_ID,
    provenance: {
      actionInvocationId: '77777777-7777-4777-8777-777777777777',
      actorPrincipalId: '77777777-7777-4777-8777-777777777777',
      compositionRevision: 'd'.repeat(64),
    },
  };
  return {
    result: spec.targetOperationId === undefined ? result : { ...result, targetOperationId: spec.targetOperationId },
  };
};

const scopeOf = (world: World, legalEntityId: string): OutboxWorkerLegalEntityScope => {
  const routineInvoker: ScopedRoutineInvoker = {
    invoke: (routine, args) =>
      Effect.sync(() => {
        const operation =
          legalEntityId === LEGAL_ENTITY_ID
            ? world.operations.get(Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(args[0]), () => ''))
            : undefined;
        return Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(
          routine.name === 'psp_read_operation_for_execution' && operation !== undefined
            ? [operationRow(world, operation)]
            : [],
        );
      }),
  };
  return {
    completionPublisher: { publish: () => Effect.die('The executor publishes no completion') },
    legalEntityId,
    routineInvoker,
    tenantId: TENANT_ID,
  };
};

/** Restores the ledger and evidence of a failed scope step, as a rolled-back transaction would. */
const inTransaction = <Value, Failure, Requirements>(
  world: World,
  step: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, Failure, Requirements> =>
  Effect.suspend(() => {
    const dispatches = new Map(world.dispatches);
    const evidence = [...world.evidence];
    const rollback = Effect.sync(() => {
      world.dispatches = dispatches;
      world.evidence = evidence;
    });
    return step.pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? rollback : Effect.void)));
  });

/** Each scope step is a transaction: its ledger and evidence writes roll back when it fails. */
const fanoutOf = (world: World) =>
  Layer.succeed(OutboxWorkerLegalEntityScopeFanout, {
    forEachScope: (_context, observe) =>
      Effect.forEach(
        [OTHER_LEGAL_ENTITY_ID, LEGAL_ENTITY_ID],
        (legalEntityId) => inTransaction(world, observe(scopeOf(world, legalEntityId))),
        { discard: true },
      ),
  });

const resolverOf = (world: World) =>
  Layer.succeed(GatewayBindingResolver, {
    resolveExecutionTarget: (query) =>
      world.brokenResolverFamilies.has(query.providerFamily)
        ? Effect.fail(
            new GatewayProviderUnavailable({
              code: 'gateway_provider_unavailable',
              family: query.providerFamily,
              reason: 'credential_not_active',
            }),
          )
        : Effect.succeed(targetOf(query.providerFamily)),
    resolveForNotification: () => Effect.die('The executor never resolves notifications'),
  });

const preparedOf = (family: Family, operationId: string, kind: string): PreparedProviderRequest => {
  const { idempotencyKey, orderReference } = deriveProviderCorrelation(operationId);
  const stripe = family === 'STRIPE';
  return Schema.decodeUnknownSync(PreparedProviderRequestSchema)({
    body: new TextEncoder().encode(`${kind}=${operationId}`),
    endpointRef: `${family.toLowerCase()}:${kind.toLowerCase()}`,
    family,
    headers: [{ name: 'content-type', value: 'application/x-www-form-urlencoded' }],
    idempotencyKey: stripe ? Option.some(idempotencyKey) : Option.none(),
    orderReference,
    replayWindowMs: stripe ? Option.some(86_400_000) : Option.none(),
    requestHash: `${operationId.slice(-1).repeat(63)}0`,
  });
};

const refOf = (encoded: typeof ProviderObjectRefSchema.Encoded) =>
  Schema.decodeUnknownSync(ProviderObjectRefSchema)(encoded);
const PAYMENT_REFS = {
  COMGATE: refOf({ _tag: 'COMGATE_TRANSACTION', transId: 'AB12-CD34-EF56' }),
  GOPAY: refOf({ _tag: 'GOPAY_PAYMENT', id: '3000006529' }),
  STRIPE: refOf({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_1' }),
} satisfies Record<Family, ProviderObjectRef>;
const STRIPE_PAYMENT_INTENT = refOf({ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_test_1' });
const sameRef = (left: ProviderObjectRef, right: ProviderObjectRef) => providerRefText(left) === providerRefText(right);

const FACTS = {
  CANCEL_OR_VOID: 'CANCEL_CONFIRMED',
  COLLECT: 'COLLECTION_PENDING',
  REFUND: 'REFUND_PENDING',
} as const;

/** The provider's acknowledgement of one operation, with evidence for cancel and refund. */
const acknowledgement = (family: Family, call: ProviderCall, kind: keyof typeof FACTS): ProviderDispatchResponse => ({
  _tag: 'ACKNOWLEDGED',
  finding: Schema.decodeUnknownSync(ProviderFindingResultSchema)({
    customerAction: kind === 'COLLECT' ? Option.some({ redirectUrl: 'https://pay.example.test/1' }) : Option.none(),
    evidence: Option.some({
      discrepancy: Option.none(),
      economicEffectKey: Option.none(),
      factFamily: kind === 'REFUND' ? 'REFUND_EXECUTION' : 'GATEWAY_OUTCOME',
      factKind: FACTS[kind],
      observedAmount: Option.none(),
      observedAt: REQUESTED_AT,
      providerOccurredAt: Option.none(),
      providerRefs: [PAYMENT_REFS[family]],
      reason: Option.none(),
      sourceOccurrenceId: `${family.toLowerCase()}:dispatch_response:x:${call.operationId}:${FACTS[kind]}:100000`,
      sourceRevision: 0,
    }),
    finding: kind === 'COLLECT' ? 'CUSTOMER_ACTION_REQUIRED' : 'ACCEPTED_PENDING',
    orderReference: Option.none(),
    providerRefs: [PAYMENT_REFS[family]],
    target: { operationId: call.operationId, operationKind: kind },
  }),
});

const kindOfCall = (world: World, operationId: string) => world.operations.get(operationId)?.kind ?? 'COLLECT';

const adapterOf = (world: World, family: Family): GatewayProviderAdapter => {
  const run = <Value>(call: ProviderCall, success: () => Value): Effect.Effect<Value, AnyProviderFailure> =>
    Effect.suspend(() => {
      world.calls.push(call);
      const failure = world.failures.get(`${family}:${call.kind}`);
      return failure === undefined ? Effect.sync(success) : failure(call);
    });
  const respond = (call: ProviderCall): Effect.Effect<ProviderDispatchResponse, AnyProviderFailure> =>
    Effect.suspend(() => {
      const scripted = world.script(call);
      return scripted === 'DEFAULT'
        ? Effect.succeed(acknowledgement(family, call, kindOfCall(world, call.operationId)))
        : scripted;
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
    // Only a Stripe refund looks up its collection's session, to learn the PaymentIntent it refunds.
    lookup: (_target, request) =>
      run({ family, kind: 'LOOKUP', operationId: request.expected.operationId }, () => [
        Schema.decodeUnknownSync(ProviderFindingResultSchema)({
          customerAction: Option.none(),
          evidence: Option.none(),
          finding: 'EFFECT_CONFIRMED',
          orderReference: Option.none(),
          providerRefs: [PAYMENT_REFS.STRIPE, STRIPE_PAYMENT_INTENT],
          target: { operationId: request.expected.operationId, operationKind: 'COLLECT' },
        }),
      ]).pipe(Effect.catchTag('GatewayProviderOutcomeUnknown', (failure) => Effect.die(failure))),
    prepareCancel: (_target, request) =>
      run(
        { family, kind: 'PREPARE_CANCEL', operationId: request.operationId, providerTarget: request.providerTarget },
        () => preparedOf(family, request.operationId, 'CANCEL'),
      ).pipe(Effect.catchTag('GatewayProviderOutcomeUnknown', (failure) => Effect.die(failure))),
    prepareCollect: (_target, request) =>
      run({ family, kind: 'PREPARE_COLLECT', operationId: request.operationId }, () =>
        preparedOf(family, request.operationId, 'COLLECT'),
      ).pipe(Effect.catchTag('GatewayProviderOutcomeUnknown', (failure) => Effect.die(failure))),
    prepareRefund: (_target, request) =>
      run(
        { family, kind: 'PREPARE_REFUND', operationId: request.operationId, providerTarget: request.providerTarget },
        () => preparedOf(family, request.operationId, 'REFUND'),
      ).pipe(Effect.catchTag('GatewayProviderOutcomeUnknown', (failure) => Effect.die(failure))),
    replay: (_target, request, expected) =>
      run({ family, kind: 'REPLAY', operationId: expected.operationId }, () => request).pipe(
        Effect.andThen(respond({ family, kind: 'REPLAY', operationId: expected.operationId })),
      ),
    send: (_target, _prepared, expected) =>
      run({ family, kind: 'SEND', operationId: expected.operationId }, () => expected).pipe(
        Effect.andThen(respond({ family, kind: 'SEND', operationId: expected.operationId })),
        Effect.catchTag('GatewayProviderUnsupported', (failure) => Effect.die(failure)),
      ),
    verifyNotification: () => Effect.die('The executor never verifies notifications'),
  };
};

const adaptersOf = (world: World) =>
  Layer.succeed(GatewayProviderAdapters, {
    forFamily: (family) => Effect.succeed(adapterOf(world, family)),
  });

const recordOf = (
  identity: ProviderDispatchIdentity,
  state: string,
  extra: Partial<ProviderDispatchRecord> = {},
): ProviderDispatchRecord =>
  Schema.decodeUnknownSync(ProviderDispatchRecordSchema)({
    bindingId: identity.target.bindingId,
    credentialRevision: 1,
    customerRedirectUrl: Option.none(),
    endpointRef: Option.none(),
    environment: 'SANDBOX',
    idempotencyKeyHash: Option.none(),
    materialHash: identity.materialHash,
    notSentReason: Option.none(),
    operationId: identity.operationId,
    operationKind: identity.operationKind,
    orderReference: deriveProviderCorrelation(identity.operationId).orderReference,
    paymentId: identity.paymentId,
    preparedAt: Option.none(),
    providerAccountRef: identity.target.binding.providerAccountRef,
    providerFamily: identity.target.binding.providerFamily,
    providerPaymentRef: Option.none(),
    providerRefundRef: Option.none(),
    replayExpiresAt: Option.none(),
    replayStartsAt: Option.none(),
    requestBody: Option.none(),
    requestHash: Option.none(),
    requestHeaders: Option.none(),
    respondedAt: Option.none(),
    returnToken: Option.none(),
    state,
    targetOperationId: identity.targetOperationId,
    ...extra,
  });

const update = (world: World, operationId: string, change: Partial<ProviderDispatchRecord>) =>
  Effect.sync(() => {
    const current = world.dispatches.get(operationId);
    if (current === undefined) {
      throw new Error(`no dispatch ${operationId}`);
    }
    const next: ProviderDispatchRecord = { ...current, ...change };
    world.dispatches.set(operationId, next);
    return next;
  });

const recordUnsent = (
  world: World,
  identity: ProviderDispatchIdentity,
  state: string,
  reason: Option.Option<ProviderNotSentReason>,
) =>
  Effect.sync(() => {
    const record = recordOf(identity, state, { notSentReason: reason });
    world.dispatches.set(identity.operationId, record);
    return record;
  });

const paymentRefOf = (world: World, operationId: string) =>
  Option.fromUndefinedOr(world.dispatches.get(operationId)).pipe(Option.flatMap((row) => row.providerPaymentRef));

/** The fake keeps every acknowledged refund unresolved (it holds no refund evidence). */
const unresolvedRefundOf = (paymentRef: ProviderObjectRef) => (row: ProviderDispatchRecord) =>
  row.operationKind === 'REFUND' &&
  Option.exists(row.providerPaymentRef, (ref) => sameRef(ref, paymentRef)) &&
  (row.state === 'PREPARED' || row.state === 'OUTCOME_UNKNOWN' || row.state === 'ACKNOWLEDGED');

const ledgerOf = (world: World): ProviderDispatchLedgerContract => ({
  correlateUnknown: () => Effect.die('unused'),
  hasUnresolvedRefund: ({ providerPaymentRef }) =>
    Effect.sync(() => [...world.dispatches.values()].some(unresolvedRefundOf(providerPaymentRef))),
  prepare: ({ identity, prepared, returnToken }) =>
    Effect.gen(function* prepareFake() {
      const now = yield* DateTime.now;
      const existing = world.dispatches.get(identity.operationId);
      if (existing !== undefined && existing.state !== 'AWAITING_TARGET') {
        return existing.materialHash === identity.materialHash
          ? { _tag: 'EXISTING' as const, record: existing }
          : { _tag: 'CONFLICT' as const, existing };
      }
      const targetRef = identity.targetOperationId.pipe(Option.flatMap((target) => paymentRefOf(world, target)));
      const replay = Option.isSome(prepared.replayWindowMs);
      const record = recordOf(identity, 'PREPARED', {
        endpointRef: Option.some(prepared.endpointRef),
        idempotencyKeyHash: prepared.idempotencyKey.pipe(Option.map(idempotencyKeyHashOf)),
        preparedAt: Option.some(now),
        providerPaymentRef: targetRef,
        replayExpiresAt: replay ? Option.some(DateTime.add(now, { milliseconds: 86_400_000 })) : Option.none(),
        replayStartsAt: replay ? Option.some(now) : Option.none(),
        requestBody: replay ? Option.some(prepared.body) : Option.none(),
        requestHash: Option.some(prepared.requestHash),
        requestHeaders: replay ? Option.some(prepared.headers) : Option.none(),
        returnToken,
      });
      world.dispatches.set(identity.operationId, record);
      if (world.crashOnPrepareCommit) {
        return yield* Effect.die('process crashed before the prepare committed');
      }
      return { _tag: 'PREPARED' as const, record };
    }),
  readByOperation: ({ operationId }) => Effect.sync(() => Option.fromUndefinedOr(world.dispatches.get(operationId))),
  readByOrderReference: () => Effect.die('unused'),
  readByProviderRef: () => Effect.die('unused'),
  recordAcknowledged: ({ customerRedirectUrl, operationId, providerPaymentRef, providerRefundRef }) =>
    Effect.suspend(() => {
      const current = world.dispatches.get(operationId);
      return update(world, operationId, {
        customerRedirectUrl,
        providerPaymentRef: Option.orElse(current?.providerPaymentRef ?? Option.none(), () => providerPaymentRef),
        providerRefundRef,
        state: 'ACKNOWLEDGED',
      });
    }),
  recordNotSent: ({ identity, reason }) => recordUnsent(world, identity, 'NOT_SENT', Option.some(reason)),
  recordOutcomeUnknown: ({ operationId }) => update(world, operationId, { state: 'OUTCOME_UNKNOWN' }),
  recordRejected: ({ operationId }) => update(world, operationId, { state: 'REJECTED_BEFORE_EFFECT' }),
  recordTargetUnresolved: ({ operationId }) => update(world, operationId, { state: 'TARGET_UNRESOLVED' }),
  recordUnsupported: ({ identity }) => recordUnsent(world, identity, 'UNSUPPORTED', Option.none()),
  registerCancel: ({ cancel }) =>
    Effect.sync(() => {
      const existing = world.dispatches.get(cancel.operationId);
      const registered = existing ?? recordOf(cancel, 'AWAITING_TARGET');
      world.dispatches.set(cancel.operationId, registered);
      const target = cancel.targetOperationId.pipe(
        Option.flatMap((id) => Option.fromUndefinedOr(world.dispatches.get(id))),
      );
      return { cancel: registered, target };
    }),
});

const evidenceStoreOf = (world: World) =>
  Layer.succeed(ProviderEvidenceStore, {
    append: (input) =>
      Effect.sync(() => {
        const stored: StoredProviderEvidence = {
          bindingId: input.bindingId,
          evidence: input.evidence,
          evidenceId: ProviderEvidenceIdSchema.make(
            `aaaaaaaa-aaaa-4aaa-8aaa-${String(world.evidence.length).padStart(12, '0')}`,
          ),
          notificationId: Option.none(),
          operationId: input.operationId,
          origin: input.origin,
          paymentId: input.paymentId,
          receivedAt: input.evidence.observedAt,
          recordedAt: input.evidence.observedAt,
          submissionState: 'PENDING_SUBMISSION',
          verifiedAt: input.evidence.observedAt,
        };
        world.evidence.push(stored);
        return stored;
      }),
    listPending: () => Effect.die('unused'),
    markSubmission: () => Effect.die('unused'),
    pinSubmissionExecutor: () => Effect.die('unused'),
  });

const testCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    digest: (_algorithm, data) => Effect.succeed(data),
    randomBytes: (size) => new Uint8Array(size).fill(251),
  }),
);

/** Runs one delivery of `spec` against the world; returns its exit. */
const deliver = (world: World, spec: OperationSpec, overrides: { readonly materialHash?: string } = {}) =>
  Effect.exit(executeGatewayOperation(payloadOf(spec, overrides), contextOf())).pipe(
    Effect.provide(
      Layer.mergeAll(
        fanoutOf(world),
        resolverOf(world),
        adaptersOf(world),
        Layer.succeed(ProviderDispatchLedger, ledgerOf(world)),
        evidenceStoreOf(world),
        testCrypto,
      ),
    ),
  );

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

const stateOf = (world: World, operationId: string) => world.dispatches.get(operationId)?.state;
const sends = (world: World, kind: ProviderCall['kind'] = 'SEND') =>
  world.calls.filter((call) => call.kind === kind).length;
const factsOf = (world: World) => world.evidence.map((stored) => [stored.operationId, stored.evidence.factKind]);

const at = (millisAfterRequest: number) => TestClock.setTime(DateTime.toEpochMillis(REQUESTED_AT) + millisAfterRequest);

const collectSpec = (family: Family): OperationSpec => ({ family, kind: 'COLLECT', operationId: COLLECT_ID });
const cancelSpec = (family: Family): OperationSpec => ({
  family,
  kind: 'CANCEL_OR_VOID',
  operationId: CANCEL_ID,
  targetOperationId: COLLECT_ID,
});

const withOperations = (world: World, ...specs: OperationSpec[]) => {
  for (const spec of specs) {
    world.operations.set(spec.operationId, spec);
  }
  return world;
};

describe('#1158 Gateway executor deferral schedule', () => {
  it('#1158 Waits start at 60 s, double the time waited and stop at the deadline', () => {
    const deadline = DateTime.add(REQUESTED_AT, { milliseconds: 86_400_000 });
    const after = (ms: number) => DateTime.add(REQUESTED_AT, { milliseconds: ms });
    const base = DateTime.toEpochMillis(REQUESTED_AT);
    expect(nextWakeAt(after(0), REQUESTED_AT, deadline)).toEqual(Option.some(base + 60_000));
    expect(nextWakeAt(after(60_000), REQUESTED_AT, deadline)).toEqual(Option.some(base + 120_000));
    expect(nextWakeAt(after(20 * HOUR_MS), REQUESTED_AT, deadline)).toEqual(Option.some(base + 86_400_000));
    expect(nextWakeAt(after(86_399_500), REQUESTED_AT, deadline)).toEqual(Option.none());
  });
});

describe('#1156 #1158 Gateway operation executor', () => {
  it.effect('#1158 Crash before durable handoff sends nothing', () =>
    Effect.gen(function* crashBeforeHandoff() {
      yield* at(0);
      const world = withOperations(newWorld(), collectSpec('GOPAY'));
      world.crashOnPrepareCommit = true;
      const crashed = yield* deliver(world, collectSpec('GOPAY'));
      expect(Exit.isFailure(crashed)).toBe(true);
      expect(sends(world)).toBe(0);
      expect(world.dispatches.size).toBe(0);

      world.crashOnPrepareCommit = false;
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('GOPAY')))).toBe(true);
      expect(sends(world)).toBe(1);
      const record = world.dispatches.get(COLLECT_ID);
      expect(record?.state).toBe('ACKNOWLEDGED');
      expect(record?.providerPaymentRef).toEqual(Option.some(PAYMENT_REFS.GOPAY));
      expect(record?.customerRedirectUrl).toEqual(Option.some('https://pay.example.test/1'));
      // 128 random bits as 22 base64url characters, generated once before the first prepare.
      expect((record?.returnToken ?? Option.none()).pipe(Option.map((token) => token.length))).toEqual(Option.some(22));
      // COLLECTION_PENDING is not kept as submission debt.
      expect(world.evidence).toEqual([]);
    }),
  );

  it.effect('#1158 Crash after handoff never double-sends', () =>
    Effect.gen(function* crashAfterHandoff() {
      yield* at(0);
      for (const family of ['GOPAY', 'COMGATE'] as const) {
        const world = withOperations(newWorld(), collectSpec(family));
        world.failures.set(`${family}:SEND`, () => Effect.die('process crashed after the request left'));
        expect(Exit.isFailure(yield* deliver(world, collectSpec(family)))).toBe(true);
        expect(stateOf(world, COLLECT_ID)).toBe('PREPARED');

        world.failures.clear();
        expect(Exit.isSuccess(yield* deliver(world, collectSpec(family)))).toBe(true);
        expect([sends(world), sends(world, 'PREPARE_COLLECT'), sends(world, 'REPLAY')]).toEqual([1, 1, 0]);
        expect(stateOf(world, COLLECT_ID)).toBe('OUTCOME_UNKNOWN');
      }

      // Stripe replays the exact persisted request instead of sending a new one.
      const stripe = withOperations(newWorld(), collectSpec('STRIPE'));
      stripe.failures.set('STRIPE:SEND', () => Effect.die('process crashed after the request left'));
      expect(Exit.isFailure(yield* deliver(stripe, collectSpec('STRIPE')))).toBe(true);
      stripe.failures.clear();
      expect(Exit.isSuccess(yield* deliver(stripe, collectSpec('STRIPE')))).toBe(true);
      expect([sends(stripe), sends(stripe, 'PREPARE_COLLECT'), sends(stripe, 'REPLAY')]).toEqual([1, 1, 1]);
      expect(stateOf(stripe, COLLECT_ID)).toBe('ACKNOWLEDGED');
    }),
  );

  it.effect('#1156 Cancellation races with collection (cancel first)', () =>
    Effect.gen(function* cancelFirst() {
      yield* at(0);
      const world = withOperations(newWorld(), collectSpec('STRIPE'), cancelSpec('STRIPE'));
      expect(Exit.isSuccess(yield* deliver(world, cancelSpec('STRIPE')))).toBe(true);
      expect(world.dispatches.get(COLLECT_ID)?.notSentReason).toEqual(Option.some('WITHHELD_FOR_CANCELLATION'));
      expect(world.dispatches.get(CANCEL_ID)?.notSentReason).toEqual(Option.some('TARGET_WITHHELD'));
      expect(factsOf(world)).toEqual([
        [COLLECT_ID, 'COLLECTION_NOT_EFFECTED'],
        [CANCEL_ID, 'CANCEL_CONFIRMED'],
      ]);
      expect(world.evidence.map((stored) => stored.evidence.reason)).toEqual([
        Option.some('withheld_for_cancellation'),
        Option.some('withheld_for_cancellation'),
      ]);

      // The collection delivery arrives later: nothing is prepared or sent.
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('STRIPE')))).toBe(true);
      expect(world.calls).toEqual([]);
    }),
  );

  it.effect('#1156 Cancellation races with collection (collection first)', () =>
    Effect.gen(function* collectionFirst() {
      yield* at(0);
      const world = withOperations(newWorld(), collectSpec('STRIPE'), cancelSpec('STRIPE'));
      // The collection's answer is still unknown: the cancel waits, never confirms.
      world.script = (call) =>
        call.kind === 'SEND' && call.operationId === COLLECT_ID
          ? Effect.fail(
              new GatewayProviderOutcomeUnknown({
                code: 'gateway_provider_outcome_unknown',
                family: 'STRIPE',
                operationId: COLLECT_ID,
                reason: 'timeout',
              }),
            )
          : 'DEFAULT';
      expect(Option.isSome(deferredWake(yield* deliver(world, collectSpec('STRIPE'))))).toBe(true);
      const waiting = yield* deliver(world, cancelSpec('STRIPE'));
      expect(deferredWake(waiting)).toEqual(Option.some(DateTime.toEpochMillis(REQUESTED_AT) + 60_000));
      expect(stateOf(world, CANCEL_ID)).toBe('AWAITING_TARGET');

      // The collection replay resolves it; the cancel is then sent with the collection's provider object.
      world.script = () => 'DEFAULT';
      yield* at(60_000);
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('STRIPE')))).toBe(true);
      expect(Exit.isSuccess(yield* deliver(world, cancelSpec('STRIPE')))).toBe(true);
      expect(world.calls.find((call) => call.kind === 'PREPARE_CANCEL')?.providerTarget).toEqual(PAYMENT_REFS.STRIPE);
      expect(stateOf(world, CANCEL_ID)).toBe('ACKNOWLEDGED');
      expect(factsOf(world)).toEqual([[CANCEL_ID, 'CANCEL_CONFIRMED']]);
    }),
  );

  it.effect('#1156 A cancel whose target never resolves ends TARGET_UNRESOLVED, never CANCEL_CONFIRMED', () =>
    Effect.gen(function* cancelExhausted() {
      yield* at(0);
      const world = withOperations(newWorld(), collectSpec('GOPAY'), cancelSpec('GOPAY'));
      world.failures.set('GOPAY:SEND', () => Effect.die('process crashed after the request left'));
      expect(Exit.isFailure(yield* deliver(world, collectSpec('GOPAY')))).toBe(true);
      expect(Option.isSome(deferredWake(yield* deliver(world, cancelSpec('GOPAY'))))).toBe(true);
      yield* at(86_400_000);
      expect(Exit.isSuccess(yield* deliver(world, cancelSpec('GOPAY')))).toBe(true);
      expect(stateOf(world, CANCEL_ID)).toBe('TARGET_UNRESOLVED');
      expect(factsOf(world)).toEqual([]);
    }),
  );

  it.effect('#1156 Unrelated gateway is unavailable', () =>
    Effect.gen(function* unrelatedUnavailable() {
      yield* at(0);
      const gopay: OperationSpec = { family: 'GOPAY', kind: 'COLLECT', operationId: COLLECT_ID };
      const stripe: OperationSpec = { family: 'STRIPE', kind: 'COLLECT', operationId: CANCEL_ID };
      const world = withOperations(newWorld(), gopay, stripe);
      world.brokenResolverFamilies.add('GOPAY');
      expect(Option.isSome(deferredWake(yield* deliver(world, gopay)))).toBe(true);
      expect(Exit.isSuccess(yield* deliver(world, stripe))).toBe(true);
      expect(stateOf(world, CANCEL_ID)).toBe('ACKNOWLEDGED');
      expect(world.calls.every((call) => call.family === 'STRIPE')).toBe(true);
      expect(stateOf(world, COLLECT_ID)).toBe(undefined);

      // A binding that stays unresolvable past the wait budget fails typed for Core's retry policy.
      yield* at(86_400_000);
      expect(failureTag(yield* deliver(world, gopay))).toEqual(Option.some('GatewayProviderUnavailable'));
    }),
  );

  it.effect('#1158 Same logical refund but changed basis conflicts', () =>
    Effect.gen(function* changedBasis() {
      yield* at(0);
      const refund: OperationSpec = {
        family: 'GOPAY',
        kind: 'REFUND',
        materialHash: 'e'.repeat(64),
        operationId: REFUND_ID,
        targetOperationId: COLLECT_ID,
      };
      const world = withOperations(newWorld(), collectSpec('GOPAY'), refund);
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('GOPAY')))).toBe(true);
      expect(Exit.isSuccess(yield* deliver(world, refund))).toBe(true);
      expect(world.calls.find((call) => call.kind === 'PREPARE_REFUND')?.providerTarget).toEqual(PAYMENT_REFS.GOPAY);
      const callsBefore = world.calls.length;

      // The same refund operation with another basis hashes to other material: no provider call at all.
      const changed: OperationSpec = { ...refund, materialHash: 'f'.repeat(64) };
      world.operations.set(REFUND_ID, changed);
      expect(failureTag(yield* deliver(world, changed))).toEqual(Option.some('GatewayDispatchConflict'));
      // A message whose material disagrees with the stored operation is refused before any read of the ledger.
      expect(failureTag(yield* deliver(world, changed, { materialHash: 'e'.repeat(64) }))).toEqual(
        Option.some('GatewayDispatchConflict'),
      );
      expect(world.calls.length).toBe(callsBefore);
    }),
  );

  it.effect('#1158 A second GoPay refund waits for the first, then ends NOT_SENT', () =>
    Effect.gen(function* serializedRefund() {
      yield* at(0);
      const first: OperationSpec = {
        family: 'GOPAY',
        kind: 'REFUND',
        operationId: REFUND_ID,
        targetOperationId: COLLECT_ID,
      };
      const second: OperationSpec = { ...first, operationId: '55555555-5555-4555-8555-555555555554' };
      const world = withOperations(newWorld(), collectSpec('GOPAY'), first, second);
      for (const spec of [collectSpec('GOPAY'), first]) {
        expect(Exit.isSuccess(yield* deliver(world, spec))).toBe(true);
      }
      expect(Option.isSome(deferredWake(yield* deliver(world, second)))).toBe(true);
      yield* at(86_400_000);
      expect(Exit.isSuccess(yield* deliver(world, second))).toBe(true);
      expect(world.dispatches.get(second.operationId)?.notSentReason).toEqual(Option.some('PRIOR_REFUND_UNRESOLVED'));
      expect(factsOf(world).at(-1)).toEqual([second.operationId, 'REFUND_NOT_EFFECTED']);
      expect(sends(world, 'PREPARE_REFUND')).toBe(1);
    }),
  );

  it.effect('#1158 A Stripe refund names the PaymentIntent its confirmed checkout session paid', () =>
    Effect.gen(function* stripeRefundTarget() {
      yield* at(0);
      const refund: OperationSpec = {
        family: 'STRIPE',
        kind: 'REFUND',
        operationId: REFUND_ID,
        targetOperationId: COLLECT_ID,
      };
      const world = withOperations(newWorld(), collectSpec('STRIPE'), refund);
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('STRIPE')))).toBe(true);
      expect(paymentRefOf(world, COLLECT_ID)).toEqual(Option.some(PAYMENT_REFS.STRIPE));
      expect(Exit.isSuccess(yield* deliver(world, refund))).toBe(true);
      expect(world.calls.find((call) => call.kind === 'LOOKUP')?.operationId).toBe(COLLECT_ID);
      expect(world.calls.find((call) => call.kind === 'PREPARE_REFUND')?.providerTarget).toEqual(STRIPE_PAYMENT_INTENT);
      expect(stateOf(world, REFUND_ID)).toBe('ACKNOWLEDGED');

      // A session the lookup cannot confirm leaves the refund unresolved: wait, then NOT_SENT, never a guess.
      const unresolved = withOperations(newWorld(), collectSpec('STRIPE'), refund);
      expect(Exit.isSuccess(yield* deliver(unresolved, collectSpec('STRIPE')))).toBe(true);
      unresolved.failures.set('STRIPE:LOOKUP', () =>
        Effect.fail(
          new GatewayProviderUnavailable({
            code: 'gateway_provider_unavailable',
            family: 'STRIPE',
            reason: 'provider_throttled',
          }),
        ),
      );
      expect(Option.isSome(deferredWake(yield* deliver(unresolved, refund)))).toBe(true);
      yield* at(86_400_000);
      expect(Exit.isSuccess(yield* deliver(unresolved, refund))).toBe(true);
      expect(unresolved.dispatches.get(REFUND_ID)?.notSentReason).toEqual(Option.some('PREPARE_UNAVAILABLE'));
      expect(sends(unresolved, 'PREPARE_REFUND')).toBe(0);
    }),
  );

  it.effect('#1156 Unsupported provider operation yields typed unsupported, no fallback', () =>
    Effect.gen(function* unsupportedCancel() {
      yield* at(0);
      const world = withOperations(newWorld(), collectSpec('GOPAY'), cancelSpec('GOPAY'));
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('GOPAY')))).toBe(true);
      world.failures.set('GOPAY:PREPARE_CANCEL', () =>
        Effect.fail(
          new GatewayProviderUnsupported({
            capability: 'CANCEL_OR_VOID',
            code: 'gateway_provider_unsupported',
            family: 'GOPAY',
            reason: 'provider_cancel_unsupported',
          }),
        ),
      );
      expect(Exit.isSuccess(yield* deliver(world, cancelSpec('GOPAY')))).toBe(true);
      expect(stateOf(world, CANCEL_ID)).toBe('UNSUPPORTED');
      expect(factsOf(world)).toEqual([[CANCEL_ID, 'CANCEL_NOT_EFFECTED']]);
      expect(world.evidence[0]?.evidence.reason).toEqual(Option.some('provider_cancel_unsupported'));
      expect(world.evidence[0]?.origin).toBe('LOCAL_NOT_SENT');
      expect(world.calls.every((call) => call.family === 'GOPAY')).toBe(true);
      expect(sends(world)).toBe(1);
    }),
  );

  it.effect('#1158 Stripe lost response recovered inside 24 h', () =>
    Effect.gen(function* stripeLostResponse() {
      yield* at(0);
      const world = withOperations(newWorld(), collectSpec('STRIPE'));
      world.script = (call) =>
        call.kind === 'SEND'
          ? Effect.fail(
              new GatewayProviderOutcomeUnknown({
                code: 'gateway_provider_outcome_unknown',
                family: 'STRIPE',
                operationId: COLLECT_ID,
                reason: 'timeout',
              }),
            )
          : 'DEFAULT';
      const first = yield* deliver(world, collectSpec('STRIPE'));
      expect(deferredWake(first)).toEqual(Option.some(DateTime.toEpochMillis(REQUESTED_AT) + 60_000));
      expect(stateOf(world, COLLECT_ID)).toBe('OUTCOME_UNKNOWN');

      yield* at(3 * HOUR_MS);
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('STRIPE')))).toBe(true);
      expect([sends(world), sends(world, 'REPLAY')]).toEqual([1, 1]);
      expect(stateOf(world, COLLECT_ID)).toBe('ACKNOWLEDGED');
    }),
  );

  it.effect('#1158 A Stripe outcome still unknown after its replay window stays as debt', () =>
    Effect.gen(function* stripeWindowClosed() {
      yield* at(0);
      const world = withOperations(newWorld(), collectSpec('STRIPE'));
      world.failures.set('STRIPE:SEND', () => Effect.die('process crashed after the request left'));
      expect(Exit.isFailure(yield* deliver(world, collectSpec('STRIPE')))).toBe(true);
      world.failures.clear();
      yield* at(25 * HOUR_MS);
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('STRIPE')))).toBe(true);
      expect([sends(world), sends(world, 'REPLAY')]).toEqual([1, 0]);
      expect(stateOf(world, COLLECT_ID)).toBe('OUTCOME_UNKNOWN');
    }),
  );

  it.effect('#1156 A missing Comgate payer contact ends NOT_SENT and never dead-letters', () =>
    Effect.gen(function* comgatePayerContact() {
      yield* at(0);
      const world = withOperations(newWorld(), collectSpec('COMGATE'));
      world.failures.set('COMGATE:PREPARE_COLLECT', () =>
        Effect.fail(
          new GatewayProviderUnavailable({
            code: 'gateway_provider_unavailable',
            family: 'COMGATE',
            reason: 'payer_contact_unavailable',
          }),
        ),
      );
      const waits: number[] = [];
      for (const elapsed of [0, HOUR_MS, 12 * HOUR_MS]) {
        yield* at(elapsed);
        waits.push(...Option.toArray(deferredWake(yield* deliver(world, collectSpec('COMGATE')))));
      }
      expect(waits.length).toBe(3);
      yield* at(86_400_000);
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('COMGATE')))).toBe(true);
      expect(world.dispatches.get(COLLECT_ID)?.notSentReason).toEqual(Option.some('PREPARE_UNAVAILABLE'));
      expect(factsOf(world)).toEqual([[COLLECT_ID, 'COLLECTION_NOT_EFFECTED']]);
      expect(sends(world)).toBe(0);
    }),
  );

  it.effect('#1153 An operation that is no longer PENDING completes without provider work', () =>
    Effect.gen(function* nothingToDo() {
      yield* at(0);
      const world = withOperations(newWorld(), { ...collectSpec('STRIPE'), outcome: 'INDETERMINATE' });
      expect(Exit.isSuccess(yield* deliver(world, collectSpec('STRIPE')))).toBe(true);
      expect([world.calls, world.dispatches.size]).toEqual([[], 0]);
    }),
  );
});

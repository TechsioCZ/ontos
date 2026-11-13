import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { GatewayContextResponseSchema } from '@app/shared-contracts';
import { GatewayDelegationSourceError } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationRequest } from '@app/shared-contracts/gateway-context-server';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { DateTime, Effect, Layer, Match, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { AcceptPaymentObservationActionForbiddenProblemSchema } from '../../shared/apis/accept-payment-observation-action.ts';
import type { AcceptPaymentObservationPayload } from '../../shared/actions/accept-payment-observation.ts';
import { PaymentOperationIdSchema } from '../../shared/domain/payment-identifiers.ts';
import { PaymentSourceStatementResultSchema } from '../../shared/domain/source-statement.ts';
import { GatewayBindingResolver } from '../../src/integrations/psp/binding-resolver.ts';
import { ProviderDispatchLedger, ProviderDispatchRecordSchema } from '../../src/integrations/psp/dispatch-ledger.ts';
import type { ProviderDispatchRecord } from '../../src/integrations/psp/dispatch-ledger.ts';
import { ProviderEvidenceStore, StoredProviderEvidenceSchema } from '../../src/integrations/psp/evidence-store.ts';
import type { StoredProviderEvidence } from '../../src/integrations/psp/evidence-store.ts';
import {
  ProviderEvidenceSubmissionTransport,
  ProviderEvidenceSubmitterLive,
} from '../../src/integrations/psp/evidence-submission-live.ts';
import {
  ProviderNotificationStore,
  StoredProviderNotificationSchema,
} from '../../src/integrations/psp/notification-store.ts';
import type { StoredProviderNotification } from '../../src/integrations/psp/notification-store.ts';
import {
  NotificationExpectedEffectReader,
  processProviderNotification,
  ProviderNotificationProcessingSchema,
} from '../../src/integrations/psp/provider-notification-processor.ts';
import type { ProviderNotificationProcessing } from '../../src/integrations/psp/provider-notification-processor.ts';
import { GatewayProviderAdapters } from '../../src/integrations/psp/psp-adapter.ts';
import { deriveProviderCorrelation } from '../../src/integrations/psp/psp-correlation.ts';
import type { GatewayOrderReference } from '../../src/integrations/psp/psp-correlation.ts';
import {
  GatewayEvidenceConflict,
  GatewayLedgerUnavailable,
  GatewayProviderUnavailable,
} from '../../src/integrations/psp/psp-errors.ts';
import {
  GatewayExecutionTargetSchema,
  GatewayExpectedEffectSchema,
  GatewayLookupTargetSchema,
  ProviderObjectRefSchema,
} from '../../src/integrations/psp/psp-request.ts';
import type { GatewayLookupRequest, ProviderObjectRef } from '../../src/integrations/psp/psp-request.ts';
import { ProviderFindingResultSchema } from '../../src/integrations/psp/psp-result.ts';
import type { ProviderFindingResult } from '../../src/integrations/psp/psp-result.ts';

/**
 * #1156 #1157 Notification processing over in-memory ports: correlation strictly inside the notification's own
 * binding, evidence before submission, and the governed A8 submission through the RegisteredWorkload transport
 * seam (Shell gateway and A8 client replaced; their native paths are proven by the Shell probe and A8 suites).
 */

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const bindingA = '33333333-3333-4333-8333-333333333333';
const bindingB = '44444444-4444-4444-8444-444444444444';
const accountA = `pab_${'a'.repeat(32)}`;
const accountB = `pab_${'b'.repeat(32)}`;
const paymentId = '55555555-5555-4555-8555-555555555555';
const collectId = Schema.decodeUnknownSync(PaymentOperationIdSchema)('66666666-6666-4666-8666-666666666666');
const refundId = Schema.decodeUnknownSync(PaymentOperationIdSchema)('77777777-7777-4777-8777-777777777777');
const observationId = '88888888-8888-4888-8888-888888888888';
const authorityId = '99999999-9999-4999-8999-999999999999';
const RECEIVED_AT = '2026-11-12T09:00:00.000Z';
const OBSERVED_AT = '2026-11-12T09:00:05.000Z';
const AMOUNT = { amountMinor: 100_000, currency: 'CZK' } as const;

const workerContext: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  compositionRevision: 'c'.repeat(64),
  consumerModuleKey: 'payment.core',
  deliveryId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  domainEventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  originatorInvocationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  producerModuleKey: 'payment.core',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'payment.core.provider-notification-captured.v1',
  workerKey: 'payment.core.process-provider-notification',
};

const scope: OutboxWorkerLegalEntityScope = {
  completionPublisher: { publish: () => Effect.die('no completion is published') },
  legalEntityId,
  routineInvoker: { invoke: () => Effect.die('Payment is read only through the expected-effect reader here') },
  tenantId,
};

const providerRef = (input: typeof ProviderObjectRefSchema.Encoded) =>
  Schema.decodeUnknownSync(ProviderObjectRefSchema)(input);
const sameLookupTarget = Schema.toEquivalence(GatewayLookupTargetSchema);
const PI = providerRef({ _tag: 'STRIPE_PAYMENT_INTENT', id: 'pi_test_notification' });
const SESSION = providerRef({ _tag: 'STRIPE_CHECKOUT_SESSION', id: 'cs_test_notification' });
const REFUND = providerRef({ _tag: 'STRIPE_REFUND', id: 're_test_notification' });
const refundTarget = Schema.decodeUnknownSync(GatewayLookupTargetSchema)({
  _tag: 'PROVIDER_OBJECT',
  ref: { _tag: 'STRIPE_REFUND', id: 're_test_notification' },
});

const FamilySchema = Schema.Literals(['GOPAY', 'STRIPE']);
type Family = typeof FamilySchema.Type;

const targetFor = (bindingId: string, accountRef: string, family: Family = 'STRIPE') =>
  Schema.decodeUnknownSync(GatewayExecutionTargetSchema)({
    binding: {
      _tag: 'GATEWAY_ACCOUNT',
      environment: 'SANDBOX',
      providerAccountRef: accountRef,
      providerFamily: family,
    },
    bindingId,
    credentialRevision: 1,
    credentialSecretRef: `${family.toLowerCase()}-sandbox-1`,
    legalEntityId,
    merchantIdentity:
      family === 'STRIPE' ? { _tag: 'STRIPE', accountId: 'acct_1TestAccount' } : { _tag: 'GOPAY', goid: '8123456789' },
    notificationUrl: 'https://hooks.example.test/psp',
    returnUrl: Option.none(),
    tenantId,
  });

interface RecordInput {
  readonly bindingId?: string;
  readonly family?: Family;
  readonly kind?: 'COLLECT' | 'REFUND';
  readonly payment?: ProviderObjectRef;
  readonly refund?: ProviderObjectRef;
  readonly state?: 'ACKNOWLEDGED' | 'OUTCOME_UNKNOWN' | 'PREPARED';
}

const recordOf = (input: RecordInput): ProviderDispatchRecord => {
  const kind = input.kind ?? 'COLLECT';
  const operationId = kind === 'REFUND' ? refundId : collectId;
  return Schema.decodeUnknownSync(ProviderDispatchRecordSchema)({
    bindingId: input.bindingId ?? bindingA,
    credentialRevision: 1,
    customerRedirectUrl: Option.none(),
    endpointRef: Option.some(
      input.family === 'GOPAY' ? 'gopay:POST:/payments/payment' : 'stripe:POST:/v1/checkout/sessions',
    ),
    environment: 'SANDBOX',
    idempotencyKeyHash: Option.none(),
    materialHash: 'f'.repeat(64),
    notSentReason: Option.none(),
    operationId,
    operationKind: kind,
    orderReference: deriveProviderCorrelation(operationId).orderReference,
    paymentId,
    preparedAt: Option.some(DateTime.makeUnsafe('2026-11-12T08:00:00.000Z')),
    providerAccountRef: input.bindingId === bindingB ? accountB : accountA,
    providerFamily: input.family ?? 'STRIPE',
    providerPaymentRef: Option.fromUndefinedOr(input.payment),
    providerRefundRef: Option.fromUndefinedOr(input.refund),
    replayExpiresAt: Option.none(),
    replayStartsAt: Option.none(),
    requestBody: Option.none(),
    requestHash: Option.some('a'.repeat(64)),
    requestHeaders: Option.none(),
    respondedAt: Option.none(),
    returnToken: Option.none(),
    state: input.state ?? 'ACKNOWLEDGED',
    targetOperationId: kind === 'REFUND' ? Option.some(collectId) : Option.none(),
  });
};

interface NotificationInput {
  readonly bindingId?: string;
  readonly family?: Family;
  readonly id: string;
  readonly refs: readonly ProviderObjectRef[];
  readonly signedObject?: Schema.Json;
}

const notificationOf = (input: NotificationInput): StoredProviderNotification =>
  Schema.decodeUnknownSync(StoredProviderNotificationSchema)({
    bindingId: input.bindingId ?? bindingA,
    correlatedOperationId: Option.none(),
    environment: 'SANDBOX',
    notificationId: input.id,
    providerAccountRef: input.bindingId === bindingB ? accountB : accountA,
    receivedAt: DateTime.makeUnsafe(RECEIVED_AT),
    state: 'CAPTURED',
    trigger: {
      actionable: true,
      // A GoPay callback is unsigned: only the id is carried and a lookup decides (LOOKUP_REQUIRED).
      authenticity: input.family === 'GOPAY' ? 'LOOKUP_REQUIRED' : 'SIGNATURE_VERIFIED',
      claimedStatus: Option.none(),
      deliveryIdentity: input.family === 'GOPAY' ? `gopay:3000006529:${input.id}` : `stripe:evt:${input.id}`,
      family: input.family ?? 'STRIPE',
      providerEventAt: Option.none(),
      providerOccurrenceId: Option.none(),
      providerRefs: input.refs,
      signedObject: Option.fromUndefinedOr(input.signedObject),
      verifiedAt: DateTime.makeUnsafe(RECEIVED_AT),
    },
  });

interface FindingInput {
  readonly factKind: 'COLLECTION_CONFIRMED' | 'REFUND_CONFIRMED' | 'REFUND_NOT_EFFECTED';
  readonly kind: 'COLLECT' | 'REFUND';
  readonly orderReference?: boolean;
  readonly refs: readonly ProviderObjectRef[];
}

const findingOf = (input: FindingInput): ProviderFindingResult => {
  const operationId = input.kind === 'REFUND' ? refundId : collectId;
  const family = input.kind === 'REFUND' ? 'REFUND_EXECUTION' : 'GATEWAY_OUTCOME';
  return Schema.decodeUnknownSync(ProviderFindingResultSchema)({
    customerAction: Option.none(),
    evidence: Option.some({
      discrepancy: Option.none(),
      economicEffectKey: Option.some(input.kind === 'REFUND' ? 're_test_notification' : 'pi_test_notification'),
      factFamily: family,
      factKind: input.factKind,
      observedAmount: Option.some(AMOUNT),
      observedAt: DateTime.makeUnsafe(OBSERVED_AT),
      providerOccurredAt: Option.none(),
      providerRefs: input.refs,
      reason: Option.none(),
      sourceOccurrenceId: `stripe:notification_lookup:obj:${operationId}:${input.factKind}:100000`,
      sourceRevision: 0,
    }),
    finding: input.factKind === 'REFUND_NOT_EFFECTED' ? 'NOT_EFFECTED' : 'EFFECT_CONFIRMED',
    orderReference:
      input.orderReference === true
        ? Option.some(deriveProviderCorrelation(operationId).orderReference)
        : Option.none(),
    providerRefs: input.refs,
    target: { operationId, operationKind: input.kind },
  });
};

interface World {
  readonly acquired: Ref.Ref<readonly GatewayDelegationRequest[]>;
  readonly correlated: Ref.Ref<readonly string[]>;
  readonly evidence: Ref.Ref<readonly StoredProviderEvidence[]>;
  readonly lookups: Ref.Ref<readonly GatewayLookupRequest[]>;
  readonly notifications: Ref.Ref<readonly StoredProviderNotification[]>;
  readonly records: Ref.Ref<readonly ProviderDispatchRecord[]>;
  readonly statements: Ref.Ref<readonly AcceptPaymentObservationPayload[]>;
}

const A8AnswerSchema = Schema.Literals(['ACCEPTED', 'DELEGATION_REFUSED', 'SOURCE_FORBIDDEN']);
type A8Answer = typeof A8AnswerSchema.Type;

interface Setup {
  readonly a8?: A8Answer;
  /** Evidence already stored before the notification, e.g. a dispatch response the executor left pending. */
  readonly evidence?: readonly StoredProviderEvidence[];
  /** The family of the binding the notification resolves to; default STRIPE. */
  readonly family?: Family;
  readonly findings: (request: GatewayLookupRequest) => readonly ProviderFindingResult[];
  readonly notifications: readonly StoredProviderNotification[];
  /** The executor already pinned on every evidence row, as a committed earlier attempt left it. */
  readonly pinnedExecutor?: string;
  /** What the binding's own read of a provider object states as its order reference; default `None`. */
  readonly readOrderReference?: (ref: ProviderObjectRef) => Option.Option<GatewayOrderReference>;
  readonly records: readonly ProviderDispatchRecord[];
  readonly resolvedBinding?: string;
}

const isRefundObject = Schema.is(ProviderObjectRefSchema.members[3]);
const isRefundExpectation = Schema.is(GatewayExpectedEffectSchema.members[1]);
const isCollectExpectation = Schema.is(GatewayExpectedEffectSchema.members[0]);

const sameRef = (left: ProviderObjectRef, right: ProviderObjectRef) =>
  Schema.toEquivalence(ProviderObjectRefSchema)(left, right);

/** The dispatch recorded this provider object as its payment or refund object. */
const ownsRef = (record: ProviderDispatchRecord, wanted: ProviderObjectRef) =>
  Option.exists(record.providerPaymentRef, (owned) => sameRef(owned, wanted)) ||
  Option.exists(record.providerRefundRef, (owned) => sameRef(owned, wanted));

/** Like the routine: a correlated operation of another binding than the notification's is refused. */
const isForeignOperation = (
  records: readonly ProviderDispatchRecord[],
  bindingId: string | undefined,
  operationId: string,
) => records.some((record) => record.operationId === operationId && record.bindingId !== bindingId);

const issuedContext = Schema.decodeUnknownSync(GatewayContextResponseSchema)({
  apiBaseUrl: '/payment-api',
  compositionRevision: 'c'.repeat(64),
  expiresAt: 1_762_934_460,
  machineContext: {
    authContextRef: 'job:payment.core.process-provider-notification:run:delivery',
    bindingIncarnation: 'abababab-abab-4bab-8bab-abababababab',
    principalId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  },
  token: 'test-assertion',
});

const { machineContext: issuedMachineContext } = issuedContext;
const ISSUED_EXECUTOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
/** What the gateway seam hands the submitter: the issued assertion with the receiving system principal. */
const issuedGrant = {
  apiBaseUrl: `http://shell.test${issuedContext.apiBaseUrl}`,
  authorization: `Bearer ${issuedContext.token}` as const,
  compositionRevision: issuedContext.compositionRevision,
  expiresAt: issuedContext.expiresAt,
  machineContext: issuedMachineContext,
};

/** One comparable line per processing result. */
const summaryOf = (result: ProviderNotificationProcessing) =>
  ProviderNotificationProcessingSchema.match(result, {
    ALREADY_PROCESSED: ({ state }) => `ALREADY_PROCESSED ${state}`,
    HELD_UNCORRELATED: ({ reason }) => `HELD_UNCORRELATED ${reason}`,
    NOT_FOUND: () => 'NOT_FOUND',
    SETTLED: ({ operationId, outcomes, state }) => `SETTLED ${operationId} ${state} [${outcomes.join(',')}]`,
    SUBMISSION_PENDING: ({ operationId, reason }) => `SUBMISSION_PENDING ${operationId} ${reason}`,
  });

const unexpected = (name: string) => () => Effect.die(`${name} is not used by notification processing`);

const statementResult = (payload: AcceptPaymentObservationPayload) =>
  Schema.decodeUnknownSync(PaymentSourceStatementResultSchema)({
    acceptanceOutcome: 'ACCEPTED_OBSERVATION',
    interpretation: 'TRANSITION',
    observationId,
    operationId: payload.operationId,
    paymentId: payload.paymentId,
    sourceAuthorityId: authorityId,
  });

const sourceForbidden = Schema.decodeUnknownSync(AcceptPaymentObservationActionForbiddenProblemSchema)({
  _tag: 'AcceptPaymentObservationActionForbiddenProblem',
  code: 'payment_source_authority_forbidden',
  detail: 'No configured source authority',
  status: 403,
  title: 'Forbidden',
  type: 'about:blank',
});

/** Builds every port of the processor over one in-memory world. */
const layerFor = (setup: Setup, world: World) => {
  const notificationStore = Layer.succeed(ProviderNotificationStore, {
    read: ({ notificationId }) =>
      Ref.get(world.notifications).pipe(
        Effect.map((rows) => Option.fromUndefinedOr(rows.find((row) => row.notificationId === notificationId))),
      ),
    transition: ({ correlatedOperationId, notificationId, to }) =>
      Effect.gen(function* transition() {
        const rows = yield* Ref.get(world.notifications);
        const records = yield* Ref.get(world.records);
        const row = rows.find((candidate) => candidate.notificationId === notificationId);
        const foreign = Option.exists(correlatedOperationId, (operationId) =>
          isForeignOperation(records, row?.bindingId, operationId),
        );
        if (row === undefined || foreign) {
          return yield* Effect.fail(
            new GatewayLedgerUnavailable({
              code: 'gateway_ledger_unavailable',
              reason: 'notification_transition_refused:binding_mismatch',
            }),
          );
        }
        const next = { ...row, correlatedOperationId, state: to };
        yield* Ref.set(
          world.notifications,
          rows.map((candidate) => (candidate.notificationId === notificationId ? next : candidate)),
        );
        return next;
      }),
  });
  const ledger = Layer.succeed(ProviderDispatchLedger, {
    correlateUnknown: ({ orderReference, providerRef: correlatedRef }) =>
      Effect.gen(function* correlate() {
        yield* Ref.update(world.correlated, (all) => [...all, orderReference]);
        const records = yield* Ref.get(world.records);
        // Like the routine: a dispatch whose response was never recorded takes the ref of its object's kind.
        const refund = isRefundObject(correlatedRef);
        const updated = records.map((record) =>
          record.orderReference === orderReference &&
          (record.state === 'OUTCOME_UNKNOWN' || record.state === 'PREPARED')
            ? {
                ...record,
                providerPaymentRef: refund ? record.providerPaymentRef : Option.some(correlatedRef),
                providerRefundRef: refund ? Option.some(correlatedRef) : record.providerRefundRef,
                state: 'ACKNOWLEDGED' as const,
              }
            : record,
        );
        yield* Ref.set(world.records, updated);
        return Option.fromUndefinedOr(updated.find((record) => record.orderReference === orderReference));
      }),
    hasUnresolvedRefund: unexpected('hasUnresolvedRefund'),
    prepare: unexpected('prepare'),
    readByOperation: unexpected('readByOperation'),
    readByOrderReference: ({ bindingId, orderReference }) =>
      Ref.get(world.records).pipe(
        Effect.map((records) =>
          Option.fromUndefinedOr(
            records.find((record) => record.bindingId === bindingId && record.orderReference === orderReference),
          ),
        ),
      ),
    readByProviderRef: ({ bindingId, providerRef: wanted }) =>
      Ref.get(world.records).pipe(
        Effect.map((records) =>
          Option.fromUndefinedOr(records.find((record) => record.bindingId === bindingId && ownsRef(record, wanted))),
        ),
      ),
    recordAcknowledged: unexpected('recordAcknowledged'),
    recordNotSent: unexpected('recordNotSent'),
    recordOutcomeUnknown: unexpected('recordOutcomeUnknown'),
    recordRejected: unexpected('recordRejected'),
    recordTargetUnresolved: unexpected('recordTargetUnresolved'),
    recordUnsupported: unexpected('recordUnsupported'),
    registerCancel: unexpected('registerCancel'),
  });
  const evidenceStore = Layer.succeed(ProviderEvidenceStore, {
    append: (input) =>
      Effect.gen(function* append() {
        const rows = yield* Ref.get(world.evidence);
        const existing = rows.find((row) => row.evidence.sourceOccurrenceId === input.evidence.sourceOccurrenceId);
        if (existing !== undefined) {
          return existing;
        }
        const stored = Schema.decodeUnknownSync(StoredProviderEvidenceSchema)({
          bindingId: input.bindingId,
          evidence: input.evidence,
          evidenceId: `0000000${rows.length}-0000-4000-8000-000000000000`,
          notificationId: input.notificationId,
          operationId: input.operationId,
          origin: input.origin,
          paymentId: input.paymentId,
          receivedAt: DateTime.makeUnsafe(RECEIVED_AT),
          recordedAt: DateTime.makeUnsafe(OBSERVED_AT),
          submissionExecutorPrincipalId: setup.pinnedExecutor,
          submissionState: 'PENDING_SUBMISSION',
          verifiedAt: input.evidence.observedAt,
        });
        yield* Ref.set(world.evidence, [...rows, stored]);
        return stored;
      }),
    listPending: ({ operationId }) =>
      Ref.get(world.evidence).pipe(
        Effect.map((rows) =>
          rows.filter((row) => row.operationId === operationId && row.submissionState === 'PENDING_SUBMISSION'),
        ),
      ),
    markSubmission: ({ evidenceId, outcome }) =>
      Effect.gen(function* mark() {
        const rows = yield* Ref.get(world.evidence);
        const updated = rows.map((row) => (row.evidenceId === evidenceId ? { ...row, submissionState: outcome } : row));
        yield* Ref.set(world.evidence, updated);
        const marked = updated.find((row) => row.evidenceId === evidenceId);
        return marked ?? (yield* Effect.die('unknown evidence'));
      }),
    // Like the routine: write-once while pending; the same principal again is unchanged.
    pinSubmissionExecutor: ({ evidenceId, principalId }) =>
      Effect.gen(function* pin() {
        const rows = yield* Ref.get(world.evidence);
        const row = rows.find((candidate) => candidate.evidenceId === evidenceId);
        if (row === undefined || (row.submissionExecutorPrincipalId ?? principalId) !== principalId) {
          return yield* Effect.fail(
            new GatewayEvidenceConflict({ code: 'gateway_evidence_conflict', reason: 'executor_mismatch' }),
          );
        }
        const pinned = { ...row, submissionExecutorPrincipalId: principalId };
        yield* Ref.set(
          world.evidence,
          rows.map((candidate) => (candidate.evidenceId === evidenceId ? pinned : candidate)),
        );
        return pinned;
      }),
  });
  const resolver = Layer.succeed(GatewayBindingResolver, {
    resolveExecutionTarget: unexpected('resolveExecutionTarget'),
    resolveForNotification: ({ providerAccountRef }) =>
      Effect.succeed(
        setup.resolvedBinding === undefined
          ? targetFor(providerAccountRef === accountB ? bindingB : bindingA, providerAccountRef, setup.family)
          : targetFor(setup.resolvedBinding, providerAccountRef, setup.family),
      ),
  });
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
        family: setup.family ?? 'STRIPE',
        lookup: (_target, request) =>
          Ref.update(world.lookups, (all) => [...all, request]).pipe(Effect.as(setup.findings(request))),
        prepareCancel: unexpected('prepareCancel'),
        prepareCollect: unexpected('prepareCollect'),
        prepareRefund: unexpected('prepareRefund'),
        readOrderReference: (_target, ref) => Effect.succeed(setup.readOrderReference?.(ref) ?? Option.none()),
        replay: unexpected('replay'),
        send: unexpected('send'),
        verifyNotification: unexpected('verifyNotification'),
      }),
  });
  return Layer.mergeAll(notificationStore, ledger, resolver, adapters, ProviderEvidenceSubmitterLive).pipe(
    Layer.provideMerge(evidenceStore),
    Layer.provide(nodeCryptoLayer),
  );
};

const run = (setup: Setup, notificationId: string) =>
  Effect.gen(function* runScenario() {
    const world: World = {
      acquired: yield* Ref.make<readonly GatewayDelegationRequest[]>([]),
      correlated: yield* Ref.make<readonly string[]>([]),
      evidence: yield* Ref.make<readonly StoredProviderEvidence[]>(setup.evidence ?? []),
      lookups: yield* Ref.make<readonly GatewayLookupRequest[]>([]),
      notifications: yield* Ref.make(setup.notifications),
      records: yield* Ref.make(setup.records),
      statements: yield* Ref.make<readonly AcceptPaymentObservationPayload[]>([]),
    };
    const transport = {
      acquire: (request: GatewayDelegationRequest) =>
        Ref.update(world.acquired, (all) => [...all, request]).pipe(
          Effect.andThen(
            setup.a8 === 'DELEGATION_REFUSED'
              ? Effect.fail(
                  new GatewayDelegationSourceError({
                    reason: 'A current verified worker delivery in its declared company scope is required',
                  }),
                )
              : Effect.void,
          ),
          Effect.as(issuedGrant),
        ),
      execute: (payload: AcceptPaymentObservationPayload) =>
        Ref.update(world.statements, (all) => [...all, payload]).pipe(
          Effect.andThen(
            setup.a8 === 'SOURCE_FORBIDDEN' ? Effect.fail(sourceForbidden) : Effect.succeed(statementResult(payload)),
          ),
        ),
    };
    const expectations = {
      read: (_scope: OutboxWorkerLegalEntityScope, record: ProviderDispatchRecord) =>
        Effect.succeed(
          Schema.decodeUnknownOption(GatewayExpectedEffectSchema)({
            _tag: record.operationKind,
            amount: AMOUNT,
            operationId: record.operationId,
          }),
        ),
    };
    const result = yield* processProviderNotification({
      notificationId: Schema.decodeUnknownSync(StoredProviderNotificationSchema.fields.notificationId)(notificationId),
      scope,
      workerContext,
    }).pipe(
      Effect.provide(layerFor(setup, world)),
      Effect.provideService(ProviderEvidenceSubmissionTransport, transport),
      Effect.provideService(NotificationExpectedEffectReader, expectations),
    );
    return { result: summaryOf(result), world };
  });

const N1 = '0aaaaaaa-0000-4000-8000-000000000001';
const N2 = '0aaaaaaa-0000-4000-8000-000000000002';

describe('process-provider-notification', () => {
  it.effect("#1157 Verified notification still needs the receiver's normal write admission", () =>
    Effect.gen(function* receiverAdmission() {
      const { result, world } = yield* run(
        {
          a8: 'SOURCE_FORBIDDEN',
          findings: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [PI] })],
          notifications: [notificationOf({ id: N1, refs: [PI] })],
          records: [recordOf({ payment: PI })],
        },
        N1,
      );
      // The signature-verified notification is only a trigger: A8 still decides with the normal admission.
      expect(result).toBe(`SETTLED ${collectId} SUBMISSION_DENIED [DENIED]`);
      const [acquired] = yield* Ref.get(world.acquired);
      expect(acquired).toMatchObject({
        audience: 'payment',
        legalEntityScope: 'subject',
        subject: {
          _tag: 'RegisteredWorkload',
          context: workerContext,
          declarationKey: 'payment.core.observation.accept',
          legalEntityId,
          operationRequirementKey: 'payment.core.requirement.gateway-evidence-notification',
        },
      });
      const [statement] = yield* Ref.get(world.statements);
      expect(statement).toMatchObject({
        amount: AMOUNT,
        factFamily: 'GATEWAY_OUTCOME',
        factKind: 'COLLECTION_CONFIRMED',
        operationId: collectId,
        paymentId,
        source: { accountRef: accountA, environment: 'SANDBOX', sourceKind: 'PAYMENT_GATEWAY', sourceSystem: 'STRIPE' },
      });
      // A8 `receivedAt` is the stored notification receipt, never the submission time.
      expect(Option.map(Option.fromUndefinedOr(statement?.receivedAt), DateTime.formatIso)).toEqual(
        Option.some(RECEIVED_AT),
      );
      const evidence = yield* Ref.get(world.evidence);
      expect(evidence.map((row) => row.submissionState)).toEqual(['DENIED']);
      // The first attempt asks for no executor and pins the one Shell attested before calling A8.
      expect(acquired?.subject).not.toHaveProperty('expectedPrincipalId');
      expect(evidence.map((row) => row.submissionExecutorPrincipalId)).toEqual([ISSUED_EXECUTOR]);
    }),
  );

  it.effect('#1157 A pinned evidence row asks Shell for exactly its executor', () =>
    Effect.gen(function* pinnedExecutor() {
      const { result, world } = yield* run(
        {
          findings: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [PI] })],
          notifications: [notificationOf({ id: N1, refs: [PI] })],
          pinnedExecutor: ISSUED_EXECUTOR,
          records: [recordOf({ payment: PI })],
        },
        N1,
      );
      expect(result).toBe(`SETTLED ${collectId} SUBMITTED [ACCEPTED]`);
      const [acquired] = yield* Ref.get(world.acquired);
      expect(acquired?.subject).toMatchObject({ expectedPrincipalId: ISSUED_EXECUTOR });
      expect(yield* Ref.get(world.statements)).toHaveLength(1);
    }),
  );

  it.effect('#1157 An attested executor other than the pinned one never reaches A8', () =>
    Effect.gen(function* executorMismatch() {
      const failure = yield* run(
        {
          findings: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [PI] })],
          notifications: [notificationOf({ id: N1, refs: [PI] })],
          pinnedExecutor: '12121212-1212-4212-8212-121212121212',
          records: [recordOf({ payment: PI })],
        },
        N1,
      ).pipe(Effect.flip);
      // Transient: the delivery retries and asks Shell for the pinned executor again; A8 is never called here.
      expect(Schema.is(GatewayProviderUnavailable)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'submission_executor_mismatch' });
    }),
  );

  it.effect('#1157 Same provider payment reports a later state', () =>
    Effect.gen(function* laterState() {
      const records = [recordOf({ kind: 'REFUND', payment: PI, refund: REFUND })];
      const first = yield* run(
        {
          findings: () => [findingOf({ factKind: 'REFUND_CONFIRMED', kind: 'REFUND', refs: [REFUND] })],
          notifications: [notificationOf({ id: N1, refs: [REFUND] })],
          records,
        },
        N1,
      );
      expect(first.result).toBe(`SETTLED ${refundId} SUBMITTED [ACCEPTED]`);
      // A later contrary provider state of the same refund is a new occurrence and is submitted, not discarded.
      const later = yield* run(
        {
          findings: () => [findingOf({ factKind: 'REFUND_NOT_EFFECTED', kind: 'REFUND', refs: [REFUND] })],
          notifications: [notificationOf({ id: N2, refs: [REFUND] })],
          records,
        },
        N2,
      );
      expect(later.result).toBe(`SETTLED ${refundId} SUBMITTED [ACCEPTED]`);
      const [statement] = yield* Ref.get(later.world.statements);
      expect(statement).toMatchObject({ factFamily: 'REFUND_EXECUTION', factKind: 'REFUND_NOT_EFFECTED' });
      const [lookup] = yield* Ref.get(later.world.lookups);
      expect(
        Option.exists(Option.fromUndefinedOr(lookup), ({ target }) => sameLookupTarget(target, refundTarget)),
      ).toBe(true);
    }),
  );

  it.effect('#1157 Create response lost then notification arrives correlates and enables a later refund', () =>
    Effect.gen(function* lostResponse() {
      const { orderReference } = deriveProviderCorrelation(collectId);
      const { result, world } = yield* run(
        {
          findings: () => [
            findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', orderReference: true, refs: [PI] }),
          ],
          notifications: [
            notificationOf({
              id: N1,
              refs: [PI],
              signedObject: { metadata: { ontos_order_reference: orderReference } },
            }),
          ],
          records: [recordOf({ state: 'OUTCOME_UNKNOWN' })],
        },
        N1,
      );
      expect(result).toBe(`SETTLED ${collectId} SUBMITTED [ACCEPTED]`);
      expect(yield* Ref.get(world.correlated)).toEqual([orderReference]);
      // The collection now has its provider object: a later refund or cancel has a provider target.
      const [record] = yield* Ref.get(world.records);
      expect(record?.state).toBe('ACKNOWLEDGED');
      expect(record?.providerPaymentRef).toEqual(Option.some(PI));
    }),
  );

  it.effect('#1157 Executor crash after send: a PREPARED collection is acknowledged by its notification', () =>
    Effect.gen(function* preparedCollection() {
      const { orderReference } = deriveProviderCorrelation(collectId);
      const { result, world } = yield* run(
        {
          findings: () => [
            findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', orderReference: true, refs: [PI] }),
          ],
          notifications: [
            notificationOf({
              id: N1,
              refs: [PI],
              signedObject: { metadata: { ontos_order_reference: orderReference } },
            }),
          ],
          records: [recordOf({ state: 'PREPARED' })],
        },
        N1,
      );
      expect(result).toBe(`SETTLED ${collectId} SUBMITTED [ACCEPTED]`);
      expect(yield* Ref.get(world.correlated)).toEqual([orderReference]);
      const [record] = yield* Ref.get(world.records);
      expect(record?.state).toBe('ACKNOWLEDGED');
      expect(record?.providerPaymentRef).toEqual(Option.some(PI));
    }),
  );

  it.effect('#1157 Refund response lost then refund notification arrives correlates the refund', () =>
    Effect.gen(function* lostRefundResponse() {
      const { orderReference } = deriveProviderCorrelation(refundId);
      const { result, world } = yield* run(
        {
          findings: (request) =>
            Match.valueTags(request.expected, {
              CANCEL_OR_VOID: () => [],
              COLLECT: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [PI] })],
              REFUND: () => [
                findingOf({ factKind: 'REFUND_CONFIRMED', kind: 'REFUND', orderReference: true, refs: [REFUND, PI] }),
              ],
            }),
          notifications: [
            notificationOf({
              id: N1,
              refs: [REFUND, PI],
              signedObject: { metadata: { ontos_order_reference: orderReference } },
            }),
          ],
          records: [recordOf({ payment: PI }), recordOf({ kind: 'REFUND', payment: PI, state: 'OUTCOME_UNKNOWN' })],
        },
        N1,
      );
      expect(result).toBe(`SETTLED ${refundId} SUBMITTED [ACCEPTED]`);
      expect(yield* Ref.get(world.correlated)).toEqual([orderReference]);
      // The refund's own object was looked up with the refund expectation, never the payment.
      const lookups = yield* Ref.get(world.lookups);
      expect(lookups.map(({ expected }) => isRefundExpectation(expected))).toEqual([true]);
      expect(lookups.every(({ target }) => sameLookupTarget(target, refundTarget))).toBe(true);
      const refund = (yield* Ref.get(world.records)).find((record) => record.operationKind === 'REFUND');
      expect(refund?.state).toBe('ACKNOWLEDGED');
      expect(refund?.providerRefundRef).toEqual(Option.some(REFUND));
      expect(yield* Ref.get(world.statements)).toEqual([
        expect.objectContaining({ factKind: 'REFUND_CONFIRMED', operationId: refundId }),
      ]);
    }),
  );

  it.effect('#1157 Create response lost without a signed object: the binding read of the object correlates it', () =>
    Effect.gen(function* unsignedLostResponse() {
      const { orderReference } = deriveProviderCorrelation(collectId);
      const readOrderReference = (ref: ProviderObjectRef) =>
        sameRef(ref, PI) ? Option.some(orderReference) : Option.none();
      const { result, world } = yield* run(
        {
          findings: () => [
            findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', orderReference: true, refs: [PI] }),
          ],
          // GoPay and Comgate notifications carry ids only; the order reference comes from the binding's own read.
          notifications: [notificationOf({ id: N1, refs: [PI] })],
          readOrderReference,
          records: [recordOf({ state: 'OUTCOME_UNKNOWN' })],
        },
        N1,
      );
      expect(result).toBe(`SETTLED ${collectId} SUBMITTED [ACCEPTED]`);
      expect(yield* Ref.get(world.correlated)).toEqual([orderReference]);
      const [record] = yield* Ref.get(world.records);
      expect([record?.state, record?.providerPaymentRef]).toEqual(['ACKNOWLEDGED', Option.some(PI)]);
      // The read is only a candidate: a lookup that does not prove it leaves the notification held.
      const unproven = yield* run(
        {
          findings: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [PI] })],
          notifications: [notificationOf({ id: N2, refs: [PI] })],
          readOrderReference,
          records: [recordOf({ state: 'OUTCOME_UNKNOWN' })],
        },
        N2,
      );
      expect(unproven.result).toBe('HELD_UNCORRELATED order_reference_unverified');
      expect(yield* Ref.get(unproven.world.correlated)).toEqual([]);
      expect(yield* Ref.get(unproven.world.statements)).toEqual([]);
    }),
  );

  it.effect('#1157 GoPay callback followed by lookup through the original binding', () =>
    Effect.gen(function* gopayCallback() {
      const GOPAY_PAYMENT = providerRef({ _tag: 'GOPAY_PAYMENT', id: '3000006529' });
      const { result, world } = yield* run(
        {
          family: 'GOPAY',
          findings: () => [
            findingOf({
              factKind: 'COLLECTION_CONFIRMED',
              kind: 'COLLECT',
              orderReference: true,
              refs: [GOPAY_PAYMENT],
            }),
          ],
          notifications: [notificationOf({ family: 'GOPAY', id: N1, refs: [GOPAY_PAYMENT] })],
          records: [recordOf({ family: 'GOPAY', payment: GOPAY_PAYMENT })],
        },
        N1,
      );
      expect(result).toBe(`SETTLED ${collectId} SUBMITTED [ACCEPTED]`);
      // The callback carries no state: exactly one lookup of the notified payment, expecting its own collection.
      const lookups = yield* Ref.get(world.lookups);
      expect(
        lookups.map(({ expected, target }) => [isCollectExpectation(expected), expected.operationId, target]),
      ).toEqual([[true, collectId, { _tag: 'PROVIDER_OBJECT', ref: GOPAY_PAYMENT }]]);
      expect(yield* Ref.get(world.statements)).toEqual([
        expect.objectContaining({ factKind: 'COLLECTION_CONFIRMED', operationId: collectId }),
      ]);
    }),
  );

  it.effect('#1157 an unverified order reference never correlates', () =>
    Effect.gen(function* unverified() {
      const { orderReference } = deriveProviderCorrelation(collectId);
      const { result, world } = yield* run(
        {
          findings: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [PI] })],
          notifications: [
            notificationOf({
              id: N1,
              refs: [PI],
              signedObject: { metadata: { ontos_order_reference: orderReference } },
            }),
          ],
          records: [recordOf({ state: 'OUTCOME_UNKNOWN' })],
        },
        N1,
      );
      expect(result).toBe('HELD_UNCORRELATED order_reference_unverified');
      expect(yield* Ref.get(world.correlated)).toEqual([]);
      expect(yield* Ref.get(world.statements)).toEqual([]);
    }),
  );

  it.effect('#1156 Notification for another binding is never applied', () =>
    Effect.gen(function* otherBinding() {
      // The dispatch that owns this provider object belongs to binding A; the notification was captured for B.
      const { result, world } = yield* run(
        {
          findings: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [SESSION] })],
          notifications: [notificationOf({ bindingId: bindingB, id: N1, refs: [SESSION] })],
          records: [recordOf({ payment: SESSION })],
        },
        N1,
      );
      expect(result).toBe('HELD_UNCORRELATED no_verifiable_order_reference');
      expect(yield* Ref.get(world.lookups)).toEqual([]);
      expect(yield* Ref.get(world.evidence)).toEqual([]);
      expect(yield* Ref.get(world.statements)).toEqual([]);
      // A resolver answer for another binding than the captured one is never used either.
      const swapped = yield* run(
        {
          findings: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [SESSION] })],
          notifications: [notificationOf({ id: N2, refs: [SESSION] })],
          records: [recordOf({ payment: SESSION })],
          resolvedBinding: bindingB,
        },
        N2,
      );
      expect(swapped.result).toBe('HELD_UNCORRELATED binding_mismatch');
      expect(yield* Ref.get(swapped.world.statements)).toEqual([]);
    }),
  );

  it.effect('#1157 Browser-independent: notification alone drives the outcome', () =>
    Effect.gen(function* browserIndependent() {
      const { result, world } = yield* run(
        {
          findings: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [SESSION, PI] })],
          notifications: [notificationOf({ id: N1, refs: [SESSION] })],
          records: [recordOf({ payment: SESSION })],
        },
        N1,
      );
      expect(result).toBe(`SETTLED ${collectId} SUBMITTED [ACCEPTED]`);
      const [notification] = yield* Ref.get(world.notifications);
      expect(notification?.correlatedOperationId).toEqual(Option.some(collectId));
      expect((yield* Ref.get(world.evidence)).map((row) => [row.origin, row.submissionState])).toEqual([
        ['NOTIFICATION_LOOKUP', 'ACCEPTED'],
      ]);
      expect(yield* Ref.get(world.statements)).toHaveLength(1);
    }),
  );

  it.effect('#1157 a pending collection is not submitted as a Payment fact', () =>
    Effect.gen(function* pendingCollection() {
      const pending = Schema.decodeUnknownSync(ProviderFindingResultSchema)({
        ...Schema.encodeSync(ProviderFindingResultSchema)(
          findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [PI] }),
        ),
        evidence: Option.none(),
        finding: 'ACCEPTED_PENDING',
      });
      const { result, world } = yield* run(
        {
          findings: () => [pending],
          notifications: [notificationOf({ id: N1, refs: [PI] })],
          records: [recordOf({ payment: PI })],
        },
        N1,
      );
      expect(result).toBe(`SETTLED ${collectId} SUBMISSION_HELD []`);
      expect(yield* Ref.get(world.statements)).toEqual([]);
    }),
  );

  it.effect('#1159 a refusal of the governed path keeps the evidence pending without a retry', () =>
    Effect.gen(function* refusedPath() {
      const { result, world } = yield* run(
        {
          a8: 'DELEGATION_REFUSED',
          findings: () => [findingOf({ factKind: 'COLLECTION_CONFIRMED', kind: 'COLLECT', refs: [PI] })],
          notifications: [notificationOf({ id: N1, refs: [PI] })],
          records: [recordOf({ payment: PI })],
        },
        N1,
      );
      expect(result).toMatch(new RegExp(`^SUBMISSION_PENDING ${collectId} submission_delegation_refused`, 'u'));
      expect(yield* Ref.get(world.statements)).toEqual([]);
      expect((yield* Ref.get(world.evidence)).map((row) => row.submissionState)).toEqual(['PENDING_SUBMISSION']);
      const [notification] = yield* Ref.get(world.notifications);
      expect(notification?.state).toBe('SUBMISSION_HELD');
    }),
  );
  it.effect('#1157 a refund notification also submits the dispatch response the executor left pending', () =>
    Effect.gen(function* drainsDispatchEvidence() {
      const confirmed = findingOf({ factKind: 'REFUND_CONFIRMED', kind: 'REFUND', refs: [REFUND] });
      // The executor's own statement of the same refund: another occurrence than the notification lookup's.
      const stored = Schema.decodeUnknownSync(StoredProviderEvidenceSchema)({
        bindingId: bindingA,
        evidence: {
          ...Option.getOrThrow(confirmed.evidence),
          sourceOccurrenceId: `stripe:dispatch:re_test_notification:${refundId}`,
        },
        evidenceId: 'ffffffff-0000-4000-8000-000000000000',
        notificationId: Option.none(),
        operationId: refundId,
        origin: 'DISPATCH_RESPONSE',
        paymentId,
        receivedAt: DateTime.makeUnsafe(RECEIVED_AT),
        recordedAt: DateTime.makeUnsafe(RECEIVED_AT),
        submissionState: 'PENDING_SUBMISSION',
        verifiedAt: DateTime.makeUnsafe(RECEIVED_AT),
      });
      const { result, world } = yield* run(
        {
          evidence: [stored],
          findings: () => [confirmed],
          notifications: [notificationOf({ id: N1, refs: [REFUND] })],
          records: [recordOf({ kind: 'REFUND', payment: PI, refund: REFUND })],
        },
        N1,
      );
      expect(result).toBe(`SETTLED ${refundId} SUBMITTED [ACCEPTED]`);
      // A10 refuses recovery of the now definitive refund, so this delivery is the dispatch evidence's only path.
      expect((yield* Ref.get(world.evidence)).map((row) => [row.origin, row.submissionState])).toEqual([
        ['DISPATCH_RESPONSE', 'ACCEPTED'],
        ['NOTIFICATION_LOOKUP', 'ACCEPTED'],
      ]);
      expect(yield* Ref.get(world.statements)).toHaveLength(2);
    }),
  );
});

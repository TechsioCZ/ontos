import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { PaymentProviderReplayGuaranteeSchema } from '../../../shared/domain/evidence-contract.ts';
import type { PaymentProviderReplayGuarantee } from '../../../shared/domain/evidence-contract.ts';
import { PaymentGatewayAccountBindingSchema } from '../../../shared/domain/payment-execution-binding.ts';
import type { PaymentGatewayAccountBinding } from '../../../shared/domain/payment-execution-binding.ts';
import type { PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import { PaymentPositiveMonetaryAmountSchema } from '../../../shared/domain/payment-money.ts';
import type { PaymentRecoveryMode } from '../../../shared/domain/payment-vocabulary.ts';
import { GatewayEnvironmentSchema } from '../../../shared/domain/psp-vocabulary.ts';
import type { ProviderEvidenceOrigin } from '../../../shared/domain/psp-vocabulary.ts';
import type { OutboxPayload as RecoveryRequested } from '../../../shared/outbox/payment-core-operation-recovery-requested-v1.ts';
import { paymentRecoveryModeAtDispatch } from '../../domain/evidence-recovery.ts';
import { PaymentOwnerScopeSchema } from '../../ports/owner-evidence-unavailable.ts';
import type { PaymentOwnerScope } from '../../ports/owner-evidence-unavailable.ts';
import { pspReadOperationForExecution } from '../../persistence/psp-worker-routines.ts';
import type { PspOperationForExecution } from '../../persistence/psp-worker-routines.ts';
import { GatewayBindingResolver } from './binding-resolver.ts';
import { ledgerUnavailable, routineUnavailable } from './dispatch-ledger-live.ts';
import { ProviderDispatchLedger, replayRequestOf } from './dispatch-ledger.ts';
import type { ProviderDispatchRecord } from './dispatch-ledger.ts';
import { ProviderEvidenceStore } from './evidence-store.ts';
import type {
  ProviderEvidenceId,
  ProviderEvidenceSubmissionOutcome,
  StoredProviderEvidence,
} from './evidence-store.ts';
import { isPermanentSubmissionRefusal } from './evidence-submission-live.ts';
import { ProviderEvidenceSubmitter } from './evidence-submission.ts';
import type { GatewayProviderAdapter } from './psp-adapter.ts';
import { GatewayProviderAdapters } from './psp-adapter.ts';
import { GatewayProviderUnavailable } from './psp-errors.ts';
import type { GatewayProviderOutcomeUnknownError } from './psp-errors.ts';
import type {
  GatewayExecutionTarget,
  GatewayExpectedEffect,
  GatewayLookupTarget,
  ProviderObjectRef,
} from './psp-request.ts';
import type { ProviderDispatchResponse, ProviderEvidence, ProviderFindingResult } from './psp-result.ts';

/**
 * Worker-side recovery of ONE original gateway Payment Operation (#1157, #1158; plan §2.2). It runs for a
 * `payment.core.operation-recovery-requested.v1` delivery admitted by A10 and never calls A10 itself.
 *
 * 1. The mode is decided again at dispatch by the C16 rule `paymentRecoveryModeAtDispatch` against the
 *    operation as it is now and the dispatch the ledger retained.
 * 2. REPLAY re-sends the exact persisted Stripe request (`replayRequestOf`); it is the only provider mutation.
 *    No replayable request, or an expired window, falls back to LOOKUP.
 * 3. LOOKUP reads through the operation's original binding (also after that binding was retired for new
 *    intents): by the recorded provider object, or for Stripe without a ref after the replay window by the
 *    order reference. GoPay and Comgate without a ref stay INDETERMINATE; nothing is called.
 * 4. Lookup and replay evidence is appended to the C17 evidence store (PENDING_SUBMISSION).
 * 5. Every pending evidence row of the operation is offered once to A8 through the RegisteredWorkload
 *    submitter. The worker cannot see how A10 was admitted, so it asks: Shell refuses the delegation of a
 *    human-admitted recovery, a permanent submission refusal. A refusal or an A8 denial stops the
 *    submission for this delivery without a retry and leaves the evidence PENDING_SUBMISSION, so the
 *    reconciliation debt stays visible. A transient submission outage fails the delivery and is retried.
 *
 * Failures: binding resolution, provider and ledger outages are typed and retryable. Permanent provider
 * conditions (unsupported lookup, an undecodable provider response, conflicting evidence or correlation)
 * are recorded as INDETERMINATE findings and never fail the delivery.
 */

type OperationId = typeof PaymentOperationIdSchema.Type;

/** What the delivery asked the provider. */
export const GatewayRecoveryProviderCallSchema = Schema.Literals([
  'NONE',
  'REPLAY',
  'LOOKUP_PROVIDER_OBJECT',
  'LOOKUP_ORDER_REFERENCE',
]);
export type GatewayRecoveryProviderCall = typeof GatewayRecoveryProviderCallSchema.Type;

/** Why no provider finding settled the operation in this delivery. Absent when a finding was obtained. */
export const GatewayRecoveryIndeterminateReasonSchema = Schema.Literals([
  'already_resolved',
  'cancel_target_unknown',
  'correlation_conflict',
  'evidence_conflict',
  'lookup_not_possible_without_provider_ref',
  'lookup_response_invalid',
  'lookup_unsupported',
  'mode_without_provider_work',
  'not_a_gateway_operation',
  'not_dispatched',
  'provider_indeterminate',
]);
export type GatewayRecoveryIndeterminateReason = typeof GatewayRecoveryIndeterminateReasonSchema.Type;

/** One A8 decision about a stored evidence row. */
export interface GatewayRecoverySubmission {
  readonly evidenceId: ProviderEvidenceId;
  readonly outcome: ProviderEvidenceSubmissionOutcome;
}

/** The result of one recovery delivery in the legal-entity scope that owns the operation. */
export interface GatewayRecoveryReport {
  /** Evidence appended in this delivery (new or the existing identical row). */
  readonly appended: readonly StoredProviderEvidence[];
  readonly indeterminate: Option.Option<GatewayRecoveryIndeterminateReason>;
  readonly mode: PaymentRecoveryMode | 'ALREADY_RESOLVED';
  readonly operationId: OperationId;
  readonly providerCall: GatewayRecoveryProviderCall;
  /** True when A8 denied the RegisteredWorkload submission; that row and the rest stay pending. */
  readonly submissionDenied: boolean;
  /** Rows A8 decided in this delivery, in submission order (a denied row is never marked). */
  readonly submissions: readonly GatewayRecoverySubmission[];
}

interface ProviderStep {
  readonly appended: readonly StoredProviderEvidence[];
  readonly indeterminate: Option.Option<GatewayRecoveryIndeterminateReason>;
  readonly providerCall: GatewayRecoveryProviderCall;
}

const stepWithout = (
  providerCall: GatewayRecoveryProviderCall,
  reason: GatewayRecoveryIndeterminateReason,
): ProviderStep => ({ appended: [], indeterminate: Option.some(reason), providerCall });

const isGatewayBinding = Schema.is(PaymentGatewayAccountBindingSchema);
const decodePositiveAmount = Schema.decodeUnknownOption(PaymentPositiveMonetaryAmountSchema);
const decodeGuarantee = Schema.decodeUnknownOption(PaymentProviderReplayGuaranteeSchema);
const decodeEnvironment = Schema.decodeUnknownOption(GatewayEnvironmentSchema);
const REPLAYABLE_STATES: ReadonlySet<ProviderDispatchRecord['state']> = new Set(['PREPARED', 'OUTCOME_UNKNOWN']);

/** A refund's own provider object (Stripe refund, GoPay v4 refund); every other ref is a collection object. */
const isRefundRef = (ref: ProviderObjectRef): boolean =>
  Match.valueTags(ref, {
    COMGATE_TRANSACTION: () => false,
    GOPAY_PAYMENT: () => false,
    GOPAY_REFUND: () => true,
    STRIPE_CHECKOUT_SESSION: () => false,
    STRIPE_PAYMENT_INTENT: () => false,
    STRIPE_REFUND: () => true,
  });

/**
 * The replay guarantee the ledger still retains for the dispatch, in C16 terms: only a Stripe row whose
 * response is unknown and whose exact request, headers and deterministic key are persisted.
 */
export const retainedReplayGuaranteeOf = (
  record: ProviderDispatchRecord,
  scope: Pick<OutboxWorkerLegalEntityScope, 'legalEntityId' | 'tenantId'>,
): Option.Option<PaymentProviderReplayGuarantee> =>
  record.providerFamily === 'STRIPE' && REPLAYABLE_STATES.has(record.state)
    ? Option.all({ keyHash: record.idempotencyKeyHash, replay: replayRequestOf(record) }).pipe(
        Option.flatMap(({ keyHash, replay }) =>
          decodeGuarantee({
            binding: {
              _tag: 'GATEWAY_ACCOUNT',
              environment: record.environment,
              providerAccountRef: record.providerAccountRef,
              providerFamily: record.providerFamily,
            },
            endpointRef: replay.prepared.endpointRef,
            expiresAtEpochMs: DateTime.toEpochMillis(replay.window.expiresAt),
            legalEntityId: scope.legalEntityId,
            materialHash: record.materialHash,
            operationId: record.operationId,
            operationKind: record.operationKind,
            paymentId: record.paymentId,
            providerIdempotencyKeyHash: keyHash,
            providerRequestHash: replay.prepared.requestHash,
            startsAtEpochMs: DateTime.toEpochMillis(replay.window.startsAt),
            tenantId: scope.tenantId,
          }),
        ),
      )
    : Option.none();

/**
 * The C16 dispatch decision for the operation as it is now, from the stored operation's creation time and
 * original provenance as the worker routine reads them.
 */
export const recoveryModeAtDispatch = (
  message: RecoveryRequested,
  operation: PspOperationForExecution,
  scope: PaymentOwnerScope,
  now: DateTime.Utc,
  retained: Option.Option<PaymentProviderReplayGuarantee>,
) =>
  paymentRecoveryModeAtDispatch(
    message,
    {
      binding: operation.binding,
      createdAt: operation.createdAt,
      kind: operation.kind,
      materialHash: operation.materialHash,
      operationId: operation.operationId,
      outcome: operation.outcome,
      paymentId: operation.paymentId,
      provenance: operation.provenance,
    },
    scope,
    now,
    Option.getOrUndefined(retained),
  );

/**
 * The provider object a lookup by reference reads: the refund object when known, else the collection object.
 * A Stripe refund is a separate provider object, so only its refund ref addresses it; a GoPay refund is read by its
 * recorded refund ref and otherwise through its payment's refund list; Comgate reads a refund through its payment.
 */
export const recordedLookupRefOf = (record: ProviderDispatchRecord): Option.Option<ProviderObjectRef> => {
  if (record.operationKind !== 'REFUND') {
    return record.providerPaymentRef;
  }
  return record.providerFamily === 'STRIPE'
    ? record.providerRefundRef
    : Option.orElse(record.providerRefundRef, () => record.providerPaymentRef);
};

/**
 * How a lookup can address the operation, or `None` when it cannot: by the recorded provider object; for a
 * Stripe collection or cancel without a ref only after the replay window (PaymentIntent search on the order
 * reference; within the window the exact replay is the only safe path). GoPay and Comgate have no
 * order-reference lookup, and a Stripe refund without its refund ref waits for its notification, which
 * records that ref.
 */
export const lookupTargetOf = (record: ProviderDispatchRecord, now: DateTime.Utc): Option.Option<GatewayLookupTarget> =>
  Option.match(recordedLookupRefOf(record), {
    onNone: () => {
      const windowClosed = Option.match(record.replayExpiresAt, {
        onNone: () => true,
        onSome: (expiresAt) => DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(expiresAt),
      });
      return record.providerFamily === 'STRIPE' && record.operationKind !== 'REFUND' && windowClosed
        ? Option.some<GatewayLookupTarget>({ _tag: 'ORDER_REFERENCE', orderReference: record.orderReference })
        : Option.none();
    },
    onSome: (ref) => Option.some<GatewayLookupTarget>({ _tag: 'PROVIDER_OBJECT', ref }),
  });

/** The provider ref a correlated OUTCOME_UNKNOWN row records: a refund object for a refund, else the collection object. */
const correlationRefOf = (record: ProviderDispatchRecord, refs: readonly ProviderObjectRef[]) =>
  Option.fromUndefinedOr(refs.find((ref) => isRefundRef(ref) === (record.operationKind === 'REFUND')));

const unavailable = (family: PaymentGatewayAccountBinding['providerFamily'], reason: string) =>
  new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family, reason });

const operationIn = (scope: OutboxWorkerLegalEntityScope, operationId: string) =>
  pspReadOperationForExecution(scope.routineInvoker, operationId).pipe(Effect.mapError(routineUnavailable));

const positiveAmountOf = (operation: PspOperationForExecution) =>
  decodePositiveAmount({ amountMinor: operation.amountMinor, currency: operation.currency });

/** The effect the provider may report, tagged by kind; a CANCEL carries its collection target. */
const expectedEffectOf = Effect.fn('GatewayOperationRecovery.expectedEffect')(function* expectedEffectOf(
  operation: PspOperationForExecution,
  scope: OutboxWorkerLegalEntityScope,
) {
  const { operationId } = operation;
  if (operation.kind === 'COLLECT') {
    return positiveAmountOf(operation).pipe(
      Option.map((amount): GatewayExpectedEffect => ({ _tag: 'COLLECT', amount, operationId })),
    );
  }
  if (operation.kind === 'REFUND') {
    return positiveAmountOf(operation).pipe(
      Option.map((amount): GatewayExpectedEffect => ({ _tag: 'REFUND', amount, operationId })),
    );
  }
  if (operation.targetOperationId === undefined) {
    return Option.none<GatewayExpectedEffect>();
  }
  const collection = yield* operationIn(scope, operation.targetOperationId);
  return collection.pipe(
    Option.flatMap((target) =>
      positiveAmountOf(target).pipe(
        Option.map((amount): GatewayExpectedEffect => ({
          _tag: 'CANCEL_OR_VOID',
          operationId,
          target: { amount, operationId: target.operationId },
        })),
      ),
    ),
  );
});

/** The operations a finding may be about: the operation and, for a cancel, its collection target. */
const reportableOperationIds = (expected: GatewayExpectedEffect): ReadonlySet<string> =>
  Match.valueTags(expected, {
    CANCEL_OR_VOID: ({ operationId, target }) => new Set([operationId, target.operationId]),
    COLLECT: ({ operationId }) => new Set([operationId]),
    REFUND: ({ operationId }) => new Set([operationId]),
  });

interface RecoveryCall {
  readonly operation: PspOperationForExecution;
  readonly scope: OutboxWorkerLegalEntityScope;
  readonly target: GatewayExecutionTarget;
  readonly workerContext: OutboxWorkerHandlerContext;
}

interface FindingEvidence {
  readonly evidence: ProviderEvidence;
  readonly operationId: OperationId;
}

type RecoveryOrigin = Extract<ProviderEvidenceOrigin, 'RECOVERY_LOOKUP' | 'RECOVERY_REPLAY'>;

/** Appends one statement; a statement that conflicts with a stored one is skipped (`None`), never retried. */
const appendEvidence = Effect.fn('GatewayOperationRecovery.appendEvidence')(function* appendEvidence(
  call: RecoveryCall,
  item: FindingEvidence,
  origin: RecoveryOrigin,
) {
  const store = yield* ProviderEvidenceStore;
  return yield* store
    .append({
      bindingId: call.target.bindingId,
      evidence: item.evidence,
      notificationId: Option.none(),
      operationId: item.operationId,
      origin,
      paymentId: call.operation.paymentId,
      scope: call.scope,
      workerContext: call.workerContext,
    })
    .pipe(
      Effect.map(Option.some),
      Effect.catchTag('GatewayEvidenceConflict', (conflict) =>
        Effect.logWarning('Recovery evidence conflicts with a stored statement; it is not appended').pipe(
          Effect.annotateLogs({ operationId: item.operationId, reason: conflict.reason }),
          Effect.as(Option.none<StoredProviderEvidence>()),
        ),
      ),
    );
});

/** Appends the evidence of findings about the expected operations, in order, and summarizes the step. */
const appendFindings = Effect.fn('GatewayOperationRecovery.appendFindings')(function* appendFindings(
  call: RecoveryCall,
  expected: GatewayExpectedEffect,
  findings: readonly ProviderFindingResult[],
  providerCall: GatewayRecoveryProviderCall,
) {
  const reportable = reportableOperationIds(expected);
  const items = findings.flatMap((finding) =>
    reportable.has(finding.target.operationId)
      ? Option.toArray(
          finding.evidence.pipe(
            Option.map((evidence): FindingEvidence => ({ evidence, operationId: finding.target.operationId })),
          ),
        )
      : [],
  );
  const origin: RecoveryOrigin = providerCall === 'REPLAY' ? 'RECOVERY_REPLAY' : 'RECOVERY_LOOKUP';
  const stored = yield* Effect.forEach(items, (item) => appendEvidence(call, item, origin), { concurrency: 1 });
  const appended = stored.flatMap((row) => Option.toArray(row));
  const settled = findings.some(
    (finding) => reportable.has(finding.target.operationId) && finding.finding !== 'INDETERMINATE',
  );
  const reason: Option.Option<GatewayRecoveryIndeterminateReason> =
    appended.length < items.length
      ? Option.some('evidence_conflict')
      : Option.liftPredicate('provider_indeterminate' as const, () => !settled);
  const step: ProviderStep = { appended, indeterminate: reason, providerCall };
  return step;
});

/** A lost replay response: a PREPARED row becomes OUTCOME_UNKNOWN, then the delivery fails retryably. */
const recordLostReplay = Effect.fn('GatewayOperationRecovery.recordLostReplay')(function* recordLostReplay(
  call: RecoveryCall,
  record: ProviderDispatchRecord,
  unknown: GatewayProviderOutcomeUnknownError,
) {
  if (record.state === 'PREPARED') {
    const ledger = yield* ProviderDispatchLedger;
    yield* ledger.recordOutcomeUnknown({
      at: yield* DateTime.now,
      operationId: record.operationId,
      scope: call.scope,
      workerContext: call.workerContext,
    });
  }
  return yield* Effect.fail(unknown);
});

/** Records the replayed response in the ledger and appends its evidence. */
const recordReplayResponse = Effect.fn('GatewayOperationRecovery.recordReplayResponse')(function* recordReplayResponse(
  call: RecoveryCall,
  record: ProviderDispatchRecord,
  expected: GatewayExpectedEffect,
  response: ProviderDispatchResponse,
) {
  const ledger = yield* ProviderDispatchLedger;
  const now = yield* DateTime.now;
  const write = { operationId: record.operationId, scope: call.scope, workerContext: call.workerContext };
  const finding = yield* Match.valueTags(response, {
    ACKNOWLEDGED: (acknowledged) => {
      const refs = acknowledged.finding.providerRefs;
      return ledger
        .recordAcknowledged({
          ...write,
          customerRedirectUrl: acknowledged.finding.customerAction.pipe(Option.map(({ redirectUrl }) => redirectUrl)),
          providerPaymentRef:
            record.operationKind === 'COLLECT'
              ? Option.fromUndefinedOr(refs.find((ref) => !isRefundRef(ref)))
              : Option.none(),
          providerRefundRef:
            record.operationKind === 'REFUND' ? Option.fromUndefinedOr(refs.find(isRefundRef)) : Option.none(),
          respondedAt: now,
        })
        .pipe(Effect.as(acknowledged.finding));
    },
    REJECTED_BEFORE_EFFECT: (rejected) =>
      ledger.recordRejected({ ...write, at: now }).pipe(Effect.as(rejected.finding)),
  });
  return yield* appendFindings(call, expected, [finding, ...Option.toArray(response.targetFinding)], 'REPLAY');
});

/**
 * The exact Stripe replay of the retained request. `None` when nothing replayable is retained or the adapter
 * refuses it as Unsupported (window expired, family without replay): the caller looks the effect up instead.
 * A lost replay response fails retryably; the next attempt decides the mode again (replay while the window
 * covers it, lookup afterwards).
 */
const replayRetained = Effect.fn('GatewayOperationRecovery.replay')(function* replayRetained(
  call: RecoveryCall,
  adapter: GatewayProviderAdapter,
  record: ProviderDispatchRecord,
  expected: GatewayExpectedEffect,
) {
  const request = replayRequestOf(record);
  if (Option.isNone(request)) {
    return Option.none<ProviderStep>();
  }
  return yield* adapter.replay(call.target, request.value, expected).pipe(
    Effect.flatMap((response) => recordReplayResponse(call, record, expected, response)),
    Effect.map(Option.some),
    Effect.catchTags({
      GatewayProviderOutcomeUnknown: (unknown) => recordLostReplay(call, record, unknown),
      GatewayProviderUnsupported: () => Effect.succeedNone,
    }),
  );
});

/**
 * A refund lookup's finding that proves the refund reached the provider: completed, accepted and pending, or a
 * refund object of its own that failed. INDETERMINATE, a conflict or a NOT_EFFECTED without the refund's own
 * object prove nothing about existence, so the dispatch stays unknown and later refunds stay serialized.
 */
const provesRefundExists = (finding: ProviderFindingResult): boolean =>
  finding.finding === 'EFFECT_CONFIRMED' ||
  finding.finding === 'ACCEPTED_PENDING' ||
  (finding.finding === 'NOT_EFFECTED' && finding.providerRefs.some(isRefundRef));

/**
 * The provider ref an OUTCOME_UNKNOWN refund records once a lookup of its recorded object (GoPay refund list,
 * Comgate statement) proves it exists: the refund's own object when the provider names one (GoPay), else the
 * payment object the refund was dispatched against (Comgate).
 */
const refundCorrelationRefOf = (refs: readonly ProviderObjectRef[]) =>
  Option.orElse(Option.fromUndefinedOr(refs.find(isRefundRef)), () => Option.fromUndefinedOr(refs[0]));

/**
 * Correlates an OUTCOME_UNKNOWN row (OUTCOME_UNKNOWN → ACKNOWLEDGED with the provider ref) found by a Stripe
 * order-reference search, or a refund whose lookup of its recorded provider object proves it exists, so later
 * refunds and cancels have their provider target and the refund no longer reads as unresolved. False on a
 * conflict.
 */
const correlateFound = Effect.fn('GatewayOperationRecovery.correlateFound')(function* correlateFound(
  call: RecoveryCall,
  record: ProviderDispatchRecord,
  findings: readonly ProviderFindingResult[],
  providerCall: GatewayRecoveryProviderCall,
) {
  const bySearch = providerCall === 'LOOKUP_ORDER_REFERENCE';
  const own = findings.find(
    (finding) =>
      finding.target.operationId === record.operationId &&
      (bySearch
        ? Option.contains(finding.orderReference, record.orderReference)
        : finding.target.operationKind === 'REFUND' && provesRefundExists(finding)),
  );
  const refOf = bySearch
    ? (refs: readonly ProviderObjectRef[]) => correlationRefOf(record, refs)
    : refundCorrelationRefOf;
  const providerRef = own === undefined ? Option.none<ProviderObjectRef>() : refOf(own.providerRefs);
  if (Option.isNone(providerRef)) {
    return true;
  }
  const ledger = yield* ProviderDispatchLedger;
  return yield* ledger
    .correlateUnknown({
      bindingId: record.bindingId,
      orderReference: record.orderReference,
      providerRef: providerRef.value,
      scope: call.scope,
      workerContext: call.workerContext,
    })
    .pipe(
      Effect.as(true),
      Effect.catchTag('GatewayCorrelationConflict', (conflict) =>
        Effect.logWarning('Recovery lookup contradicts the recorded provider reference').pipe(
          Effect.annotateLogs({ operationId: record.operationId, reason: conflict.reason }),
          Effect.as(false),
        ),
      ),
    );
});

/** Lookup through the original binding; Unsupported and an undecodable response leave the operation INDETERMINATE. */
const lookUp = Effect.fn('GatewayOperationRecovery.lookUp')(function* lookUp(
  call: RecoveryCall,
  adapter: GatewayProviderAdapter,
  record: ProviderDispatchRecord,
  expected: GatewayExpectedEffect,
) {
  const lookupTarget = lookupTargetOf(record, yield* DateTime.now);
  if (Option.isNone(lookupTarget)) {
    return stepWithout('NONE', 'lookup_not_possible_without_provider_ref');
  }
  const providerCall: GatewayRecoveryProviderCall = Match.valueTags(lookupTarget.value, {
    ORDER_REFERENCE: () => 'LOOKUP_ORDER_REFERENCE' as const,
    PROVIDER_OBJECT: () => 'LOOKUP_PROVIDER_OBJECT' as const,
  });
  const correlate =
    record.state === 'OUTCOME_UNKNOWN' &&
    (providerCall === 'LOOKUP_ORDER_REFERENCE' || record.operationKind === 'REFUND');
  return yield* adapter
    .lookup(call.target, { dispatchedAt: record.preparedAt, expected, target: lookupTarget.value })
    .pipe(
      Effect.flatMap((findings) =>
        (correlate ? correlateFound(call, record, findings, providerCall) : Effect.succeed(true)).pipe(
          Effect.flatMap((consistent) =>
            consistent
              ? appendFindings(call, expected, findings, providerCall)
              : Effect.succeed(stepWithout(providerCall, 'correlation_conflict')),
          ),
        ),
      ),
      Effect.catchTags({
        GatewayProviderResponseInvalid: () => Effect.succeed(stepWithout(providerCall, 'lookup_response_invalid')),
        GatewayProviderUnsupported: () => Effect.succeed(stepWithout(providerCall, 'lookup_unsupported')),
      }),
    );
});

/** Provider work of a replay or lookup mode, always through the operation's original binding. */
const providerStepOf = Effect.fn('GatewayOperationRecovery.providerStep')(function* providerStepOf(
  operation: PspOperationForExecution,
  binding: PaymentGatewayAccountBinding,
  mode: PaymentRecoveryMode | 'ALREADY_RESOLVED',
  scope: OutboxWorkerLegalEntityScope,
  workerContext: OutboxWorkerHandlerContext,
  record: Option.Option<ProviderDispatchRecord>,
) {
  if (mode === 'ALREADY_RESOLVED') {
    return stepWithout('NONE', 'already_resolved');
  }
  if (mode !== 'PROVIDER_IDEMPOTENT_REPLAY' && mode !== 'AUTHORITATIVE_LOOKUP') {
    return stepWithout('NONE', 'mode_without_provider_work');
  }
  // Nothing was ever prepared, so nothing can have reached the provider and nothing is asked.
  const dispatched = record.pipe(Option.filter((row) => Option.isSome(row.preparedAt)));
  if (Option.isNone(dispatched)) {
    return stepWithout('NONE', 'not_dispatched');
  }
  const expected = yield* expectedEffectOf(operation, scope);
  if (Option.isNone(expected)) {
    return stepWithout('NONE', 'cancel_target_unknown');
  }
  const environment = decodeEnvironment(binding.environment);
  if (Option.isNone(environment)) {
    return yield* unavailable(binding.providerFamily, 'environment_mismatch');
  }
  const resolver = yield* GatewayBindingResolver;
  const target = yield* resolver.resolveExecutionTarget({
    customerConfigurationId: Option.none(),
    environment: environment.value,
    providerAccountRef: binding.providerAccountRef,
    providerFamily: binding.providerFamily,
    scope,
  });
  // The recorded dispatch names its binding; no other binding is ever asked about it.
  if (target.bindingId !== dispatched.value.bindingId) {
    return yield* unavailable(binding.providerFamily, 'binding_mismatch');
  }
  const adapters = yield* GatewayProviderAdapters;
  const adapter = yield* adapters.forFamily(binding.providerFamily);
  const call: RecoveryCall = { operation, scope, target, workerContext };
  const replayed =
    mode === 'PROVIDER_IDEMPOTENT_REPLAY'
      ? yield* replayRetained(call, adapter, dispatched.value, expected.value)
      : Option.none<ProviderStep>();
  return Option.isSome(replayed) ? replayed.value : yield* lookUp(call, adapter, dispatched.value, expected.value);
});

interface SubmissionState {
  readonly denied: boolean;
  readonly submissions: readonly GatewayRecoverySubmission[];
}

/** Offers one row to A8 and records the decision; a denial or a permanent refusal is not recorded on the row. */
const submitOne = Effect.fn('GatewayOperationRecovery.submitOne')(function* submitOne(
  state: SubmissionState,
  evidence: StoredProviderEvidence,
  binding: PaymentGatewayAccountBinding,
  scope: OutboxWorkerLegalEntityScope,
  workerContext: OutboxWorkerHandlerContext,
) {
  const store = yield* ProviderEvidenceStore;
  const submitter = yield* ProviderEvidenceSubmitter;
  const decided = yield* submitter.submit({ binding, evidence, scope, workerContext }).pipe(
    Effect.map((result) => (result.outcome === 'DENIED' ? Option.none() : Option.some(result))),
    Effect.catchIf(isPermanentSubmissionRefusal, (refusal) =>
      Effect.logInfo('The governed path refused the recovery submission').pipe(
        Effect.annotateLogs({ reason: refusal.reason }),
        Effect.as(Option.none()),
      ),
    ),
  );
  if (Option.isNone(decided)) {
    yield* Effect.logInfo('The recovery submission was denied or refused; the provider evidence stays pending').pipe(
      Effect.annotateLogs({ evidenceId: evidence.evidenceId, operationId: evidence.operationId }),
    );
    const denied: SubmissionState = { denied: true, submissions: state.submissions };
    return denied;
  }
  const { observationId, outcome } = decided.value;
  yield* store.markSubmission({
    evidenceId: evidence.evidenceId,
    observationId,
    outcome,
    scope,
    workerContext,
  });
  const next: SubmissionState = {
    denied: false,
    submissions: [...state.submissions, { evidenceId: evidence.evidenceId, outcome }],
  };
  return next;
});

/**
 * Offers every pending evidence row of the operation (and of a cancel's collection target) to A8, oldest
 * first. A decision is recorded on the row; a denial stops the submission and leaves the rows pending.
 */
const submitPending = Effect.fn('GatewayOperationRecovery.submitPending')(function* submitPending(
  operation: PspOperationForExecution,
  binding: PaymentGatewayAccountBinding,
  scope: OutboxWorkerLegalEntityScope,
  workerContext: OutboxWorkerHandlerContext,
) {
  const store = yield* ProviderEvidenceStore;
  const operationIds =
    operation.kind === 'CANCEL_OR_VOID' && operation.targetOperationId !== undefined
      ? [operation.operationId, operation.targetOperationId]
      : [operation.operationId];
  const pending = yield* Effect.forEach(operationIds, (operationId) => store.listPending({ operationId, scope }), {
    concurrency: 1,
  });
  const initial: SubmissionState = { denied: false, submissions: [] };
  return yield* Effect.reduce(
    pending.flat(),
    () => initial,
    (state, evidence) =>
      state.denied ? Effect.succeed(state) : submitOne(state, evidence, binding, scope, workerContext),
  );
});

/** Provider work first, then the governed submission of everything pending, inside the same delivery claim. */
const recoverGatewayOperation = Effect.fn('GatewayOperationRecovery.recover')(function* recoverGatewayOperation(
  operation: PspOperationForExecution,
  binding: PaymentGatewayAccountBinding,
  mode: PaymentRecoveryMode | 'ALREADY_RESOLVED',
  scope: OutboxWorkerLegalEntityScope,
  workerContext: OutboxWorkerHandlerContext,
  record: Option.Option<ProviderDispatchRecord>,
) {
  return yield* providerStepOf(operation, binding, mode, scope, workerContext, record).pipe(
    Effect.flatMap((step) =>
      submitPending(operation, binding, scope, workerContext).pipe(
        Effect.map((submitted): GatewayRecoveryReport => ({
          appended: step.appended,
          indeterminate: step.indeterminate,
          mode,
          operationId: operation.operationId,
          providerCall: step.providerCall,
          submissionDenied: submitted.denied,
          submissions: submitted.submissions,
        })),
      ),
    ),
  );
});

/**
 * Recovers the operation in one Core-verified legal-entity scope. `None` when the operation does not
 * exist in this scope (the delivery's other legal entities).
 */
export const recoverGatewayOperationInScope = Effect.fn('GatewayOperationRecovery.recoverInScope')(
  function* recoverGatewayOperationInScope(
    message: RecoveryRequested,
    scope: OutboxWorkerLegalEntityScope,
    workerContext: OutboxWorkerHandlerContext,
  ) {
    const found = yield* operationIn(scope, message.operationId);
    if (Option.isNone(found)) {
      return Option.none<GatewayRecoveryReport>();
    }
    const { value: operation } = found;
    const ownerScope = yield* Schema.decodeUnknownEffect(PaymentOwnerScopeSchema)({
      legalEntityId: scope.legalEntityId,
      tenantId: scope.tenantId,
    }).pipe(Effect.mapError((invalid) => ledgerUnavailable(`worker_scope_invalid: ${invalid.message}`)));
    const ledger = yield* ProviderDispatchLedger;
    const record = yield* ledger.readByOperation({ operationId: operation.operationId, scope });
    const retained = record.pipe(Option.flatMap((row) => retainedReplayGuaranteeOf(row, scope)));
    const mode = recoveryModeAtDispatch(message, operation, ownerScope, yield* DateTime.now, retained);
    const { binding } = operation;
    const report: GatewayRecoveryReport = isGatewayBinding(binding)
      ? yield* recoverGatewayOperation(operation, binding, mode, scope, workerContext, record)
      : {
          appended: [],
          indeterminate: Option.some('not_a_gateway_operation'),
          mode,
          operationId: operation.operationId,
          providerCall: 'NONE',
          submissionDenied: false,
          submissions: [],
        };
    yield* Effect.logInfo('Gateway operation recovery finished').pipe(
      Effect.annotateLogs({
        appended: report.appended.length,
        indeterminate: Option.getOrElse(report.indeterminate, () => 'none'),
        mode,
        operationId: operation.operationId,
        providerCall: report.providerCall,
        submissionDenied: report.submissionDenied,
        submitted: report.submissions.length,
      }),
    );
    return Option.some(report);
  },
);

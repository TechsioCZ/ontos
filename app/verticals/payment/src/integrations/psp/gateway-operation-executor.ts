import { OutboxWorkerDeferred, OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import type { OutboxPayload } from '@app/payment/outbox/payment-core-operation-requested-v1';
import type { PlatformError } from 'effect';
import { Crypto, DateTime, Effect, Match, Option, Predicate, Ref, Result, Schema } from 'effect';
import { Base64Url } from 'effect/encoding';

import { PaymentGatewayAccountBindingSchema } from '../../../shared/domain/payment-execution-binding.ts';
import type { PaymentGatewayAccountBinding } from '../../../shared/domain/payment-execution-binding.ts';
import { PaymentPositiveMonetaryAmountSchema } from '../../../shared/domain/payment-money.ts';
import type {
  PaymentGatewayProviderFamilySchema,
  PaymentOperationKind,
} from '../../../shared/domain/payment-vocabulary.ts';
import { GatewayProviderAccountRefSchema, GatewayReturnTokenSchema } from '../../../shared/domain/psp-configuration.ts';
import type { GatewayReturnToken } from '../../../shared/domain/psp-configuration.ts';
import { GATEWAY_WAIT_BUDGET_MS, GatewayEnvironmentSchema } from '../../../shared/domain/psp-vocabulary.ts';
import type { ProviderEvidenceFactKind, ProviderNotSentReason } from '../../../shared/domain/psp-vocabulary.ts';
import { pspReadOperationForExecution } from '../../persistence/psp-worker-routines.ts';
import type { PspOperationForExecution } from '../../persistence/psp-worker-routines.ts';
import { GatewayBindingResolver } from './binding-resolver.ts';
import { ProviderDispatchLedger, replayRequestOf } from './dispatch-ledger.ts';
import type { ProviderDispatchIdentity, ProviderDispatchRecord } from './dispatch-ledger.ts';
import { ProviderEvidenceStore } from './evidence-store.ts';
import { GatewayProviderAdapters } from './psp-adapter.ts';
import type { GatewayProviderAdapter } from './psp-adapter.ts';
import { deriveProviderCorrelation } from './psp-correlation.ts';
import { GatewayDispatchConflict, GatewayLedgerUnavailable, GatewayProviderUnavailable } from './psp-errors.ts';
import type {
  GatewayDispatchConflictError,
  GatewayEvidenceConflictError,
  GatewayLedgerUnavailableError,
  GatewayProviderOutcomeUnknownError,
  GatewayProviderUnavailableError,
  GatewayProviderUnsupportedError,
} from './psp-errors.ts';
import { toGatewayPayerContact } from './psp-request.ts';
import type { GatewayExecutionTarget, GatewayExpectedEffect, ProviderObjectRef } from './psp-request.ts';
import type {
  PreparedProviderRequest,
  ProviderDispatchResponse,
  ProviderEvidence,
  ProviderEvidenceFactFamily,
  ProviderFindingResult,
  ProviderReplayRequest,
} from './psp-result.ts';

/**
 * The governed gateway executor of `payment.core.operation-requested.v1` (#1153, #1156, #1158; plan §2.1).
 *
 * It causes at most one provider mutation per Payment Operation. Every database read and write goes through
 * the scoped routines of the Core-verified legal-entity scope, in separate scope transactions:
 *
 * 1. decide: read the C16 operation, resolve its exact binding, read the ledger and, only when no prepared
 *    request exists, prepare it; the commit of this transaction (`psp_prepare_dispatch`) is the durable handoff;
 * 2. send or replay: one provider attempt outside any database transaction;
 * 3. record: the provider answer and its evidence, atomically.
 *
 * A crash before 1 commits sends nothing. A crash after it finds the prepared row on redelivery and treats it
 * as an unknown outcome: it never prepares or sends again, and only Stripe replays the exact persisted bytes
 * inside the replay window. The executor never calls A8 and never writes C16 state; evidence stays in the C17
 * evidence store as PENDING_SUBMISSION.
 *
 * Waiting conditions (cancel target unresolved, prior refund unresolved, provider or binding unavailable,
 * Stripe replay) defer the delivery with `OutboxWorkerDeferred`. A deferral does not consume a Core retry
 * attempt (`failOutboxDelivery` restores `attemptsCount`), so every wait is bounded by its own deadline here
 * and ends in a terminal ledger state that completes the delivery; no permanent provider condition
 * dead-letters.
 */

type OperationKind = PaymentOperationKind;
type Family = typeof PaymentGatewayProviderFamilySchema.Type;

/** Core accepts a wake at most `maxDeferralMs` (86_460_000) after settlement; stay one minute inside it. */
const MAX_DEFERRAL_DELAY_MS = 86_400_000;
/** First wake of every wait; later wakes double the time already waited. */
const MIN_DEFERRAL_DELAY_MS = 60_000;
/** The last Stripe replay attempt starts at least this long before its window closes. */
const REPLAY_WINDOW_MARGIN_MS = 30_000;
/** A wait with less time left than this is exhausted (a wake must lie in the future of Core's settlement). */
const MIN_REMAINING_MS = 1000;
const RETURN_TOKEN_BYTES = 16;
const WITHHELD_REASON = 'withheld_for_cancellation';

/** One delivery: the payload, its verified claim context and the operation's gateway binding. */
interface Delivery {
  readonly binding: PaymentGatewayAccountBinding;
  readonly context: OutboxWorkerHandlerContext;
  readonly payload: OutboxPayload;
}

/** The resolved execution of one operation inside its legal-entity scope. */
interface Execution {
  readonly delivery: Delivery;
  readonly expected: GatewayExpectedEffect;
  readonly identity: ProviderDispatchIdentity;
  readonly now: DateTime.Utc;
  readonly operation: PspOperationForExecution;
  readonly scope: OutboxWorkerLegalEntityScope;
  readonly target: GatewayExecutionTarget;
}

/**
 * One provider attempt prepared by the decide step, always over the committed ledger row. With `replay` the
 * attempt re-sends the exact persisted request (Stripe); without it, it sends `prepared` for the first time.
 */
interface DispatchPlan {
  readonly adapter: GatewayProviderAdapter;
  readonly execution: Execution;
  readonly prepared: PreparedProviderRequest;
  readonly record: ProviderDispatchRecord;
  readonly replay: Option.Option<ProviderReplayRequest>;
}

/**
 * What a scope step decided: a provider attempt to make, a wake to defer to, or neither (complete). Deferral
 * is a value, not a failure, so that the step's writes commit before Core reschedules the delivery.
 */
interface Step {
  readonly dispatch: Option.Option<DispatchPlan>;
  readonly wakeAtMs: Option.Option<number>;
}

const COMPLETE: Step = { dispatch: Option.none(), wakeAtMs: Option.none() };
const defer = (wakeAtMs: number): Step => ({ dispatch: Option.none(), wakeAtMs: Option.some(wakeAtMs) });
const dispatchStep = (plan: DispatchPlan): Step => ({ dispatch: Option.some(plan), wakeAtMs: Option.none() });

/** Every typed failure of a scope step; deferral is never one of them. */
type StepFailure =
  | GatewayDispatchConflictError
  | GatewayEvidenceConflictError
  | GatewayLedgerUnavailableError
  | GatewayProviderUnavailableError
  | PlatformError.PlatformError;
type StepServices =
  | Crypto.Crypto
  | GatewayBindingResolver
  | GatewayProviderAdapters
  | ProviderDispatchLedger
  | ProviderEvidenceStore;
type StepEffect = Effect.Effect<Step, StepFailure, StepServices>;
type ScopeStep = (scope: OutboxWorkerLegalEntityScope, operation: PspOperationForExecution) => StepEffect;

type AttemptFailure =
  | GatewayProviderOutcomeUnknownError
  | GatewayProviderUnavailableError
  | GatewayProviderUnsupportedError;

const ledgerFailure = (reason: string): GatewayLedgerUnavailableError =>
  new GatewayLedgerUnavailable({ code: 'gateway_ledger_unavailable', reason });

const dispatchConflict = (operationId: OutboxPayload['operationId'], reason: string): GatewayDispatchConflictError =>
  new GatewayDispatchConflict({ code: 'gateway_dispatch_conflict', operationId, reason });

// ---------------------------------------------------------------------------------------------
// Deferral schedule
// ---------------------------------------------------------------------------------------------

/**
 * The next wake of a wait that started at `anchor` and must end by `deadline`: 60 s first, then doubling the
 * time already waited, never further than Core's deferral limit and never past the deadline. `None` once the
 * wait is exhausted.
 */
export const nextWakeAt = (now: DateTime.Utc, anchor: DateTime.Utc, deadline: DateTime.Utc): Option.Option<number> => {
  const nowMs = DateTime.toEpochMillis(now);
  const remaining = DateTime.toEpochMillis(deadline) - nowMs;
  if (remaining < MIN_REMAINING_MS) {
    return Option.none();
  }
  const waited = Math.max(0, nowMs - DateTime.toEpochMillis(anchor));
  return Option.some(nowMs + Math.min(Math.max(MIN_DEFERRAL_DELAY_MS, waited), MAX_DEFERRAL_DELAY_MS, remaining));
};

const requestedAtOf = (delivery: Delivery): DateTime.Utc => DateTime.makeUnsafe(delivery.payload.requestedAt);

/** The wake of a bounded wait anchored at the operation request, or `None` when the budget is spent. */
const budgetWake = (delivery: Delivery, now: DateTime.Utc): Option.Option<number> => {
  const anchor = requestedAtOf(delivery);
  return nextWakeAt(now, anchor, DateTime.add(anchor, { milliseconds: GATEWAY_WAIT_BUDGET_MS }));
};

/** The wake of the next Stripe replay attempt inside the persisted replay window. */
const replayWake = (now: DateTime.Utc, request: ProviderReplayRequest): Option.Option<number> =>
  nextWakeAt(
    now,
    request.window.startsAt,
    DateTime.subtract(request.window.expiresAt, { milliseconds: REPLAY_WINDOW_MARGIN_MS }),
  );

/** A bounded wait: defer while the budget lasts, then end with `onExhausted`. */
const waitOr = (execution: Execution, onExhausted: () => StepEffect): StepEffect =>
  Option.match(budgetWake(execution.delivery, execution.now), {
    onNone: onExhausted,
    onSome: (wakeAtMs) => Effect.succeed(defer(wakeAtMs)),
  });

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

const NOT_EFFECTED_FACT = {
  CANCEL_OR_VOID: 'CANCEL_NOT_EFFECTED',
  COLLECT: 'COLLECTION_NOT_EFFECTED',
  REFUND: 'REFUND_NOT_EFFECTED',
} as const satisfies Record<OperationKind, ProviderEvidenceFactKind>;

const UNSUPPORTED_REASON = {
  CANCEL_OR_VOID: 'provider_cancel_unsupported',
  COLLECT: 'provider_collect_unsupported',
  REFUND: 'provider_refund_unsupported',
} as const satisfies Record<OperationKind, string>;

const factFamilyOf = (factKind: ProviderEvidenceFactKind): ProviderEvidenceFactFamily =>
  factKind.startsWith('REFUND_') ? 'REFUND_EXECUTION' : 'GATEWAY_OUTCOME';

/**
 * A fact OntOS states without any provider answer (never sent, unsupported, withheld). Occurrence
 * `<family>:local:<operationId>:<factKind>` (plan §2.5), so a repeat is the same occurrence.
 */
const localEvidence = (input: {
  readonly factKind: ProviderEvidenceFactKind;
  readonly family: Family;
  readonly observedAt: DateTime.Utc;
  readonly operationId: string;
  readonly reason: string;
}): ProviderEvidence => ({
  discrepancy: Option.none(),
  economicEffectKey: Option.none(),
  factFamily: factFamilyOf(input.factKind),
  factKind: input.factKind,
  observedAmount: Option.none(),
  observedAt: input.observedAt,
  providerOccurredAt: Option.none(),
  providerRefs: [],
  reason: Option.some(input.reason),
  sourceOccurrenceId: `${input.family.toLowerCase()}:local:${input.operationId}:${input.factKind}`,
  sourceRevision: 0,
});

const appendEvidence = Effect.fn('GatewayOperationExecutor.appendEvidence')(function* appendEvidence(
  execution: Execution,
  operationId: string,
  evidence: ProviderEvidence,
  origin: 'DISPATCH_RESPONSE' | 'LOCAL_NOT_SENT',
) {
  const store = yield* ProviderEvidenceStore;
  return yield* store.append({
    bindingId: execution.target.bindingId,
    evidence,
    notificationId: Option.none(),
    operationId,
    origin,
    paymentId: execution.delivery.payload.paymentId,
    scope: execution.scope,
    workerContext: execution.delivery.context,
  });
});

/** Local evidence pending governed submission, for the executed operation unless another one is named. */
const appendLocal = (
  execution: Execution,
  factKind: ProviderEvidenceFactKind,
  reason: string,
  operationId: string = execution.identity.operationId,
) =>
  appendEvidence(
    execution,
    operationId,
    localEvidence({
      factKind,
      family: execution.delivery.binding.providerFamily,
      observedAt: execution.now,
      operationId,
      reason,
    }),
    'LOCAL_NOT_SENT',
  );

/**
 * Evidence of a provider finding. COLLECTION_PENDING only says the customer still has to act; it changes no
 * Payment state and is not kept as submission debt (plan §2.1 step 7).
 */
const appendFinding = (execution: Execution, finding: ProviderFindingResult) =>
  Option.match(finding.evidence.pipe(Option.filter((evidence) => evidence.factKind !== 'COLLECTION_PENDING')), {
    onNone: () => Effect.void,
    onSome: (evidence) =>
      appendEvidence(execution, finding.target.operationId, evidence, 'DISPATCH_RESPONSE').pipe(Effect.asVoid),
  });

/** A cancel answer's proof about its own collection target (e.g. already paid) is kept as well (#1156). */
const appendTargetFinding = (execution: Execution, targetFinding: Option.Option<ProviderFindingResult>) =>
  Option.match(
    targetFinding.pipe(
      Option.filter((found) => Option.contains(execution.identity.targetOperationId, found.target.operationId)),
    ),
    { onNone: () => Effect.void, onSome: (found) => appendFinding(execution, found) },
  );

// ---------------------------------------------------------------------------------------------
// Terminal ledger steps
// ---------------------------------------------------------------------------------------------

const writeOf = (execution: Execution) => ({ scope: execution.scope, workerContext: execution.delivery.context });

/** Never sent: the terminal NOT_SENT row and its NOT_EFFECTED evidence, pending submission. */
const notSent = Effect.fn('GatewayOperationExecutor.notSent')(function* notSent(
  execution: Execution,
  reason: ProviderNotSentReason,
  evidenceReason: string,
) {
  const ledger = yield* ProviderDispatchLedger;
  yield* ledger.recordNotSent({ ...writeOf(execution), identity: execution.identity, reason });
  yield* appendLocal(execution, NOT_EFFECTED_FACT[execution.identity.operationKind], evidenceReason);
  return COMPLETE;
});

/** The family cannot perform the operation: UNSUPPORTED plus NOT_EFFECTED evidence. Never a fallback. */
const unsupported = Effect.fn('GatewayOperationExecutor.unsupported')(function* unsupported(execution: Execution) {
  const ledger = yield* ProviderDispatchLedger;
  const { operationKind } = execution.identity;
  yield* ledger.recordUnsupported({ ...writeOf(execution), identity: execution.identity });
  yield* appendLocal(execution, NOT_EFFECTED_FACT[operationKind], UNSUPPORTED_REASON[operationKind]);
  return COMPLETE;
});

/** A COLLECT targeted by a cancel is never sent: NOT_SENT(WITHHELD_FOR_CANCELLATION) + COLLECTION_NOT_EFFECTED. */
const withheldCollection = Effect.fn('GatewayOperationExecutor.withheldCollection')(function* withheldCollection(
  execution: Execution,
) {
  const ledger = yield* ProviderDispatchLedger;
  yield* ledger.recordNotSent({
    ...writeOf(execution),
    identity: execution.identity,
    reason: 'WITHHELD_FOR_CANCELLATION',
  });
  yield* appendLocal(execution, 'COLLECTION_NOT_EFFECTED', WITHHELD_REASON);
  return COMPLETE;
});

// ---------------------------------------------------------------------------------------------
// Continuing from a persisted row
// ---------------------------------------------------------------------------------------------

const isWithinReplayWindow = (now: DateTime.Utc, request: ProviderReplayRequest) =>
  DateTime.isGreaterThanOrEqualTo(now, request.window.startsAt) && DateTime.isLessThan(now, request.window.expiresAt);

/**
 * A prepared row is never prepared again. PREPARED without a recorded answer is an unknown outcome; an
 * unknown Stripe outcome is replayed with the exact persisted request while its window is open. GoPay and
 * Comgate never resend: the unknown outcome stays as reconciliation debt.
 */
const continuePrepared = Effect.fn('GatewayOperationExecutor.continuePrepared')(function* continuePrepared(
  execution: Execution,
  adapter: GatewayProviderAdapter,
  record: ProviderDispatchRecord,
) {
  const ledger = yield* ProviderDispatchLedger;
  const unknown =
    record.state === 'PREPARED'
      ? yield* ledger.recordOutcomeUnknown({
          ...writeOf(execution),
          at: execution.now,
          operationId: record.operationId,
        })
      : record;
  const replay = Option.filter(
    replayRequestOf(unknown),
    (request) => unknown.state === 'OUTCOME_UNKNOWN' && isWithinReplayWindow(execution.now, request),
  );
  return Option.match(replay, {
    onNone: () => COMPLETE,
    onSome: (request) =>
      dispatchStep({ adapter, execution, prepared: request.prepared, record: unknown, replay: Option.some(request) }),
  });
});

/** Every other state is terminal for the executor (answered, never sent, unsupported, target unresolved). */
const continueFromRecord = (execution: Execution, adapter: GatewayProviderAdapter, record: ProviderDispatchRecord) =>
  record.state === 'PREPARED' || record.state === 'OUTCOME_UNKNOWN'
    ? continuePrepared(execution, adapter, record)
    : Effect.succeed(COMPLETE);

// ---------------------------------------------------------------------------------------------
// Preparing a new request
// ---------------------------------------------------------------------------------------------

/** Commits the prepared request (the durable handoff) and hands it to the send step. */
const commitPrepared = Effect.fn('GatewayOperationExecutor.commitPrepared')(function* commitPrepared(
  execution: Execution,
  adapter: GatewayProviderAdapter,
  prepared: PreparedProviderRequest,
  returnToken: Option.Option<GatewayReturnToken>,
  onDeferred: () => StepEffect,
) {
  const ledger = yield* ProviderDispatchLedger;
  const result = yield* ledger.prepare({ ...writeOf(execution), identity: execution.identity, prepared, returnToken });
  return yield* Match.valueTags(result, {
    CONFLICT: ({ existing }) =>
      Effect.fail(
        dispatchConflict(
          execution.identity.operationId,
          `The ledger holds another request for this operation (${existing.state}); nothing was sent`,
        ),
      ),
    DEFERRED: onDeferred,
    // A concurrent identical prepare: the other attempt sends. Look again after the first wait.
    EXISTING: () => Effect.succeed(defer(DateTime.toEpochMillis(execution.now) + MIN_DEFERRAL_DELAY_MS)),
    PREPARED: ({ record }) =>
      Effect.succeed(dispatchStep({ adapter, execution, prepared, record, replay: Option.none() })),
    WITHHELD: () => withheldCollection(execution),
  });
});

/** Prepare failures: Unsupported is terminal; Unavailable waits, then ends NOT_SENT(PREPARE_UNAVAILABLE). */
const prepareThen = (
  execution: Execution,
  adapter: GatewayProviderAdapter,
  prepare: Effect.Effect<PreparedProviderRequest, GatewayProviderUnavailableError | GatewayProviderUnsupportedError>,
  returnToken: Option.Option<GatewayReturnToken>,
  onDeferred: () => StepEffect,
): StepEffect =>
  prepare.pipe(
    Effect.matchEffect({
      onFailure: (failure) =>
        Match.valueTags(failure, {
          GatewayProviderUnavailable: () =>
            waitOr(execution, () => notSent(execution, 'PREPARE_UNAVAILABLE', 'prepare_unavailable')),
          GatewayProviderUnsupported: () => unsupported(execution),
        }),
      onSuccess: (prepared) => commitPrepared(execution, adapter, prepared, returnToken, onDeferred),
    }),
  );

/** 128 random bits as unpadded base64url: exactly 22 characters. */
const newReturnToken = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomBytes(RETURN_TOKEN_BYTES)),
  Effect.map((bytes) => GatewayReturnTokenSchema.make(Base64Url.encode(bytes))),
);

const executeCollect = Effect.fn('GatewayOperationExecutor.collect')(function* executeCollect(
  execution: Execution,
  adapter: GatewayProviderAdapter,
) {
  if (execution.operation.cancelDispatchExists || execution.operation.cancelOperationExists) {
    return yield* withheldCollection(execution);
  }
  // Fixed once, just before the first prepare; a redelivery continues from the persisted row instead.
  const returnToken = yield* newReturnToken;
  const { payload } = execution.delivery;
  return yield* prepareThen(
    execution,
    adapter,
    adapter.prepareCollect(execution.target, {
      amount: payload.amount,
      correlation: deriveProviderCorrelation(payload.operationId),
      issuedAt: execution.now,
      operationId: payload.operationId,
      payerContact: execution.operation.payerContact.pipe(Option.map(toGatewayPayerContact)),
      paymentId: payload.paymentId,
      returnToken,
    }),
    Option.some(returnToken),
    () => Effect.succeed(defer(DateTime.toEpochMillis(execution.now) + MIN_DEFERRAL_DELAY_MS)),
  );
});

const readOperation = (scope: OutboxWorkerLegalEntityScope, operationId: string) =>
  pspReadOperationForExecution(scope.routineInvoker, operationId).pipe(
    Effect.mapError((failure) => ledgerFailure(`${failure.routineKey} failed: ${failure.code}`)),
  );

/** The acknowledged provider payment of a CANCEL or REFUND target, if its collection was acknowledged. */
const acknowledgedTargetRef = (record: ProviderDispatchRecord): Option.Option<ProviderObjectRef> =>
  record.state === 'ACKNOWLEDGED' ? record.providerPaymentRef : Option.none();

const isRefundRef = (ref: ProviderObjectRef) =>
  Predicate.isTagged(ref, 'STRIPE_REFUND') || Predicate.isTagged(ref, 'GOPAY_REFUND');
const isPaymentIntentRef = (ref: ProviderObjectRef) => Predicate.isTagged(ref, 'STRIPE_PAYMENT_INTENT');

const REFUND_SERIALIZED_FAMILIES: ReadonlySet<Family> = new Set(['COMGATE', 'GOPAY']);

const requireTargetOperationId = (execution: Execution) =>
  Effect.fromOption(execution.identity.targetOperationId).pipe(
    Effect.catchTag('NoSuchElementError', () =>
      Effect.fail(dispatchConflict(execution.identity.operationId, 'The operation names no target operation')),
    ),
  );

/**
 * The provider payment a refund names. A Stripe collection is recorded as its Checkout Session, but a Stripe
 * refund names the PaymentIntent: a read-only lookup of that session through the same binding must confirm the
 * collection and name its PaymentIntent. Any other lookup answer or failure leaves the target unresolved.
 */
const refundProviderTarget = Effect.fn('GatewayOperationExecutor.refundProviderTarget')(function* refundProviderTarget(
  execution: Execution,
  adapter: GatewayProviderAdapter,
  targetRecord: ProviderDispatchRecord,
  collectionRef: ProviderObjectRef,
) {
  if (!Predicate.isTagged(collectionRef, 'STRIPE_CHECKOUT_SESSION')) {
    return Option.some(collectionRef);
  }
  const targetOperation = yield* readOperation(execution.scope, targetRecord.operationId);
  const amount = targetOperation.pipe(
    Option.flatMap((operation) =>
      Schema.decodeUnknownOption(PaymentPositiveMonetaryAmountSchema)({
        amountMinor: operation.amountMinor,
        currency: operation.currency,
      }),
    ),
  );
  if (Option.isNone(amount)) {
    return Option.none<ProviderObjectRef>();
  }
  const findings = yield* adapter
    .lookup(execution.target, {
      dispatchedAt: targetRecord.preparedAt,
      expected: { _tag: 'COLLECT', amount: amount.value, operationId: targetRecord.operationId },
      target: { _tag: 'PROVIDER_OBJECT', ref: collectionRef },
    })
    .pipe(Effect.orElseSucceed((): readonly ProviderFindingResult[] => []));
  const confirmed = findings.find(
    (found) => found.finding === 'EFFECT_CONFIRMED' && found.target.operationId === targetRecord.operationId,
  );
  return Option.fromUndefinedOr(confirmed?.providerRefs.find(isPaymentIntentRef));
});

const executeRefund = Effect.fn('GatewayOperationExecutor.refund')(function* executeRefund(
  execution: Execution,
  adapter: GatewayProviderAdapter,
) {
  const ledger = yield* ProviderDispatchLedger;
  const { payload } = execution.delivery;
  const { refundBasis } = payload;
  const targetOperationId = yield* requireTargetOperationId(execution);
  if (refundBasis === undefined) {
    return yield* Effect.fail(dispatchConflict(payload.operationId, 'The refund request carries no refund basis'));
  }
  const targetRecord = yield* ledger.readByOperation({ operationId: targetOperationId, scope: execution.scope });
  const collectionRef = targetRecord.pipe(Option.flatMap(acknowledgedTargetRef));
  const providerTarget =
    Option.isSome(targetRecord) && Option.isSome(collectionRef)
      ? yield* refundProviderTarget(execution, adapter, targetRecord.value, collectionRef.value)
      : Option.none<ProviderObjectRef>();
  if (Option.isNone(providerTarget)) {
    return yield* waitOr(execution, () => notSent(execution, 'PREPARE_UNAVAILABLE', 'refund_target_unresolved'));
  }
  const priorRefundUnresolved = () =>
    waitOr(execution, () => notSent(execution, 'PRIOR_REFUND_UNRESOLVED', 'prior_refund_unresolved'));
  if (REFUND_SERIALIZED_FAMILIES.has(execution.delivery.binding.providerFamily)) {
    const unresolved = yield* ledger.hasUnresolvedRefund({
      bindingId: execution.target.bindingId,
      providerPaymentRef: providerTarget.value,
      scope: execution.scope,
    });
    if (unresolved) {
      return yield* priorRefundUnresolved();
    }
  }
  return yield* prepareThen(
    execution,
    adapter,
    adapter.prepareRefund(execution.target, {
      amount: payload.amount,
      correlation: deriveProviderCorrelation(payload.operationId),
      operationId: payload.operationId,
      providerTarget: providerTarget.value,
      refundBasisKind: refundBasis._tag,
      targetOperationId,
    }),
    Option.none(),
    priorRefundUnresolved,
  );
});

/** The never-sent COLLECT target of a cancel: its own ledger identity, read from its C16 operation. */
const targetIdentityOf = (execution: Execution, target: PspOperationForExecution) =>
  target.kind === 'COLLECT' && target.paymentId === execution.delivery.payload.paymentId
    ? Effect.succeed<ProviderDispatchIdentity>({
        materialHash: target.materialHash,
        operationId: target.operationId,
        operationKind: 'COLLECT',
        paymentId: target.paymentId,
        target: execution.target,
        targetOperationId: Option.none(),
      })
    : Effect.fail(
        dispatchConflict(execution.identity.operationId, 'The cancel target is not a COLLECT of the same Payment'),
      );

/**
 * The collection was never sent and never will be: the COLLECT is withheld, the cancel needs no provider
 * call, and both facts are local evidence pending submission (COLLECTION_NOT_EFFECTED + CANCEL_CONFIRMED, N14).
 */
const cancelNeverSentTarget = Effect.fn('GatewayOperationExecutor.cancelNeverSentTarget')(
  function* cancelNeverSentTarget(execution: Execution, targetOperation: PspOperationForExecution) {
    const ledger = yield* ProviderDispatchLedger;
    const targetIdentity = yield* targetIdentityOf(execution, targetOperation);
    yield* ledger.recordNotSent({
      ...writeOf(execution),
      identity: targetIdentity,
      reason: 'WITHHELD_FOR_CANCELLATION',
    });
    yield* ledger.recordNotSent({ ...writeOf(execution), identity: execution.identity, reason: 'TARGET_WITHHELD' });
    yield* appendLocal(execution, 'COLLECTION_NOT_EFFECTED', WITHHELD_REASON, targetOperation.operationId);
    yield* appendLocal(execution, 'CANCEL_CONFIRMED', WITHHELD_REASON);
    return COMPLETE;
  },
);

/** The cancel target is still in flight: wait, then TARGET_UNRESOLVED (debt). Never CANCEL_CONFIRMED. */
const cancelTargetUnresolved = (execution: Execution) =>
  waitOr(execution, () =>
    ProviderDispatchLedger.pipe(
      Effect.flatMap((ledger) =>
        ledger.recordTargetUnresolved({
          ...writeOf(execution),
          at: execution.now,
          operationId: execution.identity.operationId,
        }),
      ),
      Effect.as(COMPLETE),
    ),
  );

/** Branches a registered cancel on its target's ledger row, read under the target's lock. */
const cancelAgainstTarget = (
  execution: Execution,
  adapter: GatewayProviderAdapter,
  targetOperation: PspOperationForExecution,
  target: ProviderDispatchRecord,
) => {
  const targetNotEffected = () => notSent(execution, 'TARGET_NOT_EFFECTED', 'target_not_effected');
  const sendCancel = (providerTarget: ProviderObjectRef) =>
    prepareThen(
      execution,
      adapter,
      adapter.prepareCancel(execution.target, {
        operationId: execution.identity.operationId,
        providerTarget,
        targetOperationId: targetOperation.operationId,
      }),
      Option.none(),
      () => cancelTargetUnresolved(execution),
    );
  return Match.value(target.state).pipe(
    Match.when('NOT_SENT', () =>
      Option.contains(target.notSentReason, 'WITHHELD_FOR_CANCELLATION')
        ? cancelNeverSentTarget(execution, targetOperation)
        : targetNotEffected(),
    ),
    Match.whenOr('REJECTED_BEFORE_EFFECT', 'UNSUPPORTED', targetNotEffected),
    Match.when('ACKNOWLEDGED', () =>
      Option.match(acknowledgedTargetRef(target), {
        onNone: () => cancelTargetUnresolved(execution),
        onSome: sendCancel,
      }),
    ),
    Match.orElse(() => cancelTargetUnresolved(execution)),
  );
};

const executeCancel = Effect.fn('GatewayOperationExecutor.cancel')(function* executeCancel(
  execution: Execution,
  adapter: GatewayProviderAdapter,
) {
  const ledger = yield* ProviderDispatchLedger;
  const targetOperationId = yield* requireTargetOperationId(execution);
  const registration = yield* ledger.registerCancel({ ...writeOf(execution), cancel: execution.identity });
  if (registration.cancel.state !== 'AWAITING_TARGET') {
    return yield* continueFromRecord(execution, adapter, registration.cancel);
  }
  const targetOperation = yield* readOperation(execution.scope, targetOperationId).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.catchTag('NoSuchElementError', () =>
      Effect.fail(dispatchConflict(execution.identity.operationId, 'The cancel target is not in this scope')),
    ),
  );
  return yield* Option.match(registration.target, {
    onNone: () => cancelNeverSentTarget(execution, targetOperation),
    onSome: (target) => cancelAgainstTarget(execution, adapter, targetOperation, target),
  });
});

// ---------------------------------------------------------------------------------------------
// Decide step
// ---------------------------------------------------------------------------------------------

const sameBinding = (left: PaymentGatewayAccountBinding, right: PspOperationForExecution['binding']) =>
  Schema.is(PaymentGatewayAccountBindingSchema)(right) &&
  left.environment === right.environment &&
  left.providerAccountRef === right.providerAccountRef &&
  left.providerFamily === right.providerFamily;

/** The message must describe exactly the stored C16 operation; anything else is a conflict and nothing is sent. */
const verifyOperation = (delivery: Delivery, operation: PspOperationForExecution) => {
  const { payload } = delivery;
  const consistent =
    operation.kind === payload.kind &&
    operation.materialHash === payload.materialHash &&
    operation.paymentId === payload.paymentId &&
    operation.targetOperationId === payload.targetOperationId &&
    operation.amountMinor === payload.amount.amountMinor &&
    operation.currency === payload.amount.currency &&
    sameBinding(delivery.binding, operation.binding);
  return consistent
    ? Effect.void
    : Effect.fail(dispatchConflict(payload.operationId, 'The operation request does not match the stored operation'));
};

/** What a send, replay or answer may report on; a cancel also names its target COLLECT and its amount. */
const expectedEffectOf = Effect.fn('GatewayOperationExecutor.expectedEffect')(function* expectedEffectOf(
  scope: OutboxWorkerLegalEntityScope,
  delivery: Delivery,
) {
  const { payload } = delivery;
  if (payload.kind !== 'CANCEL_OR_VOID') {
    return Match.value(payload.kind).pipe(
      Match.when('COLLECT', (): GatewayExpectedEffect => ({
        _tag: 'COLLECT',
        amount: payload.amount,
        operationId: payload.operationId,
      })),
      Match.when('REFUND', (): GatewayExpectedEffect => ({
        _tag: 'REFUND',
        amount: payload.amount,
        operationId: payload.operationId,
      })),
      Match.exhaustive,
    );
  }
  const unknownTarget = () =>
    Effect.fail(dispatchConflict(payload.operationId, 'The cancel target is unknown or has no amount'));
  const target = yield* Effect.fromOption(Option.fromUndefinedOr(payload.targetOperationId)).pipe(
    Effect.flatMap((targetOperationId) => readOperation(scope, targetOperationId)),
    Effect.flatMap(Effect.fromOption),
    Effect.catchTag('NoSuchElementError', unknownTarget),
  );
  const amount = yield* Schema.decodeUnknownEffect(PaymentPositiveMonetaryAmountSchema)({
    amountMinor: target.amountMinor,
    currency: target.currency,
  }).pipe(Effect.catchTag('SchemaError', unknownTarget));
  const expected: GatewayExpectedEffect = {
    _tag: 'CANCEL_OR_VOID',
    operationId: payload.operationId,
    target: { amount, operationId: target.operationId },
  };
  return expected;
});

/** The binding's environment and ref in C17 form; a C16 binding outside that form can never resolve. */
const bindingQueryOf = (delivery: Delivery) =>
  Option.all({
    environment: Schema.decodeUnknownOption(GatewayEnvironmentSchema)(delivery.binding.environment),
    providerAccountRef: Schema.decodeUnknownOption(GatewayProviderAccountRefSchema)(
      delivery.binding.providerAccountRef,
    ),
  });

/**
 * The binding or adapter is unavailable: wait inside the budget (credentials can be repaired, routines
 * recover). Without a resolved binding no ledger row can be written, so an exhausted wait fails the delivery
 * with the typed unavailability and Core's retry policy owns it from there.
 */
const bindingUnavailable = (delivery: Delivery, now: DateTime.Utc, failure: GatewayProviderUnavailableError) =>
  Option.match(budgetWake(delivery, now), {
    onNone: () => Effect.fail(failure),
    onSome: (wakeAtMs) => Effect.succeed(defer(wakeAtMs)),
  });

/** The exact binding of the operation and the adapter of its family, or a wait. */
const resolveExecution = Effect.fn('GatewayOperationExecutor.resolveExecution')(function* resolveExecution(
  delivery: Delivery,
  scope: OutboxWorkerLegalEntityScope,
  operation: PspOperationForExecution,
  now: DateTime.Utc,
) {
  const { payload } = delivery;
  const family = delivery.binding.providerFamily;
  const query = yield* Effect.fromOption(bindingQueryOf(delivery)).pipe(
    Effect.catchTag('NoSuchElementError', () =>
      Effect.fail(
        new GatewayProviderUnavailable({ code: 'gateway_provider_unavailable', family, reason: 'binding_unknown' }),
      ),
    ),
  );
  const resolver = yield* GatewayBindingResolver;
  const adapters = yield* GatewayProviderAdapters;
  const target = yield* resolver.resolveExecutionTarget({
    customerConfigurationId:
      payload.kind === 'COLLECT' ? Option.some(operation.customerConfigurationId) : Option.none(),
    environment: query.environment,
    providerAccountRef: query.providerAccountRef,
    providerFamily: family,
    scope,
  });
  // Resolver first: a broken binding never reaches the adapter or the target operation read.
  const [adapter, expected] = yield* Effect.all([adapters.forFamily(family), expectedEffectOf(scope, delivery)], {
    concurrency: 1,
  });
  const execution: Execution = {
    delivery,
    expected,
    identity: {
      materialHash: payload.materialHash,
      operationId: payload.operationId,
      operationKind: payload.kind,
      paymentId: payload.paymentId,
      target,
      targetOperationId: Option.fromUndefinedOr(payload.targetOperationId),
    },
    now,
    operation,
    scope,
    target,
  };
  return { adapter, execution };
});

const executeResolved = Effect.fn('GatewayOperationExecutor.executeResolved')(function* executeResolved(
  execution: Execution,
  adapter: GatewayProviderAdapter,
) {
  const ledger = yield* ProviderDispatchLedger;
  const { identity } = execution;
  const existing = yield* ledger.readByOperation({ operationId: identity.operationId, scope: execution.scope });
  if (Option.isSome(existing)) {
    const record = existing.value;
    if (record.materialHash !== identity.materialHash || record.bindingId !== execution.target.bindingId) {
      return yield* Effect.fail(
        dispatchConflict(identity.operationId, 'The ledger row has another material or binding; nothing was sent'),
      );
    }
    // Prepare only when no row exists or the row is a registered cancel still awaiting its target.
    if (Option.isSome(record.preparedAt) || record.state !== 'AWAITING_TARGET') {
      return yield* continueFromRecord(execution, adapter, record);
    }
  }
  return yield* Match.value(identity.operationKind).pipe(
    Match.when('COLLECT', () => executeCollect(execution, adapter)),
    Match.when('REFUND', () => executeRefund(execution, adapter)),
    Match.when('CANCEL_OR_VOID', () => executeCancel(execution, adapter)),
    Match.exhaustive,
  );
});

const decide = Effect.fn('GatewayOperationExecutor.decide')(function* decide(
  delivery: Delivery,
  scope: OutboxWorkerLegalEntityScope,
  operation: PspOperationForExecution,
) {
  yield* verifyOperation(delivery, operation);
  if (operation.outcome !== 'PENDING') {
    // Definitive, INDETERMINATE or CONFLICT: nothing is left for the executor to cause.
    return COMPLETE;
  }
  const now = yield* DateTime.now;
  const resolved = yield* Effect.result(resolveExecution(delivery, scope, operation, now));
  if (Result.isFailure(resolved)) {
    return yield* Match.valueTags(resolved.failure, {
      GatewayDispatchConflict: Effect.fail,
      GatewayLedgerUnavailable: Effect.fail,
      GatewayProviderUnavailable: (failure) => bindingUnavailable(delivery, now, failure),
    });
  }
  return yield* executeResolved(resolved.success.execution, resolved.success.adapter);
});

// ---------------------------------------------------------------------------------------------
// Provider and record steps
// ---------------------------------------------------------------------------------------------

/** Exactly one provider attempt, outside any database transaction. */
const attemptProvider = (plan: DispatchPlan) =>
  Option.match(plan.replay, {
    onNone: (): Effect.Effect<ProviderDispatchResponse, AttemptFailure> =>
      plan.adapter.send(plan.execution.target, plan.prepared, plan.execution.expected),
    onSome: (request): Effect.Effect<ProviderDispatchResponse, AttemptFailure> =>
      plan.adapter.replay(plan.execution.target, request, plan.execution.expected),
  }).pipe(Effect.result);

/**
 * The references an acknowledgement records. A COLLECT records its collection object (a Stripe checkout session
 * before its payment intent); a REFUND records only its own refund object; a CANCEL or REFUND row already carries
 * its target's payment reference from the prepare step.
 */
const acknowledgedRefs = (kind: OperationKind, refs: readonly ProviderObjectRef[]) => {
  const collection =
    refs.find((ref) => !isRefundRef(ref) && !isPaymentIntentRef(ref)) ?? refs.find((ref) => isPaymentIntentRef(ref));
  return {
    providerPaymentRef: kind === 'COLLECT' ? Option.fromUndefinedOr(collection) : Option.none(),
    providerRefundRef: kind === 'REFUND' ? Option.fromUndefinedOr(refs.find((ref) => isRefundRef(ref))) : Option.none(),
  };
};

const recordAcknowledged = Effect.fn('GatewayOperationExecutor.recordAcknowledged')(function* recordAcknowledged(
  execution: Execution,
  finding: ProviderFindingResult,
) {
  const ledger = yield* ProviderDispatchLedger;
  yield* ledger.recordAcknowledged({
    ...writeOf(execution),
    ...acknowledgedRefs(execution.identity.operationKind, finding.providerRefs),
    customerRedirectUrl: finding.customerAction.pipe(Option.map((action) => action.redirectUrl)),
    operationId: execution.identity.operationId,
    respondedAt: execution.now,
  });
  yield* appendFinding(execution, finding);
  return COMPLETE;
});

/** REJECTED_BEFORE_EFFECT with the provider's NOT_EFFECTED evidence, or local evidence when it has none. */
const recordRejected = Effect.fn('GatewayOperationExecutor.recordRejected')(function* recordRejected(
  execution: Execution,
  finding: Option.Option<ProviderFindingResult>,
  reason: string,
) {
  const ledger = yield* ProviderDispatchLedger;
  yield* ledger.recordRejected({
    ...writeOf(execution),
    at: execution.now,
    operationId: execution.identity.operationId,
  });
  const providerFinding = finding.pipe(Option.filter((found) => Option.isSome(found.evidence)));
  yield* Option.match(providerFinding, {
    onNone: () =>
      appendLocal(execution, NOT_EFFECTED_FACT[execution.identity.operationKind], reason).pipe(Effect.asVoid),
    onSome: (found) => appendFinding(execution, found),
  });
  return COMPLETE;
});

/** An unknown outcome: Stripe waits for its next replay inside the window; GoPay and Comgate keep it as debt. */
const recordUnknown = Effect.fn('GatewayOperationExecutor.recordUnknown')(function* recordUnknown(
  execution: Execution,
  replay: Option.Option<ProviderReplayRequest>,
) {
  const ledger = yield* ProviderDispatchLedger;
  yield* ledger.recordOutcomeUnknown({
    ...writeOf(execution),
    at: execution.now,
    operationId: execution.identity.operationId,
  });
  return Option.match(replay.pipe(Option.flatMap((request) => replayWake(execution.now, request))), {
    onNone: () => COMPLETE,
    onSome: defer,
  });
});

/**
 * Records the provider answer. An unavailable provider never received the request: a Stripe dispatch is kept
 * as an unknown outcome and replayed with the same idempotency key; GoPay and Comgate cannot resend safely
 * after the handoff, so the operation ends REJECTED_BEFORE_EFFECT with NOT_EFFECTED evidence. An expired
 * replay window leaves the unknown outcome as reconciliation debt.
 */
const recordAnswer = Effect.fn('GatewayOperationExecutor.recordAnswer')(function* recordAnswer(
  plan: DispatchPlan,
  answer: Result.Result<ProviderDispatchResponse, AttemptFailure>,
) {
  const execution: Execution = { ...plan.execution, now: yield* DateTime.now };
  const replay = Option.orElse(plan.replay, () => replayRequestOf(plan.record));
  if (Result.isSuccess(answer)) {
    const { targetFinding } = answer.success;
    const recorded = yield* Match.valueTags(answer.success, {
      ACKNOWLEDGED: ({ finding }) => recordAcknowledged(execution, finding),
      REJECTED_BEFORE_EFFECT: ({ finding }) => recordRejected(execution, Option.some(finding), 'provider_rejected'),
    });
    yield* appendTargetFinding(execution, targetFinding);
    return recorded;
  }
  return yield* Match.valueTags(answer.failure, {
    GatewayProviderOutcomeUnknown: () => recordUnknown(execution, replay),
    GatewayProviderUnavailable: () =>
      Option.isSome(replay)
        ? recordUnknown(execution, replay)
        : recordRejected(execution, Option.none(), 'provider_unavailable_before_send'),
    GatewayProviderUnsupported: () => Effect.succeed(COMPLETE),
  });
});

// ---------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------

interface ScopedStep {
  readonly legalEntityId: string;
  readonly step: Step;
}

/** Visits one legal-entity scope: runs `step` there when the operation lives in it, at most once per delivery. */
const visitScope = Effect.fn('GatewayOperationExecutor.visitScope')(function* visitScope(
  scope: OutboxWorkerLegalEntityScope,
  operationId: string,
  outcome: Ref.Ref<Option.Option<ScopedStep>>,
  step: ScopeStep,
) {
  const operation = yield* readOperation(scope, operationId);
  if (Option.isNone(operation)) {
    return yield* Effect.void;
  }
  if (Option.isSome(yield* Ref.get(outcome))) {
    return yield* Effect.fail(ledgerFailure('operation_ambiguous: the operation exists in two legal entities'));
  }
  const result = yield* step(scope, operation.value);
  return yield* Ref.set(outcome, Option.some({ legalEntityId: scope.legalEntityId, step: result }));
});

/**
 * Runs `step` in the legal-entity scope transaction that holds the operation. The scope fan-out visits every
 * legal entity of the Tenant in its own transaction; the operation exists in exactly one of them.
 */
const inOperationScope = Effect.fn('GatewayOperationExecutor.inOperationScope')(function* inOperationScope(
  context: OutboxWorkerHandlerContext,
  operationId: string,
  legalEntityId: Option.Option<string>,
  step: ScopeStep,
) {
  const fanout = yield* OutboxWorkerLegalEntityScopeFanout;
  const outcome = yield* Ref.make(Option.none<ScopedStep>());
  yield* fanout.forEachScope(context, (scope) =>
    Option.exists(legalEntityId, (expected) => expected !== scope.legalEntityId)
      ? Effect.void
      : visitScope(scope, operationId, outcome, step),
  );
  return yield* Ref.get(outcome).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.catchTag('NoSuchElementError', () =>
      Effect.fail(ledgerFailure('operation_unknown: no legal entity of the Tenant holds the operation')),
    ),
  );
});

/** Completes, or defers the delivery to its wake; Core settles a deferral without spending a retry attempt. */
const settle = (step: Step) =>
  Option.match(step.wakeAtMs, {
    onNone: () => Effect.void,
    onSome: (wakeAtMs) => Effect.fail(new OutboxWorkerDeferred({ wakeAtMs })),
  });

/**
 * Executes one `operation-requested.v1` delivery. Non-gateway bindings and refunds routed to a configured
 * external executor are not C17 work and complete at once.
 */
export const executeGatewayOperation = Effect.fn('GatewayOperationExecutor.execute')(function* executeGatewayOperation(
  payload: OutboxPayload,
  context: OutboxWorkerHandlerContext,
) {
  const { binding, refundExecutionRoute } = payload;
  if (
    !Schema.is(PaymentGatewayAccountBindingSchema)(binding) ||
    (refundExecutionRoute !== undefined && refundExecutionRoute.routeKind !== 'ORIGINAL_GATEWAY_BINDING')
  ) {
    return yield* Effect.void;
  }
  const delivery: Delivery = { binding, context, payload };
  const decided = yield* inOperationScope(context, payload.operationId, Option.none(), (scope, operation) =>
    decide(delivery, scope, operation),
  );
  if (Option.isNone(decided.step.dispatch)) {
    return yield* settle(decided.step);
  }
  const plan = decided.step.dispatch.value;
  const answer = yield* attemptProvider(plan);
  const recorded = yield* inOperationScope(context, payload.operationId, Option.some(decided.legalEntityId), (scope) =>
    recordAnswer({ ...plan, execution: { ...plan.execution, scope } }, answer),
  );
  return yield* settle(recorded.step);
});

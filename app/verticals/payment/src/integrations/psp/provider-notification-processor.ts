import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Array as Arr, Context, Effect, Match, Option, Predicate, Schema } from 'effect';

import { PaymentOperationIdSchema } from '../../../shared/domain/payment-identifiers.ts';
import { ProviderNotificationStateSchema } from '../../../shared/domain/psp-vocabulary.ts';
import type { ProviderNotificationState } from '../../../shared/domain/psp-vocabulary.ts';
import { pspReadOperationForExecution } from '../../persistence/psp-worker-routines.ts';
import type { PspOperationForExecution } from '../../persistence/psp-worker-routines.ts';
import { stripeSignedObjectOrderReference } from '../stripe/stripe-event.ts';
import { GatewayBindingResolver } from './binding-resolver.ts';
import { routineUnavailable } from './dispatch-ledger-live.ts';
import { ProviderDispatchLedger } from './dispatch-ledger.ts';
import type { ProviderDispatchRecord } from './dispatch-ledger.ts';
import { ProviderEvidenceStore, ProviderEvidenceSubmissionOutcomeSchema } from './evidence-store.ts';
import type { ProviderEvidenceSubmissionOutcome, StoredProviderEvidence } from './evidence-store.ts';
import { isPermanentSubmissionRefusal } from './evidence-submission-live.ts';
import { ProviderEvidenceSubmitter } from './evidence-submission.ts';
import { ProviderNotificationStore } from './notification-store.ts';
import type { ProviderNotificationId, StoredProviderNotification } from './notification-store.ts';
import { GatewayProviderAdapters } from './psp-adapter.ts';
import type { GatewayProviderAdapter } from './psp-adapter.ts';
import type { GatewayOrderReference } from './psp-correlation.ts';
import type { GatewayLedgerUnavailableError } from './psp-errors.ts';
import { GatewayExpectedEffectSchema, ProviderObjectRefSchema } from './psp-request.ts';
import type { GatewayExecutionTarget, GatewayExpectedEffect, ProviderObjectRef } from './psp-request.ts';
import type { ProviderFindingResult } from './psp-result.ts';

/**
 * Processing of one captured provider notification (#1156, #1157; plan §2.3). A notification is only a
 * trigger: the worker re-reads the provider through the notification's own binding and correlates strictly
 * inside that binding. Evidence is appended to the C17 evidence table first and then submitted through the
 * governed A8 path; the browser is never involved.
 *
 * Correlation:
 * 1. the dispatch that recorded one of the notification's provider refs (same binding);
 * 2. else the COLLECT dispatch with the candidate order reference of a signed provider object (Stripe metadata),
 *    accepted only when the binding's own lookup proves that order reference for that operation. An
 *    OUTCOME_UNKNOWN dispatch then becomes ACKNOWLEDGED with the provider ref (`correlateUnknown`), so a later
 *    refund or cancel has its provider target;
 * 3. else HELD_UNCORRELATED. GoPay and Comgate notifications carry no order reference before a lookup, and
 *    their lookup needs the expected operation, so a lost GoPay/Comgate create response stays
 *    HELD_UNCORRELATED here and is resolved by reconciliation (handoff L-NOTIFY).
 *
 * Failures: binding resolution, ledger and provider unavailability fail the delivery (retried). A permanent
 * refusal of the governed submission path settles the notification as SUBMISSION_HELD and leaves the evidence
 * PENDING_SUBMISSION as reconciliation debt.
 */

export interface ProcessProviderNotificationInput {
  readonly notificationId: ProviderNotificationId;
  readonly scope: OutboxWorkerLegalEntityScope;
  readonly workerContext: OutboxWorkerHandlerContext;
}

const reasonText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

/** What processing did with one notification. */
export const ProviderNotificationProcessingSchema = Schema.TaggedUnion({
  /** A redelivery of an already processed (or IGNORED) notification; nothing changes. */
  ALREADY_PROCESSED: { state: ProviderNotificationStateSchema },
  HELD_UNCORRELATED: { reason: reasonText },
  /** The notification is not in this legal-entity scope. */
  NOT_FOUND: {},
  SETTLED: {
    operationId: PaymentOperationIdSchema,
    outcomes: Schema.Array(ProviderEvidenceSubmissionOutcomeSchema),
    state: ProviderNotificationStateSchema,
  },
  /** Evidence is stored but the governed submission path refused this delivery: it stays pending debt. */
  SUBMISSION_PENDING: { operationId: PaymentOperationIdSchema, reason: reasonText },
});
export type ProviderNotificationProcessing = typeof ProviderNotificationProcessingSchema.Type;

/**
 * Processing stops early: UNCORRELATED when no dispatch of the notification's binding could be proven to be what
 * the notification is about; SUBMISSION_REFUSED when the governed path refused this delivery itself.
 */
class NotificationProcessingStopped extends Schema.TaggedError<NotificationProcessingStopped>()(
  'NotificationProcessingStopped',
  { kind: Schema.Literals(['UNCORRELATED', 'SUBMISSION_REFUSED']), reason: reasonText },
) {}

const uncorrelated = (reason: string) =>
  Effect.fail(new NotificationProcessingStopped({ kind: 'UNCORRELATED', reason }));

const amountOf = (operation: PspOperationForExecution) => ({
  amountMinor: operation.amountMinor,
  currency: operation.currency,
});

/**
 * The operation(s) a lookup may report on, read from Payment through the worker's scoped routine. `None` when
 * the operation (or a cancel's collection target) is not in scope or its amount is not a positive amount.
 */
const readExpectedEffectLive = Effect.fn('ProviderNotificationProcessor.readExpectedEffect')(function* readExpected(
  scope: OutboxWorkerLegalEntityScope,
  record: ProviderDispatchRecord,
) {
  const read = (operationId: string) =>
    pspReadOperationForExecution(scope.routineInvoker, operationId).pipe(Effect.mapError(routineUnavailable));
  const operation = yield* read(record.operationId);
  if (Option.isNone(operation)) {
    return Option.none<GatewayExpectedEffect>();
  }
  const { kind, operationId, targetOperationId } = operation.value;
  if (kind !== 'CANCEL_OR_VOID') {
    return Schema.decodeUnknownOption(GatewayExpectedEffectSchema)({
      _tag: kind,
      amount: amountOf(operation.value),
      operationId,
    });
  }
  if (targetOperationId === undefined) {
    return Option.none<GatewayExpectedEffect>();
  }
  const collection = yield* read(targetOperationId);
  return collection.pipe(
    Option.flatMap((collectionTarget) =>
      Schema.decodeUnknownOption(GatewayExpectedEffectSchema)({
        _tag: 'CANCEL_OR_VOID',
        operationId,
        target: { amount: amountOf(collectionTarget), operationId: collectionTarget.operationId },
      }),
    ),
  );
});

/** Reads the expected effect of a dispatch from Payment. Unit tests replace it; production uses the routine. */
export const NotificationExpectedEffectReader = Context.Reference<{
  readonly read: (
    scope: OutboxWorkerLegalEntityScope,
    record: ProviderDispatchRecord,
  ) => Effect.Effect<Option.Option<GatewayExpectedEffect>, GatewayLedgerUnavailableError>;
}>('@app/payment/integrations/psp/provider-notification-processor/NotificationExpectedEffectReader', {
  defaultValue: () => ({ read: readExpectedEffectLive }),
});

const operationIdsOf = (expected: GatewayExpectedEffect): ReadonlySet<string> =>
  new Set(
    Match.valueTags(expected, {
      CANCEL_OR_VOID: ({ operationId, target }) => [operationId, target.operationId],
      COLLECT: ({ operationId }) => [operationId],
      REFUND: ({ operationId }) => [operationId],
    }),
  );

/** The provider object a dispatch's own lookup reads: its recorded object, else the notification's ref. */
const lookupRefOf = (record: ProviderDispatchRecord, notificationRef: ProviderObjectRef): ProviderObjectRef =>
  Option.getOrElse(
    record.operationKind === 'REFUND'
      ? Option.orElse(record.providerRefundRef, () => record.providerPaymentRef)
      : record.providerPaymentRef,
    () => notificationRef,
  );

const isStripeRefund = Schema.is(ProviderObjectRefSchema.members[3]);

/** The first collection-object ref of the notification (never a refund object) for order-reference correlation. */
const collectionRefOf = (notification: StoredProviderNotification) =>
  Arr.findFirst(notification.trigger.providerRefs, (ref) => !isStripeRefund(ref));

/** The order reference a signed provider object states; only a candidate until the lookup proves it. */
const orderReferenceCandidateOf = (notification: StoredProviderNotification): Option.Option<GatewayOrderReference> =>
  notification.trigger.family === 'STRIPE'
    ? notification.trigger.signedObject.pipe(Option.flatMap((signed) => stripeSignedObjectOrderReference(signed)))
    : Option.none();

interface Correlation {
  readonly findings: readonly ProviderFindingResult[];
  readonly record: ProviderDispatchRecord;
}

interface CorrelationContext {
  readonly adapter: GatewayProviderAdapter;
  readonly input: ProcessProviderNotificationInput;
  readonly notification: StoredProviderNotification;
  readonly target: GatewayExecutionTarget;
}

/** Looks the dispatch's own operation(s) up through the notification's binding; findings only for them. */
const lookupFor = Effect.fn('ProviderNotificationProcessor.lookup')(function* lookupFor(
  context: CorrelationContext,
  located: { readonly record: ProviderDispatchRecord; readonly ref: ProviderObjectRef },
) {
  const expectations = yield* NotificationExpectedEffectReader;
  const expected = yield* expectations.read(context.input.scope, located.record);
  if (Option.isNone(expected)) {
    return yield* uncorrelated('operation_unknown');
  }
  const findings = yield* context.adapter.lookup(context.target, {
    dispatchedAt: located.record.preparedAt,
    expected: expected.value,
    target: { _tag: 'PROVIDER_OBJECT', ref: located.ref },
  });
  const allowed = operationIdsOf(expected.value);
  return {
    findings: findings.filter((finding) => allowed.has(finding.target.operationId)),
    record: located.record,
  } satisfies Correlation;
});

/** Step 1: the dispatch that recorded one of the notification's refs inside its own binding. */
const byProviderRef = Effect.fn('ProviderNotificationProcessor.byProviderRef')(function* byProviderRef(
  context: CorrelationContext,
) {
  const ledger = yield* ProviderDispatchLedger;
  const { bindingId, trigger } = context.notification;
  const found = yield* Effect.forEach(
    trigger.providerRefs,
    (ref) =>
      ledger
        .readByProviderRef({ bindingId, providerRef: ref, scope: context.input.scope })
        .pipe(
          Effect.map(
            Option.flatMap((record) =>
              record.bindingId === bindingId ? Option.some({ record, ref: lookupRefOf(record, ref) }) : Option.none(),
            ),
          ),
        ),
    { concurrency: 1 },
  );
  return Arr.getSomes(found).at(0);
});

/** Step 2: lookup-verified order reference; an OUTCOME_UNKNOWN dispatch is acknowledged with the provider ref. */
const byOrderReference = Effect.fn('ProviderNotificationProcessor.byOrderReference')(function* byOrderReference(
  context: CorrelationContext,
) {
  const { notification } = context;
  const { bindingId } = notification;
  const { scope, workerContext } = context.input;
  const candidate = orderReferenceCandidateOf(notification);
  const notificationRef = collectionRefOf(notification);
  if (Option.isNone(candidate) || Option.isNone(notificationRef)) {
    return yield* uncorrelated('no_verifiable_order_reference');
  }
  const ledger = yield* ProviderDispatchLedger;
  const found = yield* ledger.readByOrderReference({ bindingId, orderReference: candidate.value, scope });
  if (Option.isNone(found) || found.value.bindingId !== bindingId || found.value.operationKind !== 'COLLECT') {
    return yield* uncorrelated('order_reference_unknown');
  }
  const record = found.value;
  const looked = yield* lookupFor(context, { record, ref: lookupRefOf(record, notificationRef.value) });
  const verified = looked.findings.some(
    (finding) =>
      finding.target.operationId === record.operationId &&
      Option.contains(finding.orderReference, record.orderReference),
  );
  if (!verified) {
    return yield* uncorrelated('order_reference_unverified');
  }
  if (record.state !== 'OUTCOME_UNKNOWN') {
    return looked;
  }
  const acknowledged = yield* ledger
    .correlateUnknown({
      bindingId,
      orderReference: record.orderReference,
      providerRef: notificationRef.value,
      scope,
      workerContext,
    })
    .pipe(Effect.catchTag('GatewayCorrelationConflict', () => uncorrelated('correlation_conflict')));
  return { ...looked, record: Option.getOrElse(acknowledged, () => record) } satisfies Correlation;
});

const correlate = Effect.fn('ProviderNotificationProcessor.correlate')(function* correlate(
  context: CorrelationContext,
) {
  const direct = yield* byProviderRef(context);
  return yield* direct === undefined ? byOrderReference(context) : lookupFor(context, direct);
});

/** Folds the A8 decisions into the notification's processing state. */
const settledStateOf = (
  outcomes: readonly ProviderEvidenceSubmissionOutcome[],
  evidenceConflict: boolean,
): ProviderNotificationState => {
  if (outcomes.includes('DENIED')) {
    return 'SUBMISSION_DENIED';
  }
  return evidenceConflict ||
    outcomes.length === 0 ||
    outcomes.some((outcome) => outcome === 'HELD' || outcome === 'CONFLICT')
    ? 'SUBMISSION_HELD'
    : 'SUBMITTED';
};

/** Appends every provable fact (same binding; the ledger takes received_at from the notification row). */
const appendEvidence = Effect.fn('ProviderNotificationProcessor.appendEvidence')(function* appendEvidence(
  context: CorrelationContext,
  correlation: Correlation,
) {
  const evidenceStore = yield* ProviderEvidenceStore;
  const { notificationId, scope, workerContext } = context.input;
  const facts = correlation.findings.flatMap((finding) =>
    Option.match(finding.evidence, {
      onNone: () => [],
      // A pending collection is not a Payment fact (plan §2.1): the customer may still pay.
      onSome: (evidence) =>
        evidence.factKind === 'COLLECTION_PENDING' ? [] : [{ evidence, operationId: finding.target.operationId }],
    }),
  );
  const appended = yield* Effect.forEach(
    facts,
    ({ evidence, operationId }) =>
      evidenceStore
        .append({
          bindingId: context.notification.bindingId,
          evidence,
          notificationId: Option.some(notificationId),
          operationId,
          origin: 'NOTIFICATION_LOOKUP',
          paymentId: correlation.record.paymentId,
          scope,
          workerContext,
        })
        .pipe(
          Effect.map(Option.some),
          Effect.catchTag('GatewayEvidenceConflict', () => Effect.succeedNone),
        ),
    { concurrency: 1 },
  );
  const stored = Arr.getSomes(appended);
  return { evidenceConflict: stored.length !== appended.length, stored };
});

/** Submits one stored row through A8 (an already settled row keeps its recorded decision) and records it. */
const submitOne = Effect.fn('ProviderNotificationProcessor.submitOne')(function* submitOne(
  context: CorrelationContext,
  row: StoredProviderEvidence,
) {
  const { scope, workerContext } = context.input;
  if (row.submissionState !== 'PENDING_SUBMISSION') {
    return row.submissionState;
  }
  const submitter = yield* ProviderEvidenceSubmitter;
  const evidenceStore = yield* ProviderEvidenceStore;
  const decided = yield* submitter
    .submit({ binding: context.target.binding, evidence: row, scope, workerContext })
    .pipe(
      Effect.catchIf(isPermanentSubmissionRefusal, (refusal) =>
        Effect.fail(new NotificationProcessingStopped({ kind: 'SUBMISSION_REFUSED', reason: refusal.reason })),
      ),
    );
  const marked = yield* evidenceStore.markSubmission({
    evidenceId: row.evidenceId,
    observationId: decided.observationId,
    outcome: decided.outcome,
    scope,
    workerContext,
  });
  return marked.submissionState === 'PENDING_SUBMISSION' ? decided.outcome : marked.submissionState;
});

/** Processes one captured notification inside the worker's legal-entity scope. Idempotent per redelivery. */
export const processProviderNotification = Effect.fn('ProviderNotificationProcessor.process')(function* process(
  input: ProcessProviderNotificationInput,
) {
  const { notificationId, scope, workerContext } = input;
  const notifications = yield* ProviderNotificationStore;
  const read = yield* notifications.read({ notificationId, scope });
  if (Option.isNone(read)) {
    return ProviderNotificationProcessingSchema.cases.NOT_FOUND.make({});
  }
  const notification = read.value;
  if (notification.state !== 'CAPTURED' || !notification.trigger.actionable) {
    return ProviderNotificationProcessingSchema.cases.ALREADY_PROCESSED.make({ state: notification.state });
  }
  const transition = (to: ProviderNotificationState, correlatedOperationId: Option.Option<string>) =>
    notifications.transition({
      correlatedOperationId: correlatedOperationId.pipe(
        Option.map((operationId) => PaymentOperationIdSchema.make(operationId)),
      ),
      notificationId,
      scope,
      to,
      workerContext,
    });
  const hold = (reason: string) =>
    transition('HELD_UNCORRELATED', Option.none()).pipe(
      Effect.as(ProviderNotificationProcessingSchema.cases.HELD_UNCORRELATED.make({ reason })),
    );

  // Resolver failures are typed UNAVAILABLE for the stored notification's family: the delivery retries.
  const resolver = yield* GatewayBindingResolver;
  const target = yield* resolver.resolveForNotification({
    environment: notification.environment,
    providerAccountRef: notification.providerAccountRef,
    providerFamily: notification.trigger.family,
    scope,
  });
  if (target.bindingId !== notification.bindingId || target.binding.providerFamily !== notification.trigger.family) {
    return yield* hold('binding_mismatch');
  }
  const adapters = yield* GatewayProviderAdapters;
  const adapter = yield* adapters.forFamily(notification.trigger.family);
  const context: CorrelationContext = { adapter, input, notification, target };

  return yield* correlate(context).pipe(
    Effect.catchTag('GatewayProviderUnsupported', () => uncorrelated('lookup_unsupported')),
    Effect.flatMap((correlation) =>
      appendEvidence(context, correlation).pipe(
        Effect.flatMap(({ evidenceConflict, stored }) =>
          Effect.forEach(stored, (row) => submitOne(context, row), { concurrency: 1 }).pipe(
            Effect.flatMap((outcomes) => {
              const state = settledStateOf(outcomes, evidenceConflict);
              return transition(state, Option.some(correlation.record.operationId)).pipe(
                Effect.as(
                  ProviderNotificationProcessingSchema.cases.SETTLED.make({
                    operationId: correlation.record.operationId,
                    outcomes,
                    state,
                  }),
                ),
              );
            }),
          ),
        ),
        // The governed path refused this delivery: evidence stays PENDING_SUBMISSION, no planned retry.
        Effect.catchTag('NotificationProcessingStopped', ({ reason }) =>
          transition('SUBMISSION_HELD', Option.some(correlation.record.operationId)).pipe(
            Effect.as(
              ProviderNotificationProcessingSchema.cases.SUBMISSION_PENDING.make({
                operationId: correlation.record.operationId,
                reason,
              }),
            ),
          ),
        ),
      ),
    ),
    Effect.catchTag('NotificationProcessingStopped', ({ reason }) => hold(reason)),
    // `transition` refuses an operation of another binding: never apply it, never retry it as an outage.
    Effect.catchIf(
      (failure) =>
        Predicate.isTagged(failure, 'GatewayLedgerUnavailable') &&
        failure.reason === 'notification_transition_refused:binding_mismatch',
      () => hold('binding_mismatch'),
    ),
  );
});

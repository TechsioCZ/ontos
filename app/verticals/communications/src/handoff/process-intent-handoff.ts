import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { Clock, Data, DateTime, Duration, Effect, Exit, Match, Option, Schema } from 'effect';

import { CommunicationRequestIdSchema, MessageIntentIdSchema } from '../../shared/communication-intake.ts';
import type { DeliveryAttemptIdSchema } from '../../shared/communication-intake.ts';
import { ineligibleStateReasonOf } from '../domain/catalog/decision.ts';
import type { MessageIntentIdentity, StaleSourceReason } from '../domain/catalog/decision.ts';
import type { TransactionalMessageType } from '../domain/catalog/message-type.ts';
import {
  AudienceSlotKeySchema,
  CommunicationResourceRefSchema,
  MessageTypeIdSchema,
} from '../domain/catalog/vocabulary.ts';
import { MessageHandoff } from '../domain/handoff/message-handoff.ts';
import type { PinnedHandoff, ProviderEvidence } from '../domain/handoff/message-handoff.ts';
import { recoveryPolicyOf } from '../domain/catalog/message-type.ts';
import { DocumentPinSchema, pinnedDocumentOf, samePin } from '../domain/documents/document-pin.ts';
import type { DocumentPin, PinnedDocument } from '../domain/documents/document-pin.ts';
import type { DocumentReference } from '../domain/documents/document-reference.ts';
import { attemptMayHaveLeft } from '../domain/history/delivery-result.ts';
import { stopReasonCodeOf } from '../domain/history/timeline.ts';
import { ProviderObservationInputSchema } from '../domain/history/provider-observation.ts';
import { attemptIdOf } from '../domain/intake/identity.ts';
import { decodeIntakeInput } from '../domain/intake/intake-input.ts';
import { MessageTypeCatalog } from '../domain/intake/message-type-catalog.ts';
import { SourceOccurrenceAuthority } from '../domain/intake/source-authority.ts';
import { SelectedLanguageDecisionSchema } from '../domain/language/vocabulary.ts';
import { decideMessageHandoffs } from '../domain/privacy/handoff-decision.ts';
import { ProcessingScopeSchema } from '../domain/privacy/processing-scope.ts';
import { HandoffFact, MessageHandoffDecision, ProviderFact, SourceCurrentness } from '../domain/privacy/suppression.ts';
import type { SourceCurrentnessCase, SuppressionReason } from '../domain/privacy/suppression.ts';
import { OriginalRecipientBindingSchema } from '../domain/recipient/original-binding.ts';
import { HandoffPinSchema } from '../domain/recipient/recheck-before-handoff.ts';
import { assessAttemptHistory, confirmContinuation } from '../domain/recovery/retry-eligibility.ts';
import type { Continuation, HistoryAssessment } from '../domain/recovery/retry-eligibility.ts';
import { RETRY_REASON_CODE } from '../domain/recovery/vocabulary.ts';
import type { RecoveryHaltCode } from '../domain/recovery/vocabulary.ts';
import { ingestProviderObservation } from '../history/provider-observations.ts';
import { StoredIntentFactsSchema, timelineFactsOfStored } from '../history/stored-intent-facts.ts';
import {
  workerBeginAttemptRoutine,
  workerBeginRetryAttemptRoutine,
  workerFinishAttemptRoutine,
  workerPinDocumentRoutine,
  workerReadIntentRoutine,
  workerRecordRecoveryEvaluationRoutine,
  workerRecordStopRoutine,
} from '../persistence/communications-routines.ts';
import { discloseDocuments, documentStopOf } from './document-disclosure-step.ts';
import type { DocumentVerdict } from './document-disclosure-step.ts';
import { storeUnavailable } from './handoff-errors.ts';
import type { HandoffStoreUnavailable } from './handoff-errors.ts';
import { PREPARE_MESSAGE_HANDOFF_LEASE_MS } from './handoff-lease.ts';
import { languagePolicyPortOverRoutines, readTemplatePortOverRoutines } from '../persistence/snapshot-ports.ts';
import { verifyLanguageForHandoff } from '../services/language-selection.service.ts';

/**
 * The pre-handoff step of ONE Message Intent (#1401), run by the owner's Outbox worker. Core delivers it at least
 * once, to several instances, after crashes, so the step is idempotent by construction and never claims exactly-once:
 *
 * 1. it reads the pinned intent the decision stored and nothing else about the message;
 * 2. it asks every Current gate again NOW (approved type, language and template pin, source validity, the ORIGINAL
 *    recipient and endpoint, Privacy for the exact stored scope); a retained ALLOWED is never an input;
 * 3. any stop is recorded with its reasons and nothing is handed off;
 * 4. otherwise the delivery attempt is recorded BEFORE the handoff is called, so a crash after the call leaves
 *    evidence that an effect may exist and no later processing resends blindly (I-09). A second worker that finds the
 *    attempt never calls out; an attempt without a provider answer stays unresolved until reconciliation.
 *
 * RECOVERY (#1403). The same step is the only entry of Technical Retry, and every delivery of it is a fresh evaluation, so
 * nothing runs on a clock: Core redelivering the message (also its technical redrive, which is not a new send approval) or
 * a recorded reconciliation is what triggers one. A later attempt of the SAME intent follows only a PROVEN non-acceptance of
 * the earlier one (nothing submitted, a provider refusal, or a reconciled non-acceptance) and only when the approved recovery
 * rule of the type says so; the Current gates are asked again from scratch and the history guard has the last word. An
 * unknown or contradicted effect, and an acceptance, begin nothing. See `domain/recovery/retry-eligibility.ts`.
 */

/**
 * The typed, retryable failure that asks CORE to deliver the message again (#1403). It is raised only after an attempt that the
 * provider PROVABLY refused, when the approved recovery rule of the type allows another attempt. It is not an error of the
 * step: everything was recorded. Core's Outbox runtime answers any declared handler failure by returning the delivery to
 * `pending` after the descriptor's own backoff (or `dead` at its maximum, which only an operator moves on), and the redelivered
 * step is a fresh evaluation that asks every Current gate again. That is the ONLY automatic trigger of a Technical Retry, and it
 * uses the one retry configuration this owner has (the worker descriptor's `retryPolicy`): no timer, queue or cadence is added.
 */
export class NonAcceptanceRetryDue extends Data.TaggedError('NonAcceptanceRetryDue')<{ readonly intentId: string }> {}

export { HandoffStoreUnavailable, storeUnavailable } from './handoff-errors.ts';

/** Core redelivers the message (see `NonAcceptanceRetryDue`) exactly when the step ended with a retry that is due; otherwise it is done. */
export const requireRedeliveryWhenRetryDue = (processing: HandoffProcessing) =>
  processing.kind === 'HANDED_OFF' && processing.followUp === 'RETRY_DUE'
    ? Effect.fail(new NonAcceptanceRetryDue({ intentId: processing.intentId }))
    : Effect.void;

/** Why an intent stopped, in the vocabulary of the suppression lane plus the checks of this step. */
export interface StopReason {
  readonly category: string;
  readonly cause: string;
  readonly proven: boolean;
}

export const SkipReasonSchema = Schema.Literals([
  'ALREADY_FINISHED',
  'ALREADY_STOPPED',
  'INTENT_MISSING',
  'NOT_PENDING',
  'RECONCILIATION_REQUIRED',
]);
export type SkipReason = typeof SkipReasonSchema.Type;

/**
 * What follows an answer the provider gave, decided from the same history and approved rule the next evaluation uses:
 * - NONE: nothing more is automatic (accepted, unknown effect, no rule, limit reached, permanent refusal, nothing submitted);
 * - RETRY_DUE: the provider PROVABLY did not accept and the type's approved recovery rule allows another attempt, so the
 *   worker asks Core to deliver the message again under its own retry policy (see `prepare-message-handoff.worker.ts`).
 */
export const HandoffFollowUpSchema = Schema.Literals(['NONE', 'RETRY_DUE']);
export type HandoffFollowUp = typeof HandoffFollowUpSchema.Type;

/**
 * How a provider answer that arrived AFTER its attempt was already closed (a reconciliation closed it as an unanswered
 * INDETERMINATE) was kept: an ACCEPTED answer is appended as an acceptance observation (so the history says accepted/contradictory
 * and nothing is ever sent again), any other answer adds no proof the closed attempt does not already carry.
 */
export const LateAnswerRecordSchema = Schema.Literals(['ACCEPTANCE_OBSERVED', 'NOT_RECORDED', 'NO_NEW_PROOF']);
export type LateAnswerRecord = typeof LateAnswerRecordSchema.Type;

export type HandoffProcessing =
  | {
      readonly evidence: ProviderEvidence;
      readonly followUp: HandoffFollowUp;
      readonly intentId: string;
      readonly kind: 'HANDED_OFF';
    }
  /** The provider answered AFTER its attempt was closed by reconciliation: never swallowed, and never a reason to send again. */
  | {
      readonly evidence: ProviderEvidence;
      readonly intentId: string;
      readonly kind: 'LATE_ANSWER';
      readonly recorded: LateAnswerRecord;
    }
  /** Proven non-acceptance, but automatic recovery was not performed for this closed reason; the source owner decides. */
  | { readonly code: RecoveryHaltCode; readonly intentId: string; readonly kind: 'HALTED' }
  | { readonly intentId: string; readonly kind: 'SKIPPED'; readonly reason: SkipReason }
  | { readonly intentId: string; readonly kind: 'STOPPED'; readonly reasons: readonly StopReason[] };

const skipped = (intentId: string, reason: SkipReason) =>
  ({ intentId, kind: 'SKIPPED', reason }) satisfies HandoffProcessing;
const own = (category: string, cause: string, proven: boolean): StopReason => ({ category, cause, proven });
const asStopReason = ({ category, cause, proven }: SuppressionReason): StopReason => ({ category, cause, proven });

const EndpointPinSchema = Schema.Struct({
  channel: Schema.String,
  contactRef: CommunicationResourceRefSchema,
  contactRevision: Schema.optionalKey(Schema.Number),
  mask: Schema.String,
});
const IntentDocumentSchema = Schema.Struct({
  ...StoredIntentFactsSchema.fields,
  intent: Schema.Struct({
    endpointPin: Schema.optionalKey(EndpointPinSchema),
    handoffPin: HandoffPinSchema,
    intentId: MessageIntentIdSchema,
    languageDecision: Schema.optionalKey(Schema.Unknown),
    originalBinding: Schema.Unknown,
    processingScope: Schema.optionalKey(Schema.Unknown),
    purpose: Schema.String,
    recipientRole: Schema.String,
    slotKey: AudienceSlotKeySchema,
    status: Schema.Literals(['NOT_SENT', 'PENDING_HANDOFF', 'SUPPRESSED']),
    typeId: MessageTypeIdSchema,
    typeRevision: Schema.Number,
  }),
  request: Schema.Struct({ payload: Schema.Unknown, requestId: CommunicationRequestIdSchema }),
});
type IntentDocument = typeof IntentDocumentSchema.Type;

/** The stored pins decoded together: one defect of the stored document is one reason, never four partial ones. */
const StoredPinsSchema = Schema.Struct({
  binding: OriginalRecipientBindingSchema,
  language: SelectedLanguageDecisionSchema,
  request: CommunicationRequestSchema,
  scope: ProcessingScopeSchema,
});

const AttemptAnswerSchema = Schema.Struct({
  outcome: Schema.Literals([
    'BASIS_MISSING',
    'BEGUN',
    'CONFLICT_UNRESOLVED',
    'EXISTS',
    'MISSING',
    'NOT_PENDING',
    'STALE',
    'STOPPED',
  ]),
  state: Schema.optionalKey(Schema.String),
});
const StopAnswerSchema = Schema.Struct({ outcome: Schema.String });
const RecoveryAnswerSchema = Schema.Struct({ outcome: Schema.Literals(['FINAL', 'MISSING', 'RECORDED', 'UNCHANGED']) });
const PinAnswerSchema = Schema.Struct({
  outcome: Schema.Literals(['EXISTS', 'MISSING', 'PINNED']),
  pin: Schema.optionalKey(DocumentPinSchema),
});
const FinishAnswerSchema = Schema.Struct({
  outcome: Schema.Literals(['CONFLICT', 'FINISHED', 'MISSING']),
  state: Schema.optionalKey(Schema.String),
});

const documentOf = <Result>(
  rows: readonly { readonly result: unknown }[],
  schema: Schema.Decoder<Result>,
  reason: string,
) =>
  Schema.decodeUnknownEffect(schema)(rows[0]?.result).pipe(Effect.mapError((cause) => storeUnavailable(reason, cause)));

/** The latest attempt of the intent, which a recovery evaluation is about. */
const latestAttemptOf = (document: IntentDocument) =>
  document.attempts.toSorted((left, right) => left.attemptNumber - right.attemptNumber).at(-1);

/**
 * Records a stop. An intent that has no attempt that may have left stops in the handoff stops, per evaluation (a proven one is
 * final, an unproven one is superseded by the next Current evaluation). An intent that already has such an attempt is stopped
 * as a RECOVERY evaluation about its latest attempt, with the same rules, and never as if nothing had been submitted.
 */
const stopIntent = Effect.fn('Communications.recordHandoffStop')(function* recordStop(
  invoker: ScopedRoutineInvoker,
  document: IntentDocument,
  reasons: readonly StopReason[],
) {
  const { intentId } = document.intent;
  const stopped = { intentId, kind: 'STOPPED', reasons } satisfies HandoffProcessing;
  const latest = latestAttemptOf(document);
  // the SAME technical fact the timeline reads: an attempt that made no request at all (no adapter, or no usable configuration)
  // never let the message leave, so an intent with only such attempts is stopped like one with none, and a proven stop is final
  if (latest !== undefined && document.attempts.some(attemptMayHaveLeft)) {
    const rows = yield* invoker
      .invoke(workerRecordRecoveryEvaluationRoutine, [
        intentId,
        latest.attemptId,
        'STOPPED',
        reasons[0] === undefined ? 'GATE_UNANSWERED' : stopReasonCodeOf(reasons[0]),
        reasons.map((reason) => ({ ...reason })),
      ])
      .pipe(Effect.mapError((cause) => storeUnavailable('The recovery stop could not be recorded', cause)));
    const { outcome } = yield* documentOf(rows, RecoveryAnswerSchema, 'The recovery stop answer was unreadable');
    return outcome === 'MISSING' ? skipped(intentId, 'INTENT_MISSING') : stopped;
  }
  const rows = yield* invoker
    .invoke(workerRecordStopRoutine, [intentId, reasons.map((reason) => ({ ...reason }))])
    .pipe(Effect.mapError((cause) => storeUnavailable('The handoff stop could not be recorded', cause)));
  const { outcome } = yield* documentOf(rows, StopAnswerSchema, 'The handoff stop answer was unreadable');
  return outcome === 'ATTEMPT_EXISTS' ? skipped(intentId, 'RECONCILIATION_REQUIRED') : stopped;
});

/**
 * Records that automatic action did NOT continue an intent although nothing is known to have been accepted (no approved
 * recovery rule, or the owner's own limit reached): the closed reason is kept, nothing is handed off, and the source owner
 * decides. A halt proves nothing against the message and is evaluated again at the next delivery.
 */
const haltIntent = Effect.fn('Communications.recordRecoveryHalt')(function* recordHalt(
  invoker: ScopedRoutineInvoker,
  intentId: typeof MessageIntentIdSchema.Type,
  halt: { readonly attemptId: string; readonly code: RecoveryHaltCode },
) {
  const rows = yield* invoker
    .invoke(workerRecordRecoveryEvaluationRoutine, [intentId, halt.attemptId, 'HALTED', halt.code, []])
    .pipe(Effect.mapError((cause) => storeUnavailable('The recovery halt could not be recorded', cause)));
  const { outcome } = yield* documentOf(rows, RecoveryAnswerSchema, 'The recovery halt answer was unreadable');
  if (outcome === 'MISSING') {
    return skipped(intentId, 'INTENT_MISSING');
  }
  return outcome === 'FINAL'
    ? skipped(intentId, 'ALREADY_STOPPED')
    : ({ code: halt.code, intentId, kind: 'HALTED' } satisfies HandoffProcessing);
});

/** The source owner's own change (BR-08): stale only when the Current facts say the request is no longer justified. */
export const sourceCurrentnessOf = (
  type: {
    readonly currentness: { readonly requireLatestSourceRevision: boolean };
    readonly eligibleSourceStates: readonly string[];
    readonly ineligibleSourceStates?:
      | readonly { readonly reason: StaleSourceReason; readonly state: string }[]
      | undefined;
  },
  revision: number,
  facts: { readonly latestRevision: number; readonly state: string },
  validUntil: Option.Option<DateTime.Utc>,
  now: DateTime.Utc,
): SourceCurrentnessCase => {
  // the source's own stated expiry (`occurrence.validUntil`): a request past it is no longer justified, whatever the owner answers
  if (Option.exists(validUntil, (until) => DateTime.isLessThanOrEqualTo(until, now))) {
    return SourceCurrentness.Stale({ reason: 'SOURCE_NO_LONGER_VALID' });
  }
  if (type.currentness.requireLatestSourceRevision && revision !== facts.latestRevision) {
    return SourceCurrentness.Stale({ reason: 'SOURCE_REVISION_NOT_CURRENT' });
  }
  return type.eligibleSourceStates.includes(facts.state)
    ? SourceCurrentness.Current()
    : SourceCurrentness.Stale({ reason: ineligibleStateReasonOf(type, facts.state) });
};

/**
 * Runs one program in ONE scoped transaction of the verified Tenant. The step uses it twice, never around the handoff
 * call: the attempt must be COMMITTED before the call, or a crash after it would roll the evidence back with it.
 */
export type ScopedRunner = <Value, Requirements>(
  program: (invoker: ScopedRoutineInvoker) => Effect.Effect<Value, HandoffStoreUnavailable, Requirements>,
) => Effect.Effect<Value, HandoffStoreUnavailable, Requirements>;

interface StepInput {
  /**
   * The time the provider call of this delivery may take at most: the Core worker lease (`handoff-lease.ts`). Only a test of the
   * bound passes another value.
   */
  readonly callLeaseMs?: number | undefined;
  readonly intentId: typeof MessageIntentIdSchema.Type;
  readonly tenantId: string;
}

/** What every gate allowed: the original endpoint to call with, and the pins the provider is told. */
interface Cleared {
  /** The documents the source named, as references: the document step turns them into pins AFTER the gates (#1409). */
  readonly documentRefs: readonly DocumentReference[];
  readonly endpoint: PinnedHandoff['endpoint'];
  readonly language: typeof SelectedLanguageDecisionSchema.Type;
  readonly recipientRef: PinnedHandoff['recipientRef'];
}

type GateVerdict = { readonly cleared: Cleared } | { readonly reasons: readonly StopReason[] };

/** The language and template pin, verified over one consistent snapshot read in this scope. */
const languageGate = Effect.fn('Communications.languageGate')(function* checkLanguage(
  invoker: ScopedRoutineInvoker,
  language: typeof SelectedLanguageDecisionSchema.Type,
) {
  const templates = yield* readTemplatePortOverRoutines(
    invoker,
    { channel: language.pin.channel, messageType: language.pin.messageType, scope: language.pin.scope },
    language.pin.revisionId,
  ).pipe(Effect.mapError((cause) => storeUnavailable('The approved template revisions could not be read', cause)));
  return yield* verifyLanguageForHandoff(templates, languagePolicyPortOverRoutines(invoker), language).pipe(
    Effect.map((result) =>
      result.outcome === 'proceed'
        ? Option.none<StopReason>()
        : Option.some(own('LANGUAGE_GATE', result.reason, result.reason !== 'language_policy_unreadable')),
    ),
    Effect.catchTags({
      TemplatePinBlocked: (blocked) => Effect.succeed(Option.some(own('TEMPLATE_PIN', blocked.code, true))),
      TemplateStoreUnavailable: (cause) =>
        Effect.fail(storeUnavailable('The template revisions could not be verified', cause)),
    }),
  );
});

/** What the local gates decoded: the stored pins every owner gate is asked about. */
interface OpenPins {
  readonly binding: typeof OriginalRecipientBindingSchema.Type;
  readonly language: typeof SelectedLanguageDecisionSchema.Type;
  readonly request: typeof CommunicationRequestSchema.Type;
  readonly scope: typeof ProcessingScopeSchema.Type;
  readonly type: TransactionalMessageType;
}

type LocalGate = { readonly open: OpenPins } | { readonly reasons: readonly StopReason[] };

const retiredTypeCause = (type: TransactionalMessageType) => {
  if (type.status !== 'ACTIVE') {
    return type.status === 'DEACTIVATED' ? 'TYPE_DEACTIVATED' : 'TYPE_STALE';
  }
  return type.onboarding === 'ACTIVE' ? undefined : 'SOURCE_ONBOARDING_INACTIVE';
};

/**
 * The gates that only read this owner's own store, in cheap-and-local-first order: the approved type, the stored pins and
 * the language and template pin. They run INSIDE the first scoped transaction, which is therefore short.
 */
const localGates = Effect.fn('Communications.localGates')(function* gates(
  invoker: ScopedRoutineInvoker,
  document: IntentDocument,
) {
  const { intent } = document;
  const type = (yield* MessageTypeCatalog).byTypeId(intent.typeId);
  if (Option.isNone(type)) {
    return { reasons: [own('TYPE_UNAVAILABLE', 'TYPE_NOT_APPROVED', true)] } satisfies LocalGate;
  }
  // a retired purpose (#1403): the approved type was deactivated, went stale or lost its source onboarding since the decision
  const retired = retiredTypeCause(type.value);
  if (retired !== undefined) {
    return { reasons: [own('TYPE_UNAVAILABLE', retired, true)] } satisfies LocalGate;
  }
  const pins = yield* Schema.decodeUnknownEffect(StoredPinsSchema)({
    binding: intent.originalBinding,
    language: intent.languageDecision,
    request: document.request.payload,
    scope: intent.processingScope,
  }).pipe(Effect.option);
  if (Option.isNone(pins)) {
    return { reasons: [own('PIN_UNREADABLE', 'STORED_PIN_INVALID', true)] } satisfies LocalGate;
  }
  const languageStop = yield* languageGate(invoker, pins.value.language);
  return Option.isSome(languageStop)
    ? ({ reasons: [languageStop.value] } satisfies LocalGate)
    : ({ open: { ...pins.value, type: type.value } } satisfies LocalGate);
});

/**
 * The gates that ask ANOTHER owner Now (source occurrence, original recipient and endpoint, Privacy for the stored scope).
 * They run OUTSIDE any transaction: an owner call can take as long as its timeout, and no database connection of this
 * owner may wait for it. Nothing here is transactional: what must be (a second caller, a stop, an attempt) is decided
 * again by the routines of the next scoped transaction.
 */
const ownerGates = Effect.fn('Communications.ownerGates')(function* gates(document: IntentDocument, pins: OpenPins) {
  const { intent } = document;
  const { binding, language, request, scope, type } = pins;
  const input = yield* decodeIntakeInput(request);
  const facts = yield* (yield* SourceOccurrenceAuthority).read(input.decisionRequest).pipe(Effect.option);
  if (Option.isNone(facts)) {
    return { reasons: [own('SOURCE_AUTHORITY_UNAVAILABLE', 'OWNER_UNAVAILABLE', false)] } satisfies GateVerdict;
  }
  const identity: MessageIntentIdentity = {
    occurrenceId: input.decisionRequest.occurrence.occurrenceId,
    recipient: binding.recipientRef,
    revision: input.decisionRequest.occurrence.revision,
    slotKey: intent.slotKey,
    sourceModule: input.decisionRequest.source.moduleKey,
    tenantId: input.decisionRequest.tenantId,
    typeId: type.typeId,
  };
  const now = yield* DateTime.now;
  const [decision] = yield* decideMessageHandoffs(
    {
      recipient: { bindings: input.bindings, request: input.decisionRequest, scope: input.scope, type },
      source: sourceCurrentnessOf(
        type,
        request.occurrence.revision,
        facts.value,
        Option.fromNullishOr(request.occurrence.validUntil),
        now,
      ),
    },
    [
      {
        binding,
        // No attempt that may have left exists (checked before this), so the message is asked about, never "already handed off".
        handoff: HandoffFact.NotAttempted(),
        identity,
        pin: intent.handoffPin,
        // Provider-side suppression facts are step 22's; no such fact is known to this owner yet.
        provider: ProviderFact.Clear(),
        scope,
      },
    ],
  );
  if (decision === undefined) {
    return { reasons: [own('GATE_UNANSWERED', 'NO_DECISION', false)] } satisfies GateVerdict;
  }
  return MessageHandoffDecision.$match(decision, {
    AlreadyHandedOff: (): GateVerdict => ({ reasons: [own('HANDOFF_INDETERMINATE', 'UNEXPECTED_HANDED_OFF', false)] }),
    Proceed: ({ endpoint }): GateVerdict => ({
      cleared: { documentRefs: input.documents, endpoint, language, recipientRef: binding.recipientRef },
    }),
    ReconciliationRequired: (): GateVerdict => ({ reasons: [own('HANDOFF_INDETERMINATE', 'EFFECT_UNKNOWN', false)] }),
    Suppressed: ({ reasons }): GateVerdict => ({ reasons: reasons.map(asStopReason) }),
  });
});

const finishState = (evidence: ProviderEvidence) =>
  Match.value(evidence.outcome).pipe(
    Match.when({ kind: 'ACCEPTED' }, () => 'ACCEPTED' as const),
    Match.when({ kind: 'REJECTED' }, () => 'REJECTED' as const),
    Match.when({ kind: 'INDETERMINATE' }, () => 'INDETERMINATE' as const),
    // no adapter exists: provably nothing was submitted, which a real provider UNAVAILABLE never proves
    Match.when({ kind: 'NOT_ATTEMPTED' }, () => 'NOT_ATTEMPTED' as const),
    Match.orElse(() => 'UNAVAILABLE' as const),
  );

const echoes = (evidence: ProviderEvidence, message: PinnedHandoff) =>
  evidence.tenantId === message.tenantId &&
  evidence.intentId === message.intentId &&
  evidence.attemptId === message.attemptId;

/**
 * The handoff call. Whatever comes back, or does not, is data: a defect, an interruption, an answer bound to another
 * tenant, intent or attempt, or the end of the time the call may take is INDETERMINATE, because the effect may exist and must
 * be reconciled, never repeated.
 *
 * The call is BOUNDED by `remainingMs`: what is left of the Core worker lease of this delivery, measured from before the
 * attempt was begun. It is interrupted when it passes, so an attempt prepared longer ago than the lease has no call that can
 * still answer, which is exactly what reconciliation relies on before it closes a PREPARED attempt (`handoff-lease.ts`).
 */
const callHandoff = Effect.fn('Communications.callHandoff')(function* call(
  message: PinnedHandoff,
  remainingMs: number,
) {
  const handoff = yield* MessageHandoff;
  const indeterminate = (reason: 'response_invalid' | 'timeout' | 'transport'): ProviderEvidence => ({
    attemptId: message.attemptId,
    intentId: message.intentId,
    outcome: { kind: 'INDETERMINATE', reason },
    tenantId: message.tenantId,
  });
  const exit = yield* Effect.suspend(() => handoff.handoff(message)).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(Math.max(0, remainingMs)),
      orElse: () => Effect.succeed(indeterminate('timeout')),
    }),
    Effect.exit,
  );
  if (Exit.isFailure(exit)) {
    return indeterminate('transport');
  }
  return echoes(exit.value, message) ? exit.value : indeterminate('response_invalid');
});

/** What the first phase decided: stop, skip, or "this caller owns the one attempt and may call the provider". */
type Prepared =
  | HandoffProcessing
  | {
      readonly attemptId: typeof DeliveryAttemptIdSchema.Type;
      readonly kind: 'READY';
      readonly message: Omit<PinnedHandoff, 'attemptId'>;
    };

/** The reason a second caller does not own the attempt: an earlier caller stopped, or began, or finished it. */
const notBegunReason = (answer: typeof AttemptAnswerSchema.Type): SkipReason => {
  if (answer.outcome === 'STOPPED') {
    return 'ALREADY_STOPPED';
  }
  if (answer.outcome === 'MISSING') {
    return 'INTENT_MISSING';
  }
  if (answer.outcome === 'NOT_PENDING') {
    return 'NOT_PENDING';
  }
  if (answer.outcome === 'BASIS_MISSING' || answer.outcome === 'CONFLICT_UNRESOLVED') {
    // the history changed under this caller (an acceptance, or evidence that disagrees with itself): reconcile, never send
    return 'RECONCILIATION_REQUIRED';
  }
  // an attempt that may have left, or whose answer is unknown, is reconciled; only a final answer is "finished"
  return answer.state === 'ACCEPTED' || answer.state === 'REJECTED' || answer.state === 'NOT_ATTEMPTED'
    ? 'ALREADY_FINISHED'
    : 'RECONCILIATION_REQUIRED';
};

/** An intent that is not pending, or whose stop is PROVEN, is never processed again: such a stop is final. */
const skipOfDocument = (document: IntentDocument): Option.Option<SkipReason> => {
  if (document.intent.status !== 'PENDING_HANDOFF') {
    return Option.some('NOT_PENDING');
  }
  const provenStop =
    document.stops.some(({ proven }) => proven) ||
    document.recoveries.some(({ outcome, proven }) => outcome === 'STOPPED' && proven);
  return provenStop ? Option.some('ALREADY_STOPPED') : Option.none();
};

/** What the first read phase found: skip, stop, halt, or "every local gate is open, ask the other owners". */
type Loaded =
  | {
      readonly assessment: Extract<HistoryAssessment, { readonly kind: 'CONTINUE' | 'FIRST_ATTEMPT' }>;
      readonly document: IntentDocument;
      readonly kind: 'OPEN';
      readonly pins: OpenPins;
    }
  | {
      readonly attemptId: string;
      readonly code: RecoveryHaltCode;
      readonly document: IntentDocument;
      readonly kind: 'HALT';
    }
  | { readonly document: IntentDocument; readonly kind: 'STOP'; readonly reasons: readonly StopReason[] }
  | { readonly kind: 'SKIP'; readonly processing: HandoffProcessing };

/**
 * Phase 1a (scoped, short, own store only): read the intent and every fact of its history, decide from the history and the
 * approved recovery rule whether any attempt may follow, then run the local gates. The history is assessed BEFORE any gate, so
 * no owner is asked about a message that cannot be sent whatever they answer.
 */
const loadAndGate = Effect.fn('Communications.loadAndGate')(function* load(
  input: StepInput,
  invoker: ScopedRoutineInvoker,
) {
  const { intentId } = input;
  const read = yield* invoker
    .invoke(workerReadIntentRoutine, [intentId])
    .pipe(Effect.mapError((cause) => storeUnavailable('The Message Intent could not be read', cause)));
  if (read.length === 0) {
    return { kind: 'SKIP', processing: skipped(intentId, 'INTENT_MISSING') } satisfies Loaded;
  }
  const document = yield* documentOf(read, IntentDocumentSchema, 'The Message Intent document was unreadable');
  const skip = skipOfDocument(document);
  if (Option.isSome(skip)) {
    return { kind: 'SKIP', processing: skipped(intentId, skip.value) } satisfies Loaded;
  }
  // the CURRENT approved rule of the type: a rule that is not approved (or a type that is gone) recovers nothing automatically
  const type = (yield* MessageTypeCatalog).byTypeId(document.intent.typeId);
  const assessment = assessAttemptHistory(
    timelineFactsOfStored(document),
    Option.match(type, { onNone: () => ({ kind: 'NONE' }) as const, onSome: recoveryPolicyOf }),
  );
  if (assessment.kind === 'SKIP') {
    return { kind: 'SKIP', processing: skipped(intentId, assessment.reason) } satisfies Loaded;
  }
  if (assessment.kind === 'HALT') {
    return { attemptId: assessment.attemptId, code: assessment.code, document, kind: 'HALT' } satisfies Loaded;
  }
  if (assessment.kind === 'STOP') {
    return { document, kind: 'STOP', reasons: assessment.reasons } satisfies Loaded;
  }
  const gate = yield* localGates(invoker, document);
  return 'reasons' in gate
    ? ({ document, kind: 'STOP', reasons: gate.reasons } satisfies Loaded)
    : ({ assessment, document, kind: 'OPEN', pins: gate.open } satisfies Loaded);
});

/**
 * Stores the pins of the documents the owner answered FIRST, and answers with the stored pins or the one fact that the stored
 * pin of a position is not the answer this evaluation had. The first writer wins (`worker_pin_document` always returns what is
 * stored): two evaluations that resolved different Assets at the same moment must not both go on, so an evaluation that finds
 * another pin than its own answer does NOT adopt it; it stops with `DOCUMENT_PIN_NOT_CURRENT` and the next evaluation (which
 * reads the stored pin as `existing`) decides again against it.
 */
const pinDocuments = Effect.fn('Communications.pinDocuments')(function* pin(
  invoker: ScopedRoutineInvoker,
  intentId: typeof MessageIntentIdSchema.Type,
  pins: readonly DocumentPin[],
) {
  const answers = yield* Effect.forEach(
    pins,
    (candidate) =>
      invoker
        .invoke(workerPinDocumentRoutine, [
          intentId,
          candidate.position,
          candidate.document.moduleId,
          candidate.document.resourceType,
          candidate.document.resourceId,
          candidate.classification,
          candidate.form,
          candidate.assetRef.moduleId,
          candidate.assetRef.resourceType,
          candidate.assetRef.resourceId,
          candidate.revision,
        ])
        .pipe(
          Effect.mapError((cause) => storeUnavailable('The document pin could not be recorded', cause)),
          Effect.flatMap((rows) => documentOf(rows, PinAnswerSchema, 'The document pin answer was unreadable')),
          Effect.flatMap(({ outcome, pin: stored }) =>
            outcome === 'MISSING' || stored === undefined
              ? storeUnavailable('The document pin could not be stored')
              : Effect.succeed({ candidate, stored }),
          ),
        ),
    { concurrency: 1 },
  );
  // the pin that is stored is the first writer's: an answer that differs from this evaluation's own is never adopted
  return answers.every(({ candidate, stored }) => samePin(stored, candidate))
    ? ({ kind: 'PINNED', pins: answers.map(({ stored }) => stored) } as const)
    : ({ kind: 'DIVERGED' } as const);
});

const byPosition = (left: DocumentPin, right: DocumentPin) => left.position - right.position;

/** Phase 1c (scoped, short): the next attempt of a message every gate cleared; the routine re-checks everything transactional. */
const beginAttempt = Effect.fn('Communications.beginAttempt')(function* begin(
  input: StepInput,
  invoker: ScopedRoutineInvoker,
  document: IntentDocument,
  cleared: Cleared,
  continuation: Extract<Continuation, { readonly kind: 'BEGIN_FIRST' | 'BEGIN_RETRY' }>,
  documents: Extract<DocumentVerdict, { readonly kind: 'CLEARED' }>,
) {
  const { intentId } = input;
  // the pins are committed together with the attempt, BEFORE the provider is asked, so no handoff names an unpinned document
  const pinning = yield* pinDocuments(invoker, intentId, documents.toPin);
  if (pinning.kind === 'DIVERGED') {
    // another evaluation pinned another answer first: this one never goes on with its own, and never adopts the other
    return (yield* stopIntent(invoker, document, [documentStopOf('DOCUMENT_PIN_NOT_CURRENT')])) satisfies Prepared;
  }
  const pinned = [...documents.existing, ...pinning.pins];
  // the next attempt number: 1, or the one after an attempt that provably did not leave (`continuation.basis` says why)
  const attemptNumber = (latestAttemptOf(document)?.attemptNumber ?? 0) + 1;
  const attemptId = yield* attemptIdOf(intentId, attemptNumber);
  const rows = yield* (
    continuation.kind === 'BEGIN_FIRST'
      ? invoker.invoke(workerBeginAttemptRoutine, [intentId, attemptId, attemptNumber])
      : invoker.invoke(workerBeginRetryAttemptRoutine, [
          intentId,
          attemptId,
          attemptNumber,
          continuation.previousAttemptId,
          continuation.basis.kind,
          continuation.basis.kind === 'RECONCILED_NON_ACCEPTANCE' ? continuation.basis.observationId : null,
          RETRY_REASON_CODE[continuation.basis.kind],
        ])
  ).pipe(Effect.mapError((cause) => storeUnavailable('The delivery attempt could not be recorded', cause)));
  const begun = yield* documentOf(rows, AttemptAnswerSchema, 'The delivery attempt answer was unreadable');
  if (begun.outcome === 'STALE') {
    // another caller moved the attempts on between the read and this call: Core delivers again and the step re-reads
    return yield* storeUnavailable('The delivery attempt number was stale');
  }
  if (begun.outcome !== 'BEGUN') {
    return skipped(intentId, notBegunReason(begun)) satisfies Prepared;
  }
  const message = {
    endpoint: cleared.endpoint,
    intentId,
    language: cleared.language.language,
    purpose: document.intent.purpose,
    recipientRef: cleared.recipientRef,
    template: cleared.language.pin,
    tenantId: input.tenantId,
  } satisfies Omit<PinnedHandoff, 'attemptId' | 'documents'>;
  // a message without documents carries no `documents` at all: it is exactly what it always was
  const documentsOf: readonly PinnedDocument[] = pinned.toSorted(byPosition).map(pinnedDocumentOf);
  return {
    attemptId,
    kind: 'READY',
    message: pinned.length === 0 ? message : { ...message, documents: documentsOf },
  } satisfies Prepared;
});

/**
 * The document disclosure of the step (#1409): asked only when the request names documents, with the Current gates the step has
 * just cleared. The type's own `documents` policy decides; a type that has none stops a document the source named instead of
 * dropping it silently. The document owner is never asked for a message that names none.
 */
const documentGate = Effect.fn('Communications.documentGate')(function* gate(
  document: IntentDocument,
  pins: OpenPins,
  cleared: Cleared,
) {
  if (cleared.documentRefs.length === 0) {
    return { existing: [], kind: 'CLEARED', toPin: [] } satisfies DocumentVerdict;
  }
  return yield* discloseDocuments({
    documents: cleared.documentRefs,
    legalEntityId: pins.request.scope.legalEntityId,
    pinned: document.documents,
    policy: pins.type.documents,
    recipient: { recipientRef: pins.binding.recipientRef, role: pins.binding.role },
    tenantId: pins.request.scope.tenantId,
    typeId: pins.type.typeId,
  });
});

/**
 * Phases 1b and 1c: ask the other owners with no connection held, then record the stop, the halt or the next attempt. The
 * evaluation of the continuation is made AFTER the gates answered, so it is Current relative to every reconciliation evidence.
 */
const prepareHandoff = Effect.fn('Communications.prepareHandoff')(function* decide(
  input: StepInput,
  scoped: ScopedRunner,
  loaded: Loaded,
) {
  if (loaded.kind === 'SKIP') {
    return loaded.processing satisfies Prepared;
  }
  if (loaded.kind === 'HALT') {
    return (yield* scoped((invoker) =>
      haltIntent(invoker, input.intentId, { attemptId: loaded.attemptId, code: loaded.code }),
    )) satisfies Prepared;
  }
  if (loaded.kind === 'STOP') {
    return (yield* scoped((invoker) => stopIntent(invoker, loaded.document, loaded.reasons))) satisfies Prepared;
  }
  const { assessment, document } = loaded;
  const verdict = yield* ownerGates(document, loaded.pins);
  const continuation = confirmContinuation(
    timelineFactsOfStored(document),
    assessment,
    'reasons' in verdict ? { kind: 'STOPPED', reasons: verdict.reasons } : { kind: 'CLEARED' },
  );
  if (continuation.kind === 'STOP') {
    return (yield* scoped((invoker) => stopIntent(invoker, document, continuation.reasons))) satisfies Prepared;
  }
  if (continuation.kind === 'SKIP' || 'reasons' in verdict) {
    return skipped(input.intentId, 'RECONCILIATION_REQUIRED') satisfies Prepared;
  }
  // AFTER the recipient and Privacy gates cleared and BEFORE the handoff: a message that names no document never gets here
  const disclosure = yield* documentGate(document, loaded.pins, verdict.cleared);
  if (disclosure.kind === 'STOPPED') {
    return (yield* scoped((invoker) => stopIntent(invoker, document, disclosure.reasons))) satisfies Prepared;
  }
  return (yield* scoped((invoker) =>
    beginAttempt(input, invoker, document, verdict.cleared, continuation, disclosure),
  )) satisfies Prepared;
});

/**
 * An ACCEPTED answer as the one fact of the history that proves a presence: appended, never an edit of the closed attempt.
 * Any other answer adds nothing the closed attempt does not already say.
 */
const recordLateAnswer = Effect.fn('Communications.recordLateAnswer')(function* record(
  invoker: ScopedRoutineInvoker,
  evidence: ProviderEvidence,
) {
  const { outcome } = evidence;
  if (outcome.kind !== 'ACCEPTED') {
    return 'NO_NEW_PROOF' as const satisfies LateAnswerRecord;
  }
  const observation = yield* Schema.decodeUnknownEffect(ProviderObservationInputSchema)({
    attemptId: evidence.attemptId,
    evidence: { basis: 'PROVIDER_EVENT', kind: 'ACCEPTANCE_PROVEN' },
    intentId: evidence.intentId,
    observationKey: `submission-answer.${evidence.attemptId}`,
    observedAt: DateTime.formatIso(yield* DateTime.now),
    providerKey: outcome.providerKey,
    providerRef: outcome.providerRef,
    tenantId: evidence.tenantId,
  }).pipe(Effect.option);
  if (Option.isNone(observation)) {
    return 'NOT_RECORDED';
  }
  const recorded = yield* ingestProviderObservation(invoker, observation.value);
  return recorded === 'RECORDED' || recorded === 'DUPLICATE' ? 'ACCEPTANCE_OBSERVED' : 'NOT_RECORDED';
});

/**
 * Phase 3 (scoped): commits what the provider answered. The answer of the finish routine is NEVER swallowed. When the attempt
 * is no longer PREPARED (a reconciliation closed it as an unanswered INDETERMINATE while the call was in flight, or after the
 * call outlived its lease) the provider's own answer is still the truth: an ACCEPTED answer is appended as an acceptance
 * observation in the same transaction, which makes the intent accepted (or contradictory) and so blocks every later send; no
 * answer ever begins an attempt. Any other late answer adds nothing the closed attempt does not already say (an unknown effect).
 */
const finishAttempt = Effect.fn('Communications.finishAttempt')(function* finish(
  invoker: ScopedRoutineInvoker,
  attemptId: typeof DeliveryAttemptIdSchema.Type,
  evidence: ProviderEvidence,
  intentId: typeof MessageIntentIdSchema.Type,
) {
  const rows = yield* invoker
    .invoke(workerFinishAttemptRoutine, [attemptId, finishState(evidence), { ...evidence.outcome }])
    .pipe(Effect.mapError((cause) => storeUnavailable('The provider evidence could not be recorded', cause)));
  const { outcome } = yield* documentOf(rows, FinishAnswerSchema, 'The delivery attempt finish answer was unreadable');
  if (outcome === 'FINISHED') {
    return { evidence, followUp: 'NONE', intentId, kind: 'HANDED_OFF' } satisfies HandoffProcessing;
  }
  if (outcome === 'MISSING') {
    return yield* storeUnavailable('The delivery attempt to finish no longer exists');
  }
  return {
    evidence,
    intentId,
    kind: 'LATE_ANSWER',
    recorded: yield* recordLateAnswer(invoker, evidence),
  } satisfies HandoffProcessing;
});

/**
 * Whether the answer just recorded PROVES the provider did not accept the message AND the approved recovery rule allows another
 * attempt: the same evaluation the next delivery makes, over the history as it now stands. Only a provider REFUSAL qualifies. An
 * attempt that made no request (no adapter, no configuration) is a deployment condition that waiting does not change, so it is
 * left to the owner and to Core's operator redrive; an unknown effect, an acceptance, a missing rule and a reached limit never do.
 */
const followUpOf = (
  document: IntentDocument,
  attempt: { readonly attemptId: string; readonly attemptNumber: number },
  evidence: ProviderEvidence,
  policy: ReturnType<typeof recoveryPolicyOf> | { readonly kind: 'NONE' },
  now: DateTime.Utc,
): HandoffFollowUp => {
  const state = finishState(evidence);
  const reason = Match.value(evidence.outcome).pipe(
    Match.when({ kind: 'ACCEPTED' }, () => Option.none<string>()),
    Match.orElse(({ reason: answered }) => Option.some<string>(answered)),
    Option.getOrUndefined,
  );
  if (state !== 'REJECTED' || !attemptMayHaveLeft({ reason, state })) {
    return 'NONE';
  }
  const facts = timelineFactsOfStored(document);
  const assessment = assessAttemptHistory(
    { ...facts, attempts: [...facts.attempts, { ...attempt, finishedAt: now, preparedAt: now, reason, state }] },
    policy,
  );
  return assessment.kind === 'CONTINUE' && assessment.basis.kind === 'PRIOR_REJECTED' ? 'RETRY_DUE' : 'NONE';
};

export const processIntentHandoff = Effect.fn('Communications.processIntentHandoff')(function* process(
  input: StepInput,
  scoped: ScopedRunner,
) {
  // Three short scoped transactions and one call that holds none: (1a) read the intent and run the local gates, then,
  // with NO connection held, (1b) ask the other owners, then (1c) record the stop or the attempt. The attempt is COMMITTED
  // before the provider is asked; phase 3 commits what the provider answered. A second caller, a stop or an attempt that
  // appeared between the phases is decided again by the routines, so nothing relies on the phases being atomic.
  //
  // The delivery has the Core worker lease and no more: the provider call is bounded by what is left of it, measured from here,
  // which is before the attempt row is stamped. So a PREPARED attempt older than the lease has no call that can still answer.
  const startedAt = yield* Clock.currentTimeMillis;
  const leaseMs = input.callLeaseMs ?? PREPARE_MESSAGE_HANDOFF_LEASE_MS;
  const loaded = yield* scoped((invoker) => loadAndGate(input, invoker));
  const prepared = yield* prepareHandoff(input, scoped, loaded);
  if (prepared.kind !== 'READY') {
    return prepared;
  }
  const remainingMs = leaseMs - ((yield* Clock.currentTimeMillis) - startedAt);
  const evidence = yield* callHandoff({ ...prepared.message, attemptId: prepared.attemptId }, remainingMs);
  const finished = yield* scoped((invoker) => finishAttempt(invoker, prepared.attemptId, evidence, input.intentId));
  if (finished.kind !== 'HANDED_OFF' || loaded.kind !== 'OPEN') {
    return finished;
  }
  const type = (yield* MessageTypeCatalog).byTypeId(loaded.document.intent.typeId);
  const attemptNumber = (latestAttemptOf(loaded.document)?.attemptNumber ?? 0) + 1;
  const policy = Option.match(type, { onNone: () => ({ kind: 'NONE' }) as const, onSome: recoveryPolicyOf });
  return {
    ...finished,
    followUp: followUpOf(
      loaded.document,
      { attemptId: prepared.attemptId, attemptNumber },
      evidence,
      policy,
      yield* DateTime.now,
    ),
  } satisfies HandoffProcessing;
});

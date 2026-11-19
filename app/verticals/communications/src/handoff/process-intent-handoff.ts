import { CommunicationRequestSchema } from '@app/communications-contracts/communication-request';
import type { ScopedRoutineInvoker } from '@app/core-runtime';
import { Data, Effect, Exit, Match, Option, Schema } from 'effect';

import {
  CommunicationRequestIdSchema,
  DeliveryAttemptIdSchema,
  MessageIntentIdSchema,
} from '../../shared/communication-intake.ts';
import type { MessageIntentIdentity } from '../domain/catalog/decision.ts';
import type { TransactionalMessageType } from '../domain/catalog/message-type.ts';
import {
  AudienceSlotKeySchema,
  CommunicationResourceRefSchema,
  MessageTypeIdSchema,
} from '../domain/catalog/vocabulary.ts';
import { MessageHandoff } from '../domain/handoff/message-handoff.ts';
import type { PinnedHandoff, ProviderEvidence } from '../domain/handoff/message-handoff.ts';
import { attemptIdOf } from '../domain/intake/identity.ts';
import { decodeIntakeInput } from '../domain/intake/intake-input.ts';
import { safeCauseOf } from '../domain/intake/safe-cause.ts';
import { MessageTypeCatalog } from '../domain/intake/message-type-catalog.ts';
import { SourceOccurrenceAuthority } from '../domain/intake/source-authority.ts';
import { SelectedLanguageDecisionSchema } from '../domain/language/vocabulary.ts';
import { decideMessageHandoffs } from '../domain/privacy/handoff-decision.ts';
import { ProcessingScopeSchema } from '../domain/privacy/processing-scope.ts';
import { HandoffFact, MessageHandoffDecision, ProviderFact, SourceCurrentness } from '../domain/privacy/suppression.ts';
import type { SourceCurrentnessCase, SuppressionReason } from '../domain/privacy/suppression.ts';
import { OriginalRecipientBindingSchema } from '../domain/recipient/original-binding.ts';
import { HandoffPinSchema } from '../domain/recipient/recheck-before-handoff.ts';
import {
  workerBeginAttemptRoutine,
  workerFinishAttemptRoutine,
  workerReadIntentRoutine,
  workerRecordStopRoutine,
} from '../persistence/communications-routines.ts';
import { languagePolicyPortOverRoutines, readTemplatePortOverRoutines } from '../persistence/snapshot-ports.ts';
import { verifyLanguageForHandoff } from '../services/language-selection.service.ts';

/**
 * The pre-handoff step of ONE Message Intent (#1401), run by the owner's Outbox worker. Core delivers it at least
 * once, to several instances, after crashes, so the step is idempotent by construction and never claims exactly-once:
 *
 * 1. it reads the pinned intent the decision stored and nothing else about the message;
 * 2. it asks every Current gate again NOW (approved type, language and template pin, source validity, the ORIGINAL
 *    recipient and endpoint, Privacy for the exact stored scope); a retained ALLOWED is never an input;
 * 3. any stop is recorded once with its reasons and nothing is handed off;
 * 4. otherwise the single delivery attempt is recorded BEFORE the handoff is called, so a crash after the call leaves
 *    evidence that an effect may exist and no later processing resends blindly (I-09). A second worker that finds the
 *    attempt never calls out; an attempt without a provider answer stays unresolved until reconciliation (#1403).
 */

/** A retryable failure of the owner's own store: Core delivers the message again and the step is safe to repeat. */
export class HandoffStoreUnavailable extends Data.TaggedError('HandoffStoreUnavailable')<{
  readonly reason: string;
}> {}

/**
 * The typed, retryable failure. It keeps only the SAFE kind of the failure it replaces (non-enumerable): the raw cause of a
 * failed routine call carries its bound parameters, which include recipient references and the owner's mask.
 */
export const storeUnavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(new HandoffStoreUnavailable({ reason }), 'cause', {
    enumerable: false,
    value: cause === undefined ? undefined : safeCauseOf(cause),
  });

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

export type HandoffProcessing =
  | { readonly evidence: ProviderEvidence; readonly intentId: string; readonly kind: 'HANDED_OFF' }
  | { readonly intentId: string; readonly kind: 'SKIPPED'; readonly reason: SkipReason }
  | { readonly intentId: string; readonly kind: 'STOPPED'; readonly reasons: readonly StopReason[] };

const skipped = (intentId: string, reason: SkipReason) =>
  ({ intentId, kind: 'SKIPPED', reason }) satisfies HandoffProcessing;
const own = (category: string, cause: string, proven: boolean): StopReason => ({ category, cause, proven });
const asStopReason = ({ category, cause, proven }: SuppressionReason): StopReason => ({ category, cause, proven });

const AttemptStateSchema = Schema.Literals([
  'ACCEPTED',
  'INDETERMINATE',
  'NOT_ATTEMPTED',
  'PREPARED',
  'REJECTED',
  'UNAVAILABLE',
]);
const EndpointPinSchema = Schema.Struct({
  channel: Schema.String,
  contactRef: CommunicationResourceRefSchema,
  contactRevision: Schema.optionalKey(Schema.Number),
  mask: Schema.String,
});
const IntentDocumentSchema = Schema.Struct({
  attempt: Schema.optionalKey(
    Schema.Struct({ attemptId: DeliveryAttemptIdSchema, attemptNumber: Schema.Number, state: AttemptStateSchema }),
  ),
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
  stopped: Schema.Boolean,
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
  outcome: Schema.Literals(['BEGUN', 'EXISTS', 'MISSING', 'NOT_PENDING', 'STALE', 'STOPPED']),
  state: Schema.optionalKey(Schema.String),
});
const StopAnswerSchema = Schema.Struct({ outcome: Schema.String });
const FinishAnswerSchema = Schema.Struct({ outcome: Schema.Literals(['CONFLICT', 'FINISHED', 'MISSING']) });

const documentOf = <Result>(
  rows: readonly { readonly result: unknown }[],
  schema: Schema.Decoder<Result>,
  reason: string,
) =>
  Schema.decodeUnknownEffect(schema)(rows[0]?.result).pipe(Effect.mapError((cause) => storeUnavailable(reason, cause)));

const stopIntent = Effect.fn('Communications.recordHandoffStop')(function* recordStop(
  invoker: ScopedRoutineInvoker,
  intentId: typeof MessageIntentIdSchema.Type,
  reasons: readonly StopReason[],
) {
  const rows = yield* invoker
    .invoke(workerRecordStopRoutine, [intentId, reasons.map((reason) => ({ ...reason }))])
    .pipe(Effect.mapError((cause) => storeUnavailable('The handoff stop could not be recorded', cause)));
  const { outcome } = yield* documentOf(rows, StopAnswerSchema, 'The handoff stop answer was unreadable');
  return outcome === 'ATTEMPT_EXISTS'
    ? skipped(intentId, 'RECONCILIATION_REQUIRED')
    : ({ intentId, kind: 'STOPPED', reasons } satisfies HandoffProcessing);
});

/** The source owner's own change (BR-08): stale only when the Current facts say the request is no longer justified. */
const sourceCurrentnessOf = (
  type: {
    readonly currentness: { readonly requireLatestSourceRevision: boolean };
    readonly eligibleSourceStates: readonly string[];
  },
  revision: number,
  facts: { readonly latestRevision: number; readonly state: string },
): SourceCurrentnessCase => {
  if (type.currentness.requireLatestSourceRevision && revision !== facts.latestRevision) {
    return SourceCurrentness.Stale({ reason: 'SOURCE_REVISION_NOT_CURRENT' });
  }
  return type.eligibleSourceStates.includes(facts.state)
    ? SourceCurrentness.Current()
    : SourceCurrentness.Stale({ reason: 'SOURCE_STATE_INELIGIBLE' });
};

/**
 * Runs one program in ONE scoped transaction of the verified Tenant. The step uses it twice, never around the handoff
 * call: the attempt must be COMMITTED before the call, or a crash after it would roll the evidence back with it.
 */
export type ScopedRunner = <Value, Requirements>(
  program: (invoker: ScopedRoutineInvoker) => Effect.Effect<Value, HandoffStoreUnavailable, Requirements>,
) => Effect.Effect<Value, HandoffStoreUnavailable, Requirements>;

interface StepInput {
  readonly intentId: typeof MessageIntentIdSchema.Type;
  readonly tenantId: string;
}

/** What every gate allowed: the original endpoint to call with, and the pins the provider is told. */
interface Cleared {
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
  const [decision] = yield* decideMessageHandoffs(
    {
      recipient: { bindings: input.bindings, request: input.decisionRequest, scope: input.scope, type },
      source: sourceCurrentnessOf(type, request.occurrence.revision, facts.value),
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
    Proceed: ({ endpoint }): GateVerdict => ({ cleared: { endpoint, language, recipientRef: binding.recipientRef } }),
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
 * The handoff call. Whatever comes back, or does not, is data: a defect, an interruption or an answer bound to another
 * tenant, intent or attempt is INDETERMINATE, because the effect may exist and must be reconciled, never repeated.
 */
const callHandoff = Effect.fn('Communications.callHandoff')(function* call(message: PinnedHandoff) {
  const handoff = yield* MessageHandoff;
  const exit = yield* Effect.suspend(() => handoff.handoff(message)).pipe(Effect.exit);
  const indeterminate = (reason: 'response_invalid' | 'transport'): ProviderEvidence => ({
    attemptId: message.attemptId,
    intentId: message.intentId,
    outcome: { kind: 'INDETERMINATE', reason },
    tenantId: message.tenantId,
  });
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
  return answer.state === 'PREPARED' ? 'RECONCILIATION_REQUIRED' : 'ALREADY_FINISHED';
};

const skipOfDocument = (document: IntentDocument): Option.Option<SkipReason> => {
  if (document.intent.status !== 'PENDING_HANDOFF') {
    return Option.some('NOT_PENDING');
  }
  if (document.stopped) {
    return Option.some('ALREADY_STOPPED');
  }
  // only an attempt that provably submitted nothing leaves the intent open for a next one
  if (document.attempt === undefined || document.attempt.state === 'NOT_ATTEMPTED') {
    return Option.none();
  }
  return Option.some(document.attempt.state === 'PREPARED' ? 'RECONCILIATION_REQUIRED' : 'ALREADY_FINISHED');
};

/** What the first read phase found: skip, stop, or "every local gate is open, ask the other owners". */
type Loaded =
  | { readonly document: IntentDocument; readonly kind: 'OPEN'; readonly pins: OpenPins }
  | { readonly kind: 'STOP'; readonly reasons: readonly StopReason[] }
  | { readonly kind: 'SKIP'; readonly processing: HandoffProcessing };

/** Phase 1a (scoped, short, own store only): read the intent, decide whether it is open, run the local gates. */
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
  const gate = yield* localGates(invoker, document);
  return 'reasons' in gate
    ? ({ kind: 'STOP', reasons: gate.reasons } satisfies Loaded)
    : ({ document, kind: 'OPEN', pins: gate.open } satisfies Loaded);
});

/** Phase 1c (scoped, short): the one attempt of a message every gate cleared; the routine re-checks everything transactional. */
const beginAttempt = Effect.fn('Communications.beginAttempt')(function* begin(
  input: StepInput,
  invoker: ScopedRoutineInvoker,
  document: IntentDocument,
  cleared: Cleared,
) {
  const { intentId } = input;
  // the next attempt number: 1, or the one after an attempt that provably submitted nothing (NOT_ATTEMPTED)
  const attemptNumber = (document.attempt?.attemptNumber ?? 0) + 1;
  const attemptId = yield* attemptIdOf(intentId, attemptNumber);
  const begun = yield* invoker.invoke(workerBeginAttemptRoutine, [intentId, attemptId, attemptNumber]).pipe(
    Effect.mapError((cause) => storeUnavailable('The delivery attempt could not be recorded', cause)),
    Effect.flatMap((rows) => documentOf(rows, AttemptAnswerSchema, 'The delivery attempt answer was unreadable')),
  );
  if (begun.outcome === 'STALE') {
    // another caller moved the attempts on between the read and this call: Core delivers again and the step re-reads
    return yield* storeUnavailable('The delivery attempt number was stale');
  }
  if (begun.outcome !== 'BEGUN') {
    return skipped(intentId, notBegunReason(begun)) satisfies Prepared;
  }
  return {
    attemptId,
    kind: 'READY',
    message: {
      endpoint: cleared.endpoint,
      intentId,
      language: cleared.language.language,
      purpose: document.intent.purpose,
      recipientRef: cleared.recipientRef,
      template: cleared.language.pin,
      tenantId: input.tenantId,
    },
  } satisfies Prepared;
});

/** Phases 1b and 1c: ask the other owners with no connection held, then record the stop or the one attempt. */
const prepareHandoff = Effect.fn('Communications.prepareHandoff')(function* decide(
  input: StepInput,
  scoped: ScopedRunner,
  loaded: Loaded,
) {
  if (loaded.kind === 'SKIP') {
    return loaded.processing satisfies Prepared;
  }
  if (loaded.kind === 'STOP') {
    return (yield* scoped((invoker) => stopIntent(invoker, input.intentId, loaded.reasons))) satisfies Prepared;
  }
  const verdict = yield* ownerGates(loaded.document, loaded.pins);
  if ('reasons' in verdict) {
    return (yield* scoped((invoker) => stopIntent(invoker, input.intentId, verdict.reasons))) satisfies Prepared;
  }
  return (yield* scoped((invoker) =>
    beginAttempt(input, invoker, loaded.document, verdict.cleared),
  )) satisfies Prepared;
});

export const processIntentHandoff = Effect.fn('Communications.processIntentHandoff')(function* process(
  input: StepInput,
  scoped: ScopedRunner,
) {
  // Three short scoped transactions and one call that holds none: (1a) read the intent and run the local gates, then,
  // with NO connection held, (1b) ask the other owners, then (1c) record the stop or the attempt. The attempt is COMMITTED
  // before the provider is asked; phase 3 commits what the provider answered. A second caller, a stop or an attempt that
  // appeared between the phases is decided again by the routines, so nothing relies on the phases being atomic.
  const loaded = yield* scoped((invoker) => loadAndGate(input, invoker));
  const prepared = yield* prepareHandoff(input, scoped, loaded);
  if (prepared.kind !== 'READY') {
    return prepared;
  }
  const evidence = yield* callHandoff({ ...prepared.message, attemptId: prepared.attemptId });
  yield* scoped((invoker) =>
    invoker
      .invoke(workerFinishAttemptRoutine, [prepared.attemptId, finishState(evidence), { ...evidence.outcome }])
      .pipe(
        Effect.mapError((cause) => storeUnavailable('The provider evidence could not be recorded', cause)),
        Effect.flatMap((rows) =>
          documentOf(rows, FinishAnswerSchema, 'The delivery attempt finish answer was unreadable'),
        ),
      ),
  );
  return { evidence, intentId: input.intentId, kind: 'HANDED_OFF' } satisfies HandoffProcessing;
});

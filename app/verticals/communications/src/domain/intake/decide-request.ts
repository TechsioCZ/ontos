import type { CommunicationRequest } from '@app/communications-contracts/communication-request';
import { Array as EffectArray, DateTime, Effect, Option } from 'effect';

import { CommunicationDecisionUnavailable } from '../../../shared/communication-intake-errors.ts';
import { TemplateLegalEntityIdSchema } from '../../../shared/template-revision.ts';
import type { TemplateScope } from '../../../shared/template-revision.ts';
import { readLanguagePolicySnapshot } from '../../services/language-policy-domain.service.ts';
import type { LanguagePolicyPortContract } from '../../services/language-policy-port.service.ts';
import { decideMessageLanguageUnderPolicy } from '../../services/language-selection.service.ts';
import type { TemplateReadPortContract } from '../../services/template-revision-port.service.ts';
import { CommunicationOutcome, RecipientDecision } from '../catalog/decision.ts';
import type { MessageIntentCandidate } from '../catalog/decision.ts';
import { CommunicationDecisionService } from '../catalog/decision-service.ts';
import type {
  CommunicationDecisionRequest,
  RecipientFact,
  SourceOccurrenceFacts,
} from '../catalog/decision-request.ts';
import { ownerPermittedLanguagesOf, resendPolicyOf } from '../catalog/message-type.ts';
import type { TransactionalMessageType } from '../catalog/message-type.ts';
import { resourceRefKey, SourceStateKeySchema } from '../catalog/vocabulary.ts';
import type {
  CommunicationResourceRef,
  IntentStopReason,
  ResendRefusal,
  SourceUnresolvedReason,
} from '../catalog/vocabulary.ts';
import type { LanguagePolicySnapshot, NotSentReason, RecipientLanguageContext } from '../language/vocabulary.ts';
import { assessPrivacyEligibility, PrivacyAssessment, privacyEvidenceOf } from '../privacy/assess-privacy.ts';
import type { PrivacyAssessmentCase } from '../privacy/assess-privacy.ts';
import type { ProcessingScope } from '../privacy/processing-scope.ts';
import { scopeKey } from '../recipient/original-binding.ts';
import { assessRecipients, recipientFactOf } from '../recipient/assess-recipients.ts';
import type { EvaluatedRecipient } from '../recipient/assess-recipients.ts';
import { handoffPinOf } from '../recipient/recheck-before-handoff.ts';
import { RecipientAssessment } from '../recipient/recipient-assessment.ts';
import { resendRefusalOf } from '../recovery/resend-admission.ts';
import type { ResendOriginalPortContract } from '../recovery/resend-admission.ts';
import { decisionIdOf, intentIdOf, requestIdentityKeyOf, requestIdOf } from './identity.ts';
import { decodeIntakeInput } from './intake-input.ts';
import type { IntakeInput } from './intake-input.ts';
import { MessageTypeCatalog } from './message-type-catalog.ts';
import { intentKeyOf } from './plan.ts';
import type { DecisionPlan, EndpointPin, IntentPlan } from './plan.ts';
import { RecipientLanguageAuthority } from './recipient-language.ts';
import { safeCauseOf } from './safe-cause.ts';
import { ProcessingScopeDeclaration } from './scope-declaration.ts';
import { SourceOccurrenceAuthority } from './source-authority.ts';

/**
 * Decision orchestration (#1401): ONE committed source request in, a complete durable `DecisionPlan` out, composed only
 * from the lanes that already own each fact:
 * catalog (what may be sent) -> original recipients and their Current gate (who may be addressed) -> Privacy
 * Processing Eligibility (whether it may be processed) -> language and template pin (what the message is).
 * Pure composition: it writes nothing. The caller persists the plan or, on any failure, nothing at all, so a
 * request that could not be decided is simply decided later by the source's retry.
 */

const unavailable = (reason: string, cause?: unknown) =>
  Object.defineProperty(
    new CommunicationDecisionUnavailable({ code: 'communication_decision_unavailable', reason }),
    'cause',
    {
      enumerable: false,
      // REPLACED by its safe kind: a store or owner failure can carry the statement and its bound parameters
      value: cause === undefined ? undefined : safeCauseOf(cause),
    },
  );

/** Ports of the owner-local persistence that a decision reads, bound to the Action's own transaction. */
export interface DecisionStores {
  readonly policies: LanguagePolicyPortContract;
  /** The original intent of an Explicit Resend; read only for a request that names one, of a type that approves resend. */
  readonly resend: ResendOriginalPortContract;
  readonly templates: TemplateReadPortContract;
}

type DecisionStoresRequest = CommunicationRequest;

/** Concurrency of the owner calls of one request; it never limits how many recipients a request may have. */
const OWNER_CALL_CONCURRENCY = 8;

/**
 * A source that cannot be asked yet is not asked when no approved type of THIS source could ever use the answer
 * (unknown purpose, or another owner's type): the evaluator decides those before it reads the facts, so the facts only
 * have to echo the request. They are never stored.
 */
const echoFactsOf = (request: CommunicationDecisionRequest): SourceOccurrenceFacts => ({
  latestRevision: request.occurrence.revision,
  occurrenceId: request.occurrence.occurrenceId,
  state: SourceStateKeySchema.make('not-read'),
  tenantId: request.tenantId,
});

const ownedType = (type: Option.Option<TransactionalMessageType>, request: CommunicationDecisionRequest) =>
  type.pipe(Option.filter(({ sourceOwner }) => sourceOwner === request.source.moduleKey));

/**
 * Why an Explicit Resend request (#1403) produces no message: the approved type must carry the source owner's resend approval,
 * and only then is the original intent read. A request that names no original is never a resend. Nothing about another source's
 * intent, or an intent of a type without that approval, is read or revealed.
 */
const resendRefusalFor = Effect.fn('Communications.admitResend')(function* admit(
  request: DecisionStoresRequest,
  type: Option.Option<TransactionalMessageType>,
  stores: Pick<DecisionStores, 'resend'>,
) {
  if (request.resendOf === undefined || Option.isNone(type)) {
    return Option.none<ResendRefusal>();
  }
  const original =
    resendPolicyOf(type.value) === 'SOURCE_APPROVED'
      ? yield* stores.resend.findOriginal(request.resendOf.originalIntentId, {
          scopeKey: scopeKey(request.scope),
          sourceModule: request.source.moduleKey,
          typeId: type.value.typeId,
        })
      : Option.none();
  return resendRefusalOf(type.value, request.source.moduleKey, scopeKey(request.scope), original);
});

/**
 * The closed reason a source owner that ANSWERED NOTHING about the occurrence stands for (#1401 I-07: a missing source authority is
 * a truthful unresolved outcome). An owner that could not be ASKED at all is a different fact: it is not an answer, so no decision
 * is stored for it and the source's own retry asks again (see `readFacts`).
 */
const SOURCE_UNRESOLVED_REASON: SourceUnresolvedReason = 'SOURCE_OCCURRENCE_UNKNOWN';

interface SourceReading {
  readonly source: SourceOccurrenceFacts;
  /** Why the owner stated nothing (#1401 I-07); the facts then only echo the request and are never stored. */
  readonly unresolved: Option.Option<SourceUnresolvedReason>;
}

/**
 * The source owner's Current facts. An owner that cannot state them (an outage, a timeout, or no answer about the occurrence) is
 * not a retryable failure with nothing stored: no source authority means no legal Message Intent, so the request is decided as a
 * durable not-sent outcome with its closed reason (#1401 I-07, #1400 LC-05).
 */
const factsFor = Effect.fn('Communications.readSourceFacts')(function* readFacts(
  request: CommunicationDecisionRequest,
  type: Option.Option<TransactionalMessageType>,
) {
  if (Option.isNone(ownedType(type, request))) {
    return { source: echoFactsOf(request), unresolved: Option.none() } satisfies SourceReading;
  }
  const authority = yield* SourceOccurrenceAuthority;
  return yield* authority.read(request).pipe(
    Effect.map((source): SourceReading => ({ source, unresolved: Option.none() })),
    Effect.catchTag('SourceOccurrenceUnavailable', ({ reason }) =>
      // an outage is retryable and never a final decision: a REQUIRED security message must not be lost to a brief outage
      reason === 'OWNER_UNAVAILABLE'
        ? Effect.fail(unavailable('The source owner could not be asked now'))
        : Effect.succeed<SourceReading>({
            source: echoFactsOf(request),
            unresolved: Option.some(SOURCE_UNRESOLVED_REASON),
          }),
    ),
  );
});

interface AskedRecipient {
  readonly evaluated: EvaluatedRecipient;
  readonly privacy: PrivacyAssessmentCase;
  readonly scope: Option.Option<ProcessingScope>;
}

/**
 * Ask Privacy about ONE recipient's declared scope. A scope that no producer declared, or one for a purpose the approved
 * type does not name, is never sent to Privacy as if it were the type's: it is an unresolved Privacy context.
 */
const askPrivacy = Effect.fn('Communications.assessPrivacyForRecipient')(function* assessOne(
  input: IntakeInput,
  type: TransactionalMessageType,
  evaluated: EvaluatedRecipient,
) {
  const { binding, slotKey } = evaluated.assessment.subject;
  const declaration = yield* ProcessingScopeDeclaration;
  const declared = yield* declaration
    .declare({ binding, request: input.decisionRequest, slotKey, type })
    .pipe(Effect.option);
  const declaredPurposes = new Set(type.privacyPurposeRefs);
  const scope = declared.pipe(Option.filter(({ catalogPurposeRef }) => declaredPurposes.has(catalogPurposeRef)));
  const privacy = yield* Option.match(scope, {
    // no scope was declared, so there is none to key the stop by
    onNone: () =>
      DateTime.now.pipe(
        Effect.map((assessedAt) =>
          PrivacyAssessment.Unavailable({ assessedAt, reason: 'CONTEXT_AMBIGUOUS', scopeKey: '' }),
        ),
      ),
    onSome: (declaredScope) =>
      assessPrivacyEligibility({
        occurrence: input.decisionRequest.occurrence,
        recipient: { recipientRef: binding.recipientRef, role: binding.role },
        scope: declaredScope,
        sourceModule: input.decisionRequest.source.moduleKey,
        tenantId: input.decisionRequest.tenantId,
        typeId: type.typeId,
      }),
  });
  return { evaluated, privacy, scope } satisfies AskedRecipient;
});

/** The ambiguity the decision itself would find: an EXACTLY_ONE slot that has more than one distinct recipient of its role. */
const ambiguousRoles = (type: TransactionalMessageType, evaluated: readonly EvaluatedRecipient[]) => {
  const ambiguous = new Set<string>();
  const { result } = type;
  if (result.kind !== 'MESSAGE_INTENTS') {
    return ambiguous;
  }
  const recipientsByRole = new Map<string, Set<string>>();
  for (const { assessment } of evaluated) {
    const { recipientRef, role } = assessment.subject.binding;
    const recipients = recipientsByRole.get(role) ?? new Set<string>();
    recipientsByRole.set(role, recipients.add(resourceRefKey(recipientRef)));
  }
  for (const [role, recipients] of recipientsByRole) {
    const slots = result.slots.filter((slot) => slot.recipientRole === role);
    if (recipients.size > 1 && slots.length > 0 && slots.every((slot) => slot.cardinality === 'EXACTLY_ONE')) {
      ambiguous.add(role);
    }
  }
  return ambiguous;
};

/**
 * A recipient of an ambiguous slot is discarded by the decision whatever Privacy or its owner would say, so neither is asked
 * (#1401, T4-02). Its stop is the unresolved context it truly is, and the slot is reported as `RECIPIENT_AMBIGUOUS`.
 */
const discardedByAmbiguousSlot = Effect.fn('Communications.discardAmbiguousRecipient')(function* discard(
  evaluated: EvaluatedRecipient,
) {
  const assessedAt = yield* DateTime.now;
  return {
    evaluated,
    privacy: PrivacyAssessment.Unavailable({ assessedAt, reason: 'CONTEXT_AMBIGUOUS', scopeKey: '' }),
    scope: Option.none<ProcessingScope>(),
  } satisfies AskedRecipient;
});

const recipientKey = (slotKey: string, ref: CommunicationResourceRef) => `${slotKey}|${resourceRefKey(ref)}`;

const endpointPinOf = (evaluated: EvaluatedRecipient | undefined): Option.Option<EndpointPin> => {
  if (evaluated === undefined || !RecipientAssessment.$is('RecipientAllowed')(evaluated.assessment)) {
    return Option.none();
  }
  const { channel, contactRef, contactRevision, mask } = evaluated.assessment.endpoint;
  return Option.some(
    contactRevision === undefined ? { channel, contactRef, mask } : { channel, contactRef, contactRevision, mask },
  );
};

const templateScopeOf = ({ scope }: CommunicationRequest): TemplateScope =>
  scope.legalEntityId === undefined
    ? { kind: 'tenant' }
    : { kind: 'legal-entity', legalEntityId: TemplateLegalEntityIdSchema.make(scope.legalEntityId) };

/** The closed stop reason of each language `not-sent` reason; no text is derived from another by case. */
const LANGUAGE_STOP_REASON = {
  czech_revision_required_by_mode_b: 'CZECH_REVISION_REQUIRED_BY_MODE_B',
  czech_revision_unavailable: 'CZECH_REVISION_UNAVAILABLE',
  language_policy_unreadable: 'LANGUAGE_POLICY_UNREADABLE',
  owner_required_language_unavailable: 'OWNER_REQUIRED_LANGUAGE_UNAVAILABLE',
  template_revision_ambiguous: 'TEMPLATE_REVISION_AMBIGUOUS',
} as const satisfies Record<NotSentReason, IntentStopReason>;

interface Candidate {
  readonly asked: AskedRecipient | undefined;
  readonly candidate: MessageIntentCandidate;
  readonly language: RecipientLanguageContext | undefined;
}

const intentOf = Effect.fn('Communications.planIntent')(function* planIntent(
  input: IntakeInput,
  type: TransactionalMessageType,
  stores: DecisionStores,
  policy: Option.Option<LanguagePolicySnapshot>,
  { asked, candidate, language: recipientLanguage }: Candidate,
) {
  const { identity } = candidate;
  const intentKey = intentKeyOf(requestIdentityKeyOf(input.request), identity);
  const intentId = yield* intentIdOf(intentKey);
  const original =
    asked?.evaluated.assessment.subject.binding ??
    input.bindings.find(({ recipientRef }) => resourceRefKey(recipientRef) === resourceRefKey(identity.recipient));
  if (original === undefined) {
    return yield* unavailable('A candidate recipient has no original binding');
  }
  const base = {
    binding: original,
    endpoint: endpointPinOf(asked?.evaluated),
    handoffPin: handoffPinOf(type, original),
    identity,
    intentId,
    intentKey,
    purpose: candidate.purpose,
    role: candidate.recipient.role,
    scope: asked?.scope ?? Option.none<ProcessingScope>(),
  };
  const stopped = (reason: IntentStopReason): IntentPlan => ({
    ...base,
    language: Option.none(),
    reason: Option.some(reason),
    status: 'SUPPRESSED',
  });
  if (RecipientDecision.$is('Suppressed')(candidate.recipient)) {
    return stopped(candidate.recipient.reason);
  }
  if (Option.isNone(base.endpoint)) {
    return stopped('RECIPIENT_BASIS_MISSING');
  }
  if (Option.isNone(policy)) {
    // the Tenant mode is read for every eligible candidate, so a missing one is a stop of its own, never a missing recipient basis
    return stopped('LANGUAGE_POLICY_UNREADABLE');
  }
  if (base.endpoint.value.channel !== 'email') {
    return stopped('CHANNEL_NOT_SUPPORTED');
  }
  if (recipientLanguage === undefined) {
    return yield* unavailable('An eligible recipient has no prepared language authority');
  }
  const language = yield* decideMessageLanguageUnderPolicy(stores.templates, policy.value, {
    base: { channel: 'email', messageType: type.typeId, scope: templateScopeOf(input.request) },
    // The type's own owner declaration: the one language it requires, else both, where the choice is Communications'.
    ownerPermittedLanguages: ownerPermittedLanguagesOf(type),
    // The trusted language comes from its owner authority only; with none published it is not established.
    recipient: recipientLanguage,
  }).pipe(
    // A template store that cannot be read is not "no template": nothing is decided on a guess, the source retries.
    Effect.catchTag('TemplateStoreUnavailable', (cause) =>
      Effect.fail(unavailable('The approved template revisions could not be read', cause)),
    ),
  );
  return language.outcome === 'selected'
    ? ({
        ...base,
        language: Option.some(language),
        reason: Option.none(),
        status: 'PENDING_HANDOFF',
      } satisfies IntentPlan)
    : ({
        ...base,
        language: Option.some(language),
        reason: Option.some(LANGUAGE_STOP_REASON[language.reason]),
        status: 'NOT_SENT',
      } satisfies IntentPlan);
});

const eligibleCandidatesOf = (candidates: readonly MessageIntentCandidate[]) =>
  candidates.filter(({ recipient }) => RecipientDecision.$is('Eligible')(recipient));

/** Read resend admission before asking remote owners; the committing transaction reads it again. */
export const prepareResendAdmission = Effect.fn('Communications.prepareResendAdmission')(function* prepareAdmission(
  request: CommunicationRequest,
  resend: ResendOriginalPortContract,
) {
  const input = yield* decodeIntakeInput(request);
  const catalog = yield* MessageTypeCatalog;
  return yield* resendRefusalFor(
    request,
    ownedType(catalog.byPurpose(input.decisionRequest.purpose), input.decisionRequest),
    { resend },
  );
});

/**
 * Gather source, recipient, Privacy and language authority outside SQL after the resend admission snapshot.
 * Resend eligibility is rechecked alongside owner-local settings in the committing transaction; these facts contain no transaction-bound service.
 */
export const prepareRequest = Effect.fn('Communications.prepareRequest')(function* prepareRequestOf(
  request: CommunicationRequest,
  resendRefusal: Option.Option<ResendRefusal>,
) {
  const [input, requestId] = yield* Effect.all([decodeIntakeInput(request), requestIdOf(request)], {
    concurrency: 2,
  });
  const decisionId = yield* decisionIdOf(requestId);
  const catalog = yield* MessageTypeCatalog;
  const evaluator = yield* CommunicationDecisionService;
  const typeOption = catalog.byPurpose(input.decisionRequest.purpose);
  const reading = yield* factsFor(input.decisionRequest, typeOption);
  const { source } = reading;
  const evaluate = (recipients: readonly RecipientFact[]) =>
    evaluator
      .decide(input.decisionRequest, {
        recipients,
        source,
        ...Option.match(resendRefusal, { onNone: () => ({}), onSome: (refusal) => ({ resendRefusal: refusal }) }),
        ...Option.match(reading.unresolved, {
          onNone: () => ({}),
          onSome: (sourceUnresolved) => ({ sourceUnresolved }),
        }),
      })
      .pipe(
        Effect.mapError((mismatch) => unavailable('Facts of another occurrence or tenant were supplied', mismatch)),
      );
  // A probe without recipients: everything the catalog and the source decide alone (unknown purpose, switched-off type,
  // ineligible state or revision, approved zero-message rule) ends here, and no owner is asked about a recipient.
  const probe = yield* evaluate([]);
  const type = ownedType(typeOption, input.decisionRequest);
  const needsRecipients =
    CommunicationOutcome.$is('NoMessage')(probe.outcome) && probe.outcome.reason === 'RECIPIENT_AUTHORITY_MISSING';
  if (!needsRecipients || Option.isNone(type)) {
    return { asked: [], decisionId, input, languages: [], reading, requestId, resendRefusal, typeOption };
  }
  const evaluatedRecipients = yield* assessRecipients({
    bindings: input.bindings,
    request: input.decisionRequest,
    scope: input.scope,
    type: type.value,
  });
  const ambiguous = ambiguousRoles(type.value, evaluatedRecipients);
  const asked = yield* Effect.forEach(
    evaluatedRecipients,
    (evaluated) =>
      ambiguous.has(evaluated.assessment.subject.binding.role)
        ? discardedByAmbiguousSlot(evaluated)
        : askPrivacy(input, type.value, evaluated),
    { concurrency: OWNER_CALL_CONCURRENCY },
  );
  const decision = yield* evaluate(
    asked.map(({ evaluated, privacy }) =>
      recipientFactOf(evaluated.assessment, input.decisionRequest, privacyEvidenceOf(privacy)),
    ),
  );
  const eligible = CommunicationOutcome.$match(decision.outcome, {
    Candidates: ({ candidates }) => eligibleCandidatesOf(candidates),
    NoMessage: (): readonly MessageIntentCandidate[] => [],
  });
  const languages = yield* Effect.forEach(
    asked.filter(({ evaluated }) =>
      eligible.some(
        ({ identity }) =>
          recipientKey(identity.slotKey, identity.recipient) ===
          recipientKey(evaluated.assessment.subject.slotKey, evaluated.assessment.subject.binding.recipientRef),
      ),
    ),
    Effect.fn('Communications.prepareRecipientLanguage')(function* recipientLanguage({ evaluated }: AskedRecipient) {
      const { binding } = evaluated.assessment.subject;
      const language = yield* (yield* RecipientLanguageAuthority).languageOf(binding);
      return {
        key: recipientKey(evaluated.assessment.subject.slotKey, binding.recipientRef),
        language,
      };
    }),
    { concurrency: OWNER_CALL_CONCURRENCY },
  );
  return { asked, decisionId, input, languages, reading, requestId, resendRefusal, typeOption };
});

export type PreparedRequest = Effect.Success<ReturnType<typeof prepareRequest>>;

/** Only owner-local reads remain: resend, language policy and active templates use the committing transaction. */
export const decidePreparedRequest = Effect.fn('Communications.decidePreparedRequest')(function* decidePrepared(
  prepared: PreparedRequest,
  stores: DecisionStores,
) {
  const { asked, decisionId, input, languages, reading, requestId, typeOption } = prepared;
  const { request } = input;
  const evaluator = yield* CommunicationDecisionService;
  const resendRefusal = yield* resendRefusalFor(request, ownedType(typeOption, input.decisionRequest), stores);
  const evaluate = (recipients: readonly RecipientFact[]) =>
    evaluator
      .decide(input.decisionRequest, {
        recipients,
        source: reading.source,
        ...Option.match(resendRefusal, { onNone: () => ({}), onSome: (refusal) => ({ resendRefusal: refusal }) }),
        ...Option.match(reading.unresolved, {
          onNone: () => ({}),
          onSome: (sourceUnresolved) => ({ sourceUnresolved }),
        }),
      })
      .pipe(
        Effect.mapError((mismatch) => unavailable('Facts of another occurrence or tenant were supplied', mismatch)),
      );
  const probe = yield* evaluate([]);
  const type = ownedType(typeOption, input.decisionRequest);
  if (
    !CommunicationOutcome.$is('NoMessage')(probe.outcome) ||
    probe.outcome.reason !== 'RECIPIENT_AUTHORITY_MISSING' ||
    Option.isNone(type)
  ) {
    return {
      decision: probe,
      decisionId,
      intents: [],
      languagePolicy: Option.none(),
      request,
      requestId,
    } satisfies DecisionPlan;
  }
  if (Option.isSome(prepared.resendRefusal) && Option.isNone(resendRefusal)) {
    return yield* unavailable('Resend admission changed; retry preparation to obtain recipient and Privacy facts');
  }
  const decision = yield* evaluate(
    asked.map(({ evaluated, privacy }) =>
      recipientFactOf(evaluated.assessment, input.decisionRequest, privacyEvidenceOf(privacy)),
    ),
  );
  const candidates = CommunicationOutcome.$match(decision.outcome, {
    Candidates: (found) => found.candidates,
    NoMessage: (): readonly MessageIntentCandidate[] => [],
  });
  // The Tenant mode is read ONCE for the whole request, in its own sub-transaction, so every intent of it is decided
  // under the same mode and an unreadable setting stops the messages without aborting the intake transaction.
  const policy = EffectArray.isReadonlyArrayNonEmpty(eligibleCandidatesOf(candidates))
    ? Option.some(yield* readLanguagePolicySnapshot(stores.policies))
    : Option.none<LanguagePolicySnapshot>();
  const intents = yield* Effect.forEach(
    candidates,
    (candidate) =>
      intentOf(input, type.value, stores, policy, {
        asked: asked.find(
          ({ evaluated: { assessment } }) =>
            recipientKey(assessment.subject.slotKey, assessment.subject.binding.recipientRef) ===
            recipientKey(candidate.identity.slotKey, candidate.identity.recipient),
        ),
        candidate,
        language: languages.find(
          ({ key }) => key === recipientKey(candidate.identity.slotKey, candidate.identity.recipient),
        )?.language,
      }),
    { concurrency: 1 },
  );
  return { decision, decisionId, intents, languagePolicy: policy, request, requestId } satisfies DecisionPlan;
});

/** A non-transactional decision entrypoint for callers that already own their persistence boundary. */
export const decideRequest = Effect.fn('Communications.decideRequest')(function* decideRequestOf(
  request: CommunicationRequest,
  stores: DecisionStores,
) {
  return yield* decidePreparedRequest(
    yield* prepareRequest(request, yield* prepareResendAdmission(request, stores.resend)),
    stores,
  );
});

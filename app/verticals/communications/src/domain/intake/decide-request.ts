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
import type { TransactionalMessageType } from '../catalog/message-type.ts';
import { resourceRefKey, SourceStateKeySchema } from '../catalog/vocabulary.ts';
import type { CommunicationResourceRef } from '../catalog/vocabulary.ts';
import type { LanguagePolicySnapshot } from '../language/vocabulary.ts';
import { assessPrivacyEligibility, PrivacyAssessment, privacyEvidenceOf } from '../privacy/assess-privacy.ts';
import type { PrivacyAssessmentCase } from '../privacy/assess-privacy.ts';
import type { ProcessingScope } from '../privacy/processing-scope.ts';
import { assessRecipients, recipientFactOf } from '../recipient/assess-recipients.ts';
import type { EvaluatedRecipient } from '../recipient/assess-recipients.ts';
import { handoffPinOf } from '../recipient/recheck-before-handoff.ts';
import { RecipientAssessment } from '../recipient/recipient-assessment.ts';
import { decisionIdOf, intentIdOf, requestIdOf } from './identity.ts';
import { decodeIntakeInput } from './intake-input.ts';
import type { IntakeInput } from './intake-input.ts';
import { MessageTypeCatalog } from './message-type-catalog.ts';
import { intentKeyOf } from './plan.ts';
import type { DecisionPlan, EndpointPin, IntentPlan } from './plan.ts';
import { RecipientLanguageAuthority } from './recipient-language.ts';
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
      value: cause,
    },
  );

/** Ports of the owner-local persistence that a decision reads, bound to the Action's own transaction. */
export interface DecisionStores {
  readonly policies: LanguagePolicyPortContract;
  readonly templates: TemplateReadPortContract;
}

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

const factsFor = Effect.fn('Communications.readSourceFacts')(function* readFacts(
  request: CommunicationDecisionRequest,
  type: Option.Option<TransactionalMessageType>,
) {
  if (Option.isNone(ownedType(type, request))) {
    return echoFactsOf(request);
  }
  const authority = yield* SourceOccurrenceAuthority;
  return yield* authority
    .read(request)
    .pipe(
      Effect.mapError((failure) =>
        unavailable(`The source owner could not state the current occurrence (${failure.reason})`, failure),
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

interface Candidate {
  readonly asked: AskedRecipient | undefined;
  readonly candidate: MessageIntentCandidate;
}

const intentOf = Effect.fn('Communications.planIntent')(function* planIntent(
  input: IntakeInput,
  type: TransactionalMessageType,
  stores: DecisionStores,
  policy: Option.Option<LanguagePolicySnapshot>,
  { asked, candidate }: Candidate,
) {
  const { identity } = candidate;
  const intentKey = intentKeyOf(identity);
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
  const suppressed = (reason: string): IntentPlan => ({
    ...base,
    language: Option.none(),
    reason: Option.some(reason),
    status: 'SUPPRESSED',
  });
  if (RecipientDecision.$is('Suppressed')(candidate.recipient)) {
    return suppressed(candidate.recipient.reason);
  }
  if (Option.isNone(base.endpoint) || Option.isNone(policy)) {
    return suppressed('RECIPIENT_BASIS_MISSING');
  }
  if (base.endpoint.value.channel !== 'email') {
    return suppressed('CHANNEL_NOT_SUPPORTED');
  }
  const recipientLanguage = yield* (yield* RecipientLanguageAuthority).languageOf(original);
  const language = yield* decideMessageLanguageUnderPolicy(stores.templates, policy.value, {
    base: { channel: 'email', messageType: type.typeId, scope: templateScopeOf(input.request) },
    // Both languages are permitted for every approved type until an owner declares one; the choice is Communications'.
    ownerPermittedLanguages: ['cs', 'en'],
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
        reason: Option.some(language.reason.toUpperCase()),
        status: 'NOT_SENT',
      } satisfies IntentPlan);
});

const eligibleCandidatesOf = (candidates: readonly MessageIntentCandidate[]) =>
  candidates.filter(({ recipient }) => RecipientDecision.$is('Eligible')(recipient));

/**
 * Decide one request. Fails only with `CommunicationDecisionUnavailable` (a fact that cannot be established now, or a
 * store failure surfaced as the same retryable fact); an unreachable recipient or Privacy owner is NOT such a failure
 * but a recorded, reasoned stop of the one concrete message it concerns.
 */
export const decideRequest = Effect.fn('Communications.decideRequest')(function* decideRequestOf(
  request: CommunicationRequest,
  stores: DecisionStores,
) {
  const [input, requestId] = yield* Effect.all([decodeIntakeInput(request), requestIdOf(request)], {
    concurrency: 2,
  });
  const decisionId = yield* decisionIdOf(requestId);
  const catalog = yield* MessageTypeCatalog;
  const evaluator = yield* CommunicationDecisionService;
  const typeOption = catalog.byPurpose(input.decisionRequest.purpose);
  const source = yield* factsFor(input.decisionRequest, typeOption);
  const evaluate = (recipients: readonly RecipientFact[]) =>
    evaluator
      .decide(input.decisionRequest, { recipients, source })
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
    return {
      decision: probe,
      decisionId,
      intents: [],
      languagePolicy: Option.none(),
      request,
      requestId,
    } satisfies DecisionPlan;
  }
  const evaluatedRecipients = yield* assessRecipients({
    bindings: input.bindings,
    request: input.decisionRequest,
    scope: input.scope,
    type: type.value,
  });
  const asked = yield* Effect.forEach(evaluatedRecipients, (evaluated) => askPrivacy(input, type.value, evaluated), {
    concurrency: OWNER_CALL_CONCURRENCY,
  });
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
      }),
    { concurrency: 1 },
  );
  return { decision, decisionId, intents, languagePolicy: policy, request, requestId } satisfies DecisionPlan;
});

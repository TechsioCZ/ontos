import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { DateTime, Duration, Effect, Schema } from 'effect';
import { randomUUID } from 'node:crypto';

import {
  AssortmentCommitmentConfirmationExpired,
  AssortmentCommitmentConfirmationInvalid,
  AssortmentCommitmentConfirmationPayloadSchema,
  AssortmentCommitmentConfirmationResultSchema,
  AssortmentCommitmentConfirmationScopeMismatch,
  AssortmentCommitmentConfirmationUnavailable,
  commitmentConfirmationRef,
  assortmentCommitmentConfirmationMatchesExactScope,
  isAssortmentCommitmentConfirmationValidAt,
} from '../../shared/domain/commitment-confirmation.ts';
import type {
  AssortmentCommitmentConfirmationError,
  AssortmentCommitmentConfirmationIssuer,
  AssortmentCommitmentConfirmationPayload,
  AssortmentCommitmentConfirmationResult,
} from '../../shared/domain/commitment-confirmation.ts';
import {
  AssortmentSuccessfulAttemptDecisionEvidenceSchema,
  constructAssortmentSuccessfulAttemptEvidence,
} from '../../shared/domain/decision-evidence.ts';
import type { AssortmentSuccessfulAttemptDecisionEvidence } from '../../shared/domain/decision-evidence.ts';
import {
  AssortmentOrdinaryResolutionInputSchema,
  AssortmentOrdinaryResolutionSchema,
  resolveAssortmentOrdinary,
} from '../../shared/domain/ordinary-resolution.ts';
import type {
  AssortmentOrdinaryResolution,
  AssortmentOrdinaryResolutionInput,
} from '../../shared/domain/ordinary-resolution.ts';
import {
  AssortmentCandidateSchema,
  AssortmentCatalogSelectionSchema,
  AssortmentDecisionSubjectSchema,
  AssortmentEvidenceReferenceSchema,
  AssortmentFactCurrentnessEvidenceSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchaseConstituentSchema,
  AssortmentSetCompletenessEvidenceSchema,
  AssortmentTrustedCommerceContextSchema,
} from '../../shared/domain/decision-contracts.ts';
import type { AssortmentDecisionEvidence } from '../../shared/domain/decision-contracts.ts';
import { assortmentCommitmentConfirmationRepositoryForScope } from './assortment-commitment-confirmation.repository.ts';

const candidateEquivalence = Schema.toEquivalence(AssortmentCandidateSchema);
const candidateListEquivalence = Schema.toEquivalence(Schema.Array(AssortmentCandidateSchema));
const constituentEquivalence = Schema.toEquivalence(AssortmentPurchaseConstituentSchema);
const selectionEquivalence = Schema.toEquivalence(AssortmentCatalogSelectionSchema);
const subjectEquivalence = Schema.toEquivalence(AssortmentDecisionSubjectSchema);
const trustedContextEquivalence = Schema.toEquivalence(AssortmentTrustedCommerceContextSchema);
const completenessEquivalence = Schema.toEquivalence(AssortmentSetCompletenessEvidenceSchema);
const currentnessEquivalence = Schema.toEquivalence(AssortmentFactCurrentnessEvidenceSchema);
const ownerRefEquivalence = Schema.toEquivalence(AssortmentOwnerResourceRefSchema);
const evidenceRefEquivalence = Schema.toEquivalence(AssortmentEvidenceReferenceSchema);
const MAX_VALIDITY_MILLIS = 30_000;

// Keep the owner-local persistence capability behind the generated Action's
// transaction-scoped service factory without leaking a global DB capability.
type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export interface AssortmentCommitmentConfirmationEvaluationPort {
  readonly evaluate: (
    payload: AssortmentCommitmentConfirmationPayload,
    scope: OperationalScope,
    now: DateTime.Utc,
  ) => Effect.Effect<AssortmentCommitmentConfirmationEvaluation, AssortmentCommitmentConfirmationError>;
}

type AssortmentCommitmentConfirmationEvaluation = Readonly<{
  readonly attemptEvidence: AssortmentSuccessfulAttemptDecisionEvidence;
  readonly attemptRef: AssortmentCommitmentConfirmationPayload['attemptRef'];
  readonly candidate: AssortmentCommitmentConfirmationPayload['candidate'];
  readonly constituent: AssortmentCommitmentConfirmationPayload['constituent'];
  readonly decisionEvidenceRef: AssortmentCommitmentConfirmationPayload['decisionEvidenceRef'];
  readonly ordinaryInput: AssortmentOrdinaryResolutionInput;
  readonly prospectivePurchaseMeaningRef: AssortmentCommitmentConfirmationPayload['prospectivePurchaseMeaningRef'];
}>;

export interface AssortmentCommitmentConfirmationRepository {
  readonly persist: (
    payload: AssortmentCommitmentConfirmationPayload,
    result: AssortmentCommitmentConfirmationResult,
    scope: OperationalScope,
    metadata: AssortmentCommitmentConfirmationPersistenceMetadata,
  ) => Effect.Effect<AssortmentCommitmentConfirmationResult, AssortmentCommitmentConfirmationError>;
}

export interface AssortmentCommitmentConfirmationPersistenceMetadata {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
}

const unavailableEvaluation: AssortmentCommitmentConfirmationEvaluationPort = {
  evaluate: () =>
    Effect.fail(
      new AssortmentCommitmentConfirmationUnavailable({
        code: 'assortment_confirmation_unavailable',
        reason: 'Current positive Assortment purchase evidence is unavailable',
      }),
    ),
};

const unavailableRepository: AssortmentCommitmentConfirmationRepository = {
  persist: () =>
    Effect.fail(
      new AssortmentCommitmentConfirmationUnavailable({
        code: 'assortment_confirmation_unavailable',
        reason: 'Assortment Commitment Confirmation persistence is unavailable',
      }),
    ),
};

const scopeMatches = (payload: AssortmentCommitmentConfirmationPayload, scope: OperationalScope): boolean =>
  payload.attemptRef.tenantId === scope.tenantId &&
  payload.prospectivePurchaseMeaningRef.tenantId === scope.tenantId &&
  payload.constituent.catalogSelection.productRef.tenantId === scope.tenantId &&
  payload.decisionEvidenceRef.evidenceRef.tenantId === scope.tenantId &&
  payload.candidate.commercialScope.sellingLegalEntityRef.tenantId === scope.tenantId &&
  payload.candidate.commercialScope.sellingLegalEntityRef.resourceId === scope.legalEntityId;

const invalid = (reason: string, cause?: unknown) => {
  const failure = new AssortmentCommitmentConfirmationInvalid({ code: 'assortment_confirmation_invalid', reason });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const INCOMPLETE_EVIDENCE_REASON = 'Current positive purchase evidence is not complete and authoritative';

const evaluationCarriesRequiredEvidence = (evaluated: AssortmentCommitmentConfirmationEvaluation): boolean =>
  Schema.is(AssortmentSuccessfulAttemptDecisionEvidenceSchema)(evaluated.attemptEvidence) &&
  Schema.is(AssortmentOrdinaryResolutionInputSchema)(evaluated.ordinaryInput) &&
  Schema.is(AssortmentOwnerResourceRefSchema)(evaluated.attemptRef) &&
  Schema.is(AssortmentOwnerResourceRefSchema)(evaluated.prospectivePurchaseMeaningRef) &&
  Schema.is(AssortmentEvidenceReferenceSchema)(evaluated.decisionEvidenceRef);

const exactEvaluationMatchesScope = (
  evaluated: AssortmentCommitmentConfirmationEvaluation,
  constructedEvidence: AssortmentSuccessfulAttemptDecisionEvidence,
  payload: AssortmentCommitmentConfirmationPayload,
  scope: OperationalScope,
  now: DateTime.Utc,
): boolean => {
  const { ordinaryInput } = evaluated;
  const { decision, request } = constructedEvidence;
  const { evidence } = decision;
  return (
    decision.outcome === 'ELIGIBLE' &&
    request.decisionPurpose === 'PURCHASE' &&
    constituentEquivalence(request.constituent, payload.constituent) &&
    ordinaryInput.tenantId === scope.tenantId &&
    ordinaryInput.decisionPurpose === 'PURCHASE' &&
    ordinaryInput.target.kind === 'CATALOG_SELECTION' &&
    selectionEquivalence(ordinaryInput.target.selection, payload.constituent.catalogSelection) &&
    subjectEquivalence(ordinaryInput.subject, request.subject) &&
    trustedContextEquivalence(ordinaryInput.trustedContext, request.trustedContext) &&
    request.trustedContext.tenantId === scope.tenantId &&
    request.trustedContext.sellingLegalEntityRef.resourceId === scope.legalEntityId &&
    request.trustedContext.sellingLegalEntityRef.tenantId === scope.tenantId &&
    evidence.target.kind === 'CATALOG_SELECTION' &&
    ownerRefEquivalence(evaluated.attemptRef, payload.attemptRef) &&
    ownerRefEquivalence(evaluated.prospectivePurchaseMeaningRef, payload.prospectivePurchaseMeaningRef) &&
    evidenceRefEquivalence(evaluated.decisionEvidenceRef, payload.decisionEvidenceRef) &&
    DateTime.toEpochMillis(ordinaryInput.trustedContext.operationTime) === DateTime.toEpochMillis(now) &&
    DateTime.toEpochMillis(evidence.operationTime) === DateTime.toEpochMillis(now)
  );
};

const ordinaryEvidenceIsAuthoritative = (
  ordinaryResolution: AssortmentOrdinaryResolution,
  decisionEvidence: AssortmentDecisionEvidence,
): boolean => {
  if (
    !Schema.is(AssortmentOrdinaryResolutionSchema)(ordinaryResolution) ||
    ordinaryResolution.kind !== 'RESOLVED' ||
    ordinaryResolution.outcome !== 'ELIGIBLE' ||
    ordinaryResolution.evidence.completeness.state !== 'COMPLETE' ||
    ordinaryResolution.evidence.factCurrentness.some((item) => item.state !== 'CURRENT') ||
    ordinaryResolution.evidence.maximalCandidates.length === 0 ||
    ordinaryResolution.evidence.maximalCandidates.some((candidate) => candidate.effect !== 'ALLOW') ||
    decisionEvidence.candidates === undefined
  ) {
    return false;
  }
  return (
    candidateListEquivalence(decisionEvidence.candidates, ordinaryResolution.evidence.candidates) &&
    decisionEvidence.setCompleteness.some((evidence) =>
      completenessEquivalence(evidence, ordinaryResolution.evidence.completeness),
    ) &&
    ordinaryResolution.evidence.factCurrentness.every((currentness) =>
      decisionEvidence.factCurrentness.some((evidence) => currentnessEquivalence(evidence, currentness)),
    )
  );
};

const selectedCandidateIsMaximal = (
  ordinaryResolution: AssortmentOrdinaryResolution,
  evaluated: AssortmentCommitmentConfirmationEvaluation,
  payload: AssortmentCommitmentConfirmationPayload,
): boolean =>
  ordinaryResolution.kind === 'RESOLVED' &&
  ordinaryResolution.evidence.maximalCandidates.some((candidate) =>
    candidateEquivalence(candidate, payload.candidate),
  ) &&
  candidateEquivalence(evaluated.candidate, payload.candidate) &&
  constituentEquivalence(evaluated.constituent, payload.constituent);

export const validateAssortmentCommitmentConfirmation = (
  confirmation: AssortmentCommitmentConfirmationResult,
  expected: AssortmentCommitmentConfirmationPayload,
  at: DateTime.Utc,
): Effect.Effect<AssortmentCommitmentConfirmationResult, AssortmentCommitmentConfirmationError> => {
  if (!Schema.is(AssortmentCommitmentConfirmationResultSchema)(confirmation)) {
    return Effect.fail(invalid('The Confirmation instance is structurally invalid'));
  }
  if (DateTime.toEpochMillis(at) < DateTime.toEpochMillis(confirmation.issuedAt)) {
    return Effect.fail(invalid('The Confirmation has not been issued yet'));
  }
  if (!isAssortmentCommitmentConfirmationValidAt(confirmation, at)) {
    return Effect.fail(
      new AssortmentCommitmentConfirmationExpired({
        code: 'assortment_confirmation_expired',
        reason: 'The Confirmation validity interval has ended',
      }),
    );
  }
  return assortmentCommitmentConfirmationMatchesExactScope(confirmation, expected, at)
    ? Effect.succeed(confirmation)
    : Effect.fail(
        new AssortmentCommitmentConfirmationScopeMismatch({
          code: 'assortment_confirmation_scope_mismatch',
          reason: 'The Confirmation does not match the exact Attempt scope',
        }),
      );
};

const issue = Effect.fn('AssortmentCommitmentConfirmationService.issue')(function* issueConfirmation(
  payload: AssortmentCommitmentConfirmationPayload,
  scope: OperationalScope,
  now: DateTime.Utc,
  evaluation: AssortmentCommitmentConfirmationEvaluationPort,
  repository: AssortmentCommitmentConfirmationRepository,
  metadata: AssortmentCommitmentConfirmationPersistenceMetadata,
) {
  if (!Schema.is(AssortmentCommitmentConfirmationPayloadSchema)(payload)) {
    return yield* invalid('The Confirmation payload is structurally invalid');
  }
  if (scope.legalEntityId === undefined || !scopeMatches(payload, scope)) {
    return yield* new AssortmentCommitmentConfirmationScopeMismatch({
      code: 'assortment_confirmation_scope_mismatch',
      reason: 'The Confirmation payload is outside the trusted tenant or legal-entity scope',
    });
  }
  const evaluated = yield* evaluation.evaluate(payload, scope, now);
  if (!evaluationCarriesRequiredEvidence(evaluated)) {
    return yield* invalid(INCOMPLETE_EVIDENCE_REASON);
  }
  const constructedEvidence = yield* constructAssortmentSuccessfulAttemptEvidence(evaluated.attemptEvidence).pipe(
    Effect.mapError((cause) => invalid(INCOMPLETE_EVIDENCE_REASON, cause)),
  );
  const ordinaryResolution = resolveAssortmentOrdinary(evaluated.ordinaryInput);
  const decisionEvidence = constructedEvidence.decision.evidence;
  if (!exactEvaluationMatchesScope(evaluated, constructedEvidence, payload, scope, now)) {
    return yield* invalid('Current positive purchase evidence does not match the exact Confirmation scope');
  }
  if (!ordinaryEvidenceIsAuthoritative(ordinaryResolution, decisionEvidence)) {
    return yield* invalid(INCOMPLETE_EVIDENCE_REASON);
  }
  if (!selectedCandidateIsMaximal(ordinaryResolution, evaluated, payload)) {
    return yield* invalid('The caller-selected Candidate is not the final maximal ALLOW Candidate');
  }
  const issuedAt = now;
  const expiresAt = DateTime.addDuration(issuedAt, Duration.millis(MAX_VALIDITY_MILLIS));
  const result = yield* Schema.decodeEffect(AssortmentCommitmentConfirmationResultSchema)({
    attemptRef: payload.attemptRef,
    candidate: payload.candidate,
    confirmationRef: commitmentConfirmationRef(scope.tenantId, randomUUID()),
    constituent: payload.constituent,
    decisionEvidenceRef: payload.decisionEvidenceRef,
    expiresAt: DateTime.formatIso(expiresAt),
    issuedAt: DateTime.formatIso(issuedAt),
    prospectivePurchaseMeaningRef: payload.prospectivePurchaseMeaningRef,
  }).pipe(Effect.mapError((cause) => invalid('Confirmation contract validation failed', cause)));
  return yield* repository.persist(payload, result, scope, metadata);
});

export const makeAssortmentCommitmentConfirmationService = (
  scope: OperationalScope,
  evaluation: AssortmentCommitmentConfirmationEvaluationPort = unavailableEvaluation,
  repository: AssortmentCommitmentConfirmationRepository = unavailableRepository,
): AssortmentCommitmentConfirmationIssuer => ({
  issue: Effect.fn('AssortmentCommitmentConfirmationService.issueWithClock')(
    function* issueWithClock(payload, metadata) {
      const now = yield* DateTime.now;
      return yield* issue(payload, scope, now, evaluation, repository, metadata);
    },
  ),
});

export const assortmentCommitmentConfirmationServiceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
) =>
  makeAssortmentCommitmentConfirmationService(
    scope,
    unavailableEvaluation,
    assortmentCommitmentConfirmationRepositoryForScope(transaction, scope),
  );

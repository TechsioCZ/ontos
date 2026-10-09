import type { AssortmentPermissionAccessTarget, OperationalScope } from '@app/core-runtime';
import { DateTime, Effect, Schema } from 'effect';
import type {
  AssortmentDecisionEvidence,
  AssortmentDecisionRequest,
  AssortmentDecisionSubject,
  AssortmentOwnerResourceRef,
} from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentCatalogSelectionSchema,
  AssortmentDecisionRequestSchema,
  AssortmentDecisionSubjectSchema,
  AssortmentTrustedCommerceContextSchema,
  AssortmentOwnerResourceRefSchema,
} from '../../shared/domain/decision-contracts.ts';
import type {
  AssortmentDecisionExplanationRequest,
  AssortmentDecisionExplanationResponse,
} from '../../shared/domain/governed-read-contracts.ts';
import { AssortmentPolicyTargetInvariant } from '../../shared/domain/policy-errors.ts';
import type { AssortmentPolicyPersistenceUnavailable } from '../../shared/domain/policy-errors.ts';
import { assortmentMeaningFingerprint } from './policy-administration.service.ts';
import { toCommercialScopeTarget, toResourceAccessTarget } from '../actions/policy-administration-support.ts';

type Failure =
  | InstanceType<typeof AssortmentPolicyPersistenceUnavailable>
  | InstanceType<typeof AssortmentPolicyTargetInvariant>;
export type AssortmentStoredDecisionEvidence = Readonly<{
  readonly evidence: AssortmentDecisionEvidence;
  readonly outcome: 'ELIGIBLE' | 'INELIGIBLE' | 'INDETERMINATE';
  readonly request: AssortmentDecisionRequest;
}>;
export interface AssortmentDecisionEvidenceResolver {
  readonly resolve: (
    reference: AssortmentOwnerResourceRef,
    scope: OperationalScope,
  ) => Effect.Effect<AssortmentStoredDecisionEvidence, Failure>;
}

const requestEquivalent = Schema.toEquivalence(AssortmentDecisionRequestSchema);
const subjectEquivalent = Schema.toEquivalence(AssortmentDecisionSubjectSchema);
const contextEquivalent = Schema.toEquivalence(AssortmentTrustedCommerceContextSchema);
const selectionEquivalent = Schema.toEquivalence(AssortmentCatalogSelectionSchema);
const resourceEquivalent = Schema.toEquivalence(AssortmentOwnerResourceRefSchema);
const invalid = (reason: string): Failure => new AssortmentPolicyTargetInvariant({ reason });
const subjectRef = (subject: AssortmentDecisionSubject): AssortmentOwnerResourceRef => {
  if (subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    return subject.guestEvidence.evidenceRef;
  }
  return subject.subject.kind === 'COUNTERPARTY' ? subject.subject.counterpartyRef : subject.subject.profileRef;
};
const requestTarget = (request: AssortmentDecisionRequest) =>
  request.decisionPurpose === 'VISIBILITY'
    ? { kind: 'PRODUCT' as const, productRef: request.productRef }
    : { kind: 'CATALOG_SELECTION' as const, selection: request.constituent.catalogSelection };
const requestFingerprint = (request: AssortmentDecisionRequest): string => {
  const normalized = {
    ...request,
    trustedContext: {
      ...request.trustedContext,
      operationTime: DateTime.formatIso(request.trustedContext.operationTime),
    },
  };
  return assortmentMeaningFingerprint(normalized);
};
const requestInScope = (request: AssortmentDecisionRequest, scope: OperationalScope): boolean => {
  const refs: readonly AssortmentOwnerResourceRef[] = [
    request.trustedContext.channelRef,
    request.trustedContext.sellingLegalEntityRef,
    subjectRef(request.subject),
    ...(request.trustedContext.commerceMarketRef === undefined ? [] : [request.trustedContext.commerceMarketRef]),
    ...(request.trustedContext.storefrontRef === undefined ? [] : [request.trustedContext.storefrontRef]),
  ];
  return (
    request.trustedContext.tenantId === scope.tenantId &&
    request.trustedContext.sellingLegalEntityRef.resourceId === scope.legalEntityId &&
    (scope.trustedStorefrontId === undefined ||
      request.trustedContext.storefrontRef?.resourceId === scope.trustedStorefrontId) &&
    refs.every((ref) => ref.tenantId === scope.tenantId) &&
    (request.principalRef === undefined ||
      (request.principalRef.tenantId === scope.tenantId && request.principalRef.principalId === scope.principalId))
  );
};

export const isExactDecisionEvidence = (
  request: AssortmentDecisionRequest,
  evidence: AssortmentDecisionEvidence,
): boolean => {
  const targetMatches =
    evidence.target.kind === 'PRODUCT'
      ? request.decisionPurpose === 'VISIBILITY' && resourceEquivalent(request.productRef, evidence.target.productRef)
      : request.decisionPurpose === 'PURCHASE' &&
        selectionEquivalent(request.constituent.catalogSelection, evidence.target.selection);
  return (
    contextEquivalent(request.trustedContext, evidence.trustedContext) &&
    subjectEquivalent(request.subject, evidence.subject) &&
    DateTime.formatIso(request.trustedContext.operationTime) === DateTime.formatIso(evidence.operationTime) &&
    targetMatches
  );
};

export const assortmentDecisionExplanationReadService = (
  scope: OperationalScope,
  resolveEvidence: AssortmentDecisionEvidenceResolver['resolve'],
) => {
  const explain = Effect.fn('AssortmentDecisionExplanationReadService.explain')(function* explainDecision(
    input: AssortmentDecisionExplanationRequest,
  ): Effect.fn.Return<AssortmentDecisionExplanationResponse, Failure> {
    if (!requestInScope(input.request, scope)) {
      return yield* invalid('Decision explanation request is outside the trusted tenant or legal-entity scope');
    }
    if (
      input.evidenceRef.evidenceRef.tenantId !== scope.tenantId ||
      input.evidenceRef.evidenceRef.moduleId !== 'commerce.assortment' ||
      input.evidenceRef.evidenceRef.resourceType !== 'commerce.assortment.decision-evidence'
    ) {
      return yield* invalid('Decision explanation evidence reference is not owned by this tenant and module');
    }
    const stored = yield* resolveEvidence(input.evidenceRef.evidenceRef, scope);
    if (!requestEquivalent(input.request, stored.request) || !isExactDecisionEvidence(input.request, stored.evidence)) {
      return yield* invalid('Decision explanation evidence does not belong to the exact request');
    }
    if (!isExactDecisionEvidence(stored.request, stored.evidence)) {
      return yield* invalid('Stored decision evidence failed exact request binding');
    }
    return {
      evidence: stored.evidence,
      outcome: stored.outcome,
      requestFingerprint: requestFingerprint(input.request),
    };
  });
  return { explain };
};

export const decisionExplanationPermissionTarget = (
  request: AssortmentDecisionRequest,
  scope: OperationalScope,
): Extract<AssortmentPermissionAccessTarget, { readonly kind: 'assortment_decision' }> => {
  if (!requestInScope(request, scope)) {
    throw invalid('Decision explanation permission target is outside the trusted scope');
  }
  const target = requestTarget(request);
  const catalogSelection = target.kind === 'PRODUCT' ? target.productRef : target.selection.variantRef;
  const subject = subjectRef(request.subject);
  let permissionSubject;
  if (request.subject.kind === 'GUEST_PURCHASE_CONTEXT') {
    permissionSubject = { kind: 'GUEST' as const };
  } else if (request.subject.subject.kind === 'COUNTERPARTY') {
    permissionSubject = { kind: 'COUNTERPARTY' as const, ref: toResourceAccessTarget(subject) };
  } else {
    permissionSubject = { kind: 'RETAIL_CUSTOMER_PROFILE' as const, ref: toResourceAccessTarget(subject) };
  }
  return {
    catalogSelection: toResourceAccessTarget(catalogSelection),
    commercialScope: toCommercialScopeTarget(request.trustedContext),
    kind: 'assortment_decision' as const,
    permission: 'assortment.decision.explain' as const,
    purpose: request.decisionPurpose,
    subject: permissionSubject,
  };
};

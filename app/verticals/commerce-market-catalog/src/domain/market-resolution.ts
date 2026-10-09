import type { OwnerVerifiableSetCompletenessEvidence } from '@app/shared-contracts';
import type { DateTime } from 'effect';

import type {
  EligibleMarketTuple,
  EligibleMarketTupleSet,
  MarketLifecycle,
  MarketResolutionOutcome,
  SafeSubjectRestrictionEvidenceSchema,
} from '../../shared/market-contracts.ts';
import type { ResolveCommerceMarketRequest } from '../../shared/apis/resolve-commerce-market.ts';

type SafeSubjectRestrictionEvidence = typeof SafeSubjectRestrictionEvidenceSchema.Type;

export interface MarketEligibilityFact {
  readonly lifecycle: MarketLifecycle;
  readonly tuple: EligibleMarketTuple;
}

export interface MarketEligibilitySnapshot {
  readonly completenessEvidence: OwnerVerifiableSetCompletenessEvidence;
  readonly effectiveAt: DateTime.Utc;
  readonly evaluatedAt: DateTime.Utc;
  readonly facts: readonly MarketEligibilityFact[];
  readonly nextApplicabilityBoundary?: DateTime.Utc;
  readonly subjectRestrictionStatus?: 'ALLOWED' | 'DENIED';
}

export interface MarketResolutionInput {
  readonly request: ResolveCommerceMarketRequest;
  readonly snapshot: MarketEligibilitySnapshot;
  readonly subjectRestrictionEvidence?: SafeSubjectRestrictionEvidence;
}

const sameRef = (
  left: Readonly<{ readonly resourceId: string; readonly tenantId: string }>,
  right: Readonly<{ readonly resourceId: string; readonly tenantId: string }>,
): boolean => left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const sameMaterialTuple = (left: EligibleMarketTuple, right: EligibleMarketTuple): boolean =>
  left.channel === right.channel &&
  sameRef(left.marketRef, right.marketRef) &&
  sameRef(left.sellingLegalEntityRef, right.sellingLegalEntityRef);

const tupleKey = ({ channel, marketRef, sellingLegalEntityRef }: EligibleMarketTuple): string =>
  `${sellingLegalEntityRef.tenantId}\u0000${sellingLegalEntityRef.resourceId}\u0000${marketRef.resourceId}\u0000${channel}`;

const candidateMatches = (
  tuple: EligibleMarketTuple,
  candidate: NonNullable<ResolveCommerceMarketRequest['explicitSelection']>,
): boolean =>
  sameRef(tuple.marketRef, candidate.marketRef) &&
  sameRef(tuple.sellingLegalEntityRef, candidate.sellingLegalEntityRef);

const failure = (
  outcome:
    | 'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT'
    | 'MARKET_NOT_ACTIVE'
    | 'MARKET_NOT_ALLOWED_FOR_STOREFRONT'
    | 'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL',
  reason: string,
): MarketResolutionOutcome => ({ outcome, reason });

const eligibleFacts = (
  request: Pick<ResolveCommerceMarketRequest, 'channel' | 'sellingLegalEntityRestriction'>,
  snapshot: MarketEligibilitySnapshot,
): readonly MarketEligibilityFact[] =>
  snapshot.subjectRestrictionStatus === 'DENIED'
    ? []
    : snapshot.facts.filter(
        ({ lifecycle, tuple }) =>
          lifecycle === 'ACTIVE' &&
          tuple.channel === request.channel &&
          (request.sellingLegalEntityRestriction === undefined ||
            sameRef(tuple.sellingLegalEntityRef, request.sellingLegalEntityRestriction)),
      );

const duplicateMaterialTuple = (facts: readonly MarketEligibilityFact[]): boolean => {
  const keys = facts.map(({ tuple }) => tupleKey(tuple));
  return new Set(keys).size !== keys.length;
};

export const discoverEligibleMarketTuples = (
  request: Pick<ResolveCommerceMarketRequest, 'channel' | 'sellingLegalEntityRestriction'>,
  snapshot: MarketEligibilitySnapshot,
): EligibleMarketTupleSet => {
  const tuples = eligibleFacts(request, snapshot).map(({ tuple }) => tuple);
  const result = {
    completenessEvidence: snapshot.completenessEvidence,
    effectiveAt: snapshot.effectiveAt,
    evaluatedAt: snapshot.evaluatedAt,
    outcome: 'ELIGIBLE_MARKET_TUPLES',
    tuples,
  } as const;
  return snapshot.nextApplicabilityBoundary === undefined
    ? result
    : { ...result, nextApplicabilityBoundary: snapshot.nextApplicabilityBoundary };
};

const invalidCandidateOutcome = (
  request: ResolveCommerceMarketRequest,
  snapshot: MarketEligibilitySnapshot,
  candidate: NonNullable<ResolveCommerceMarketRequest['explicitSelection']>,
  source: 'BOOTSTRAP_DEFAULT' | 'EXPLICIT',
): MarketResolutionOutcome => {
  const candidateFacts = snapshot.facts.filter(({ tuple }) => candidateMatches(tuple, candidate));
  if (candidateFacts.length === 0) {
    return source === 'EXPLICIT'
      ? failure(
          'MARKET_NOT_ALLOWED_FOR_STOREFRONT',
          'The explicitly selected Market is not associated with the trusted Storefront',
        )
      : failure(
          'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT',
          'The configured bootstrap Market is not associated with the trusted Storefront',
        );
  }
  if (
    request.sellingLegalEntityRestriction !== undefined &&
    !sameRef(candidate.sellingLegalEntityRef, request.sellingLegalEntityRestriction)
  ) {
    return failure(
      'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL',
      'The selected Market is outside the trusted subject seller restriction',
    );
  }
  if (candidateFacts.every(({ tuple }) => tuple.channel !== request.channel)) {
    return failure(
      'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL',
      'The selected Market is not available for the requested Channel',
    );
  }
  if (candidateFacts.some(({ lifecycle }) => lifecycle !== 'ACTIVE')) {
    return failure('MARKET_NOT_ACTIVE', 'The selected Market is not Active at the evaluation time');
  }
  return failure(
    'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT',
    'The selected Market cannot be established from one complete Current association',
  );
};

const resolved = (
  tuple: EligibleMarketTuple,
  source: 'BOOTSTRAP_DEFAULT' | 'EXPLICIT' | 'SOLE_ELIGIBLE',
  snapshot: MarketEligibilitySnapshot,
  bootstrapPolicyRevision: string | undefined,
  subjectRestrictionEvidence: SafeSubjectRestrictionEvidence | undefined,
): MarketResolutionOutcome => {
  const base = {
    associationRevision: tuple.associationRevision,
    completenessEvidence: snapshot.completenessEvidence,
    effectiveAt: snapshot.effectiveAt,
    evaluatedAt: snapshot.evaluatedAt,
    marketDefinitionRevisionRef: tuple.marketDefinitionRevisionRef,
    outcome: 'MARKET_RESOLVED' as const,
    selectedTuple: tuple,
    selectionSource: source,
  };
  const withBoundary =
    snapshot.nextApplicabilityBoundary === undefined
      ? base
      : { ...base, nextApplicabilityBoundary: snapshot.nextApplicabilityBoundary };
  const withBootstrap =
    bootstrapPolicyRevision === undefined ? withBoundary : { ...withBoundary, bootstrapPolicyRevision };
  return subjectRestrictionEvidence === undefined ? withBootstrap : { ...withBootstrap, subjectRestrictionEvidence };
};

export const resolveCommerceMarket = ({
  request,
  snapshot,
  subjectRestrictionEvidence,
}: MarketResolutionInput): MarketResolutionOutcome => {
  if (snapshot.subjectRestrictionStatus === 'DENIED') {
    return failure(
      'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL',
      'The purchasing subject is not currently eligible for the requested Market or Channel',
    );
  }
  const eligible = eligibleFacts(request, snapshot);
  if (duplicateMaterialTuple(eligible)) {
    return failure(
      'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT',
      'More than one Current association describes the same seller, Market, and Channel tuple',
    );
  }

  const candidate = request.explicitSelection ?? request.bootstrapDefault;
  if (candidate !== undefined) {
    const match = eligible.find(({ tuple }) => candidateMatches(tuple, candidate));
    if (match === undefined) {
      return invalidCandidateOutcome(
        request,
        snapshot,
        candidate,
        request.explicitSelection === undefined ? 'BOOTSTRAP_DEFAULT' : 'EXPLICIT',
      );
    }
    return resolved(
      match.tuple,
      request.explicitSelection === undefined ? 'BOOTSTRAP_DEFAULT' : 'EXPLICIT',
      snapshot,
      request.explicitSelection === undefined ? request.bootstrapDefault?.policyRevision : undefined,
      subjectRestrictionEvidence,
    );
  }

  if (eligible.length === 0) {
    if (request.subject !== undefined && request.subject.kind !== 'GUEST') {
      return failure(
        'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL',
        'No Current Market association satisfies the owner-issued purchasing-subject restrictions',
      );
    }
    return failure(
      'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT',
      'No Current eligible Market association exists for the trusted Storefront and Channel',
    );
  }
  if (eligible.length === 1) {
    const [only] = eligible;
    return only === undefined
      ? failure(
          'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT',
          'The eligible Market set changed while it was being evaluated',
        )
      : resolved(only.tuple, 'SOLE_ELIGIBLE', snapshot, undefined, subjectRestrictionEvidence);
  }
  const choices = eligible.map(({ tuple }) => tuple);
  if (choices.some((choice, index) => choices.slice(index + 1).some((other) => sameMaterialTuple(choice, other)))) {
    return failure(
      'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT',
      'Eligible Market choices are not materially distinct',
    );
  }
  const result = {
    choices,
    completenessEvidence: snapshot.completenessEvidence,
    effectiveAt: snapshot.effectiveAt,
    evaluatedAt: snapshot.evaluatedAt,
    outcome: 'MARKET_SELECTION_REQUIRED' as const,
  };
  return snapshot.nextApplicabilityBoundary === undefined
    ? result
    : { ...result, nextApplicabilityBoundary: snapshot.nextApplicabilityBoundary };
};

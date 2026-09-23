import {
  EligibleMarketTuplesResponseSchema,
  ResolveCommerceMarketRequestSchema,
  ResolveCommerceMarketResponseSchema,
} from '@app/commerce-market-catalog/api/client';
import type {
  EligibleMarketTuplesResponse,
  ResolveCommerceMarketRequest,
  ResolveCommerceMarketResponse,
} from '@app/commerce-market-catalog/api/client';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { DateTime, Option, Schema } from 'effect';

import type { MarketBootstrapPolicyBatchCurrentResponse } from './customer-commerce-policy-administration.ts';
import {
  CustomerCommercePolicyRevisionIdSchema,
  CustomerCommercePolicySellingLegalEntityIdSchema,
} from './customer-commerce-policy.ts';

const marketRequestFields = ResolveCommerceMarketRequestSchema.fields;

/** Caller input. The trusted observed time is supplied by the governed Read. */
export const MarketBootstrapResolutionRequestSchema = Schema.Struct({
  channel: marketRequestFields.channel,
  explicitSelection: marketRequestFields.explicitSelection,
  sellingLegalEntityRestriction: marketRequestFields.sellingLegalEntityRestriction,
  storefrontRef: marketRequestFields.storefrontRef,
  subject: marketRequestFields.subject,
})
  .check(
    Schema.makeFilter(({ explicitSelection, sellingLegalEntityRestriction, storefrontRef }) => {
      if (
        explicitSelection !== undefined &&
        (explicitSelection.marketRef.tenantId !== storefrontRef.tenantId ||
          explicitSelection.sellingLegalEntityRef.tenantId !== storefrontRef.tenantId)
      ) {
        return 'Explicit Market selection and Storefront must belong to the same Tenant';
      }
      return sellingLegalEntityRestriction === undefined ||
        sellingLegalEntityRestriction.tenantId === storefrontRef.tenantId
        ? undefined
        : 'Seller restriction and Storefront must belong to the same Tenant';
    }),
  )
  .annotate({ parseOptions: { onExcessProperty: 'error' } });
export type MarketBootstrapResolutionRequest = typeof MarketBootstrapResolutionRequestSchema.Type;

const BootstrapPolicyStatusSchema = Schema.Literals([
  'APPLIED',
  'MISSING',
  'NOT_EVALUATED_EXPLICIT',
  'NOT_EVALUATED_NO_ELIGIBLE_SELLER',
  'NOT_EVALUATED_MARKET_UNAVAILABLE',
  'INCONSISTENT',
  'BROKEN',
  'UNVERIFIABLE',
]);

const BootstrapPolicyPartitionEvidenceSchema = Schema.Struct({
  completeness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  policyRevisionIds: Schema.Array(CustomerCommercePolicyRevisionIdSchema),
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const MarketBootstrapPolicyResolutionEvidenceSchema = Schema.Struct({
  evaluatedAt: Schema.DateTimeUtcFromString,
  partitions: Schema.Array(BootstrapPolicyPartitionEvidenceSchema),
  selectedPolicyRevisionId: Schema.optionalKey(CustomerCommercePolicyRevisionIdSchema),
  status: BootstrapPolicyStatusSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type MarketBootstrapPolicyResolutionEvidence = typeof MarketBootstrapPolicyResolutionEvidenceSchema.Type;

export const MarketBootstrapResolutionOutcomeSchema = Schema.Struct({
  eligibleMarketResponse: EligibleMarketTuplesResponseSchema,
  evaluatedAt: Schema.DateTimeUtcFromString,
  marketResolution: ResolveCommerceMarketResponseSchema,
  nextApplicabilityBoundary: Schema.optionalKey(Schema.DateTimeUtcFromString),
  policyEvidence: MarketBootstrapPolicyResolutionEvidenceSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
type MarketBootstrapResolutionOutcome = typeof MarketBootstrapResolutionOutcomeSchema.Type;

type CompleteEligibleResponse = Extract<EligibleMarketTuplesResponse, { readonly outcome: 'ELIGIBLE_MARKET_TUPLES' }>;
type PolicySeller = MarketBootstrapPolicyBatchCurrentResponse['sellers'][number];
type PolicyCandidate = PolicySeller['candidates'][number];
type EvaluationInstant = MarketBootstrapResolutionOutcome['evaluatedAt'];

export type MarketBootstrapPolicyDecision =
  | {
      readonly defaultSelection: NonNullable<ResolveCommerceMarketRequest['bootstrapDefault']>;
      readonly evidence: MarketBootstrapPolicyResolutionEvidence;
      readonly kind: 'DEFAULT';
    }
  | {
      readonly evidence: MarketBootstrapPolicyResolutionEvidence;
      readonly kind: 'NONE';
    }
  | {
      readonly evidence: MarketBootstrapPolicyResolutionEvidence;
      readonly kind: 'BROKEN' | 'CONFLICT';
      readonly reason: string;
    };

const scopeRank = (scope: PolicyCandidate['scope']): 1 | 2 | 3 => {
  if (scope.kind === 'STOREFRONT_CHANNEL_SELLER') {
    return 3;
  }
  return scope.kind === 'CHANNEL_SELLER' ? 2 : 1;
};

const scopeMatches = (scope: PolicyCandidate['scope'], request: MarketBootstrapResolutionRequest): boolean => {
  if (scope.kind === 'SELLER') {
    return true;
  }
  if (scope.channelId !== request.channel) {
    return false;
  }
  return scope.kind === 'CHANNEL_SELLER' || scope.storefrontId === request.storefrontRef.appId;
};

const tupleMatchesDefault = (tuple: CompleteEligibleResponse['tuples'][number], candidate: PolicyCandidate): boolean =>
  tuple.channel === candidate.defaultTuple.channelId &&
  tuple.marketRef.resourceId === candidate.defaultTuple.commerceMarketId &&
  tuple.sellingLegalEntityRef.resourceId === candidate.defaultTuple.sellingLegalEntityId;

const policyEvidence = (
  policy: MarketBootstrapPolicyBatchCurrentResponse,
  evaluatedAt: EvaluationInstant,
  status: MarketBootstrapPolicyResolutionEvidence['status'],
  selectedPolicyRevisionId?: string,
): MarketBootstrapPolicyResolutionEvidence => {
  const base = {
    evaluatedAt,
    partitions: policy.sellers.map((seller) => ({
      completeness: seller.completeness,
      policyRevisionIds: seller.candidates.map(({ policyRevisionId }) => policyRevisionId),
      sellingLegalEntityId: seller.sellingLegalEntityId,
    })),
    status,
  };
  return selectedPolicyRevisionId === undefined ? base : { ...base, selectedPolicyRevisionId };
};

/** Resolves only the Market-free policy rank. Market eligibility remains owner-owned. */
export const resolveMarketBootstrapPolicy = (
  request: MarketBootstrapResolutionRequest,
  eligible: CompleteEligibleResponse,
  policy: MarketBootstrapPolicyBatchCurrentResponse,
  evaluatedAt: EvaluationInstant,
): MarketBootstrapPolicyDecision => {
  const applicable = policy.sellers.flatMap(({ candidates }) =>
    candidates.filter(({ scope }) => scopeMatches(scope, request)),
  );
  if (applicable.length === 0) {
    return { evidence: policyEvidence(policy, evaluatedAt, 'MISSING'), kind: 'NONE' };
  }

  const highestRank = Math.max(...applicable.map(({ scope }) => scopeRank(scope)));
  const winners = applicable.filter(({ scope }) => scopeRank(scope) === highestRank);
  const [winner] = winners;
  if (winners.length !== 1 || winner === undefined) {
    return {
      evidence: policyEvidence(policy, evaluatedAt, 'INCONSISTENT'),
      kind: 'CONFLICT',
      reason: 'Current Market bootstrap policy has more than one candidate at the highest applicable rank',
    };
  }

  const tuple = eligible.tuples.find((candidate) => tupleMatchesDefault(candidate, winner));
  if (tuple === undefined) {
    return {
      evidence: policyEvidence(policy, evaluatedAt, 'BROKEN', winner.policyRevisionId),
      kind: 'BROKEN',
      reason: 'The configured bootstrap Market tuple is not in the complete eligible Market set',
    };
  }

  return {
    defaultSelection: {
      marketRef: tuple.marketRef,
      policyRevision: winner.policyRevisionId,
      sellingLegalEntityRef: tuple.sellingLegalEntityRef,
    },
    evidence: policyEvidence(policy, evaluatedAt, 'APPLIED', winner.policyRevisionId),
    kind: 'DEFAULT',
  };
};

const decodeValidatedUtc = (value: string): DateTime.Utc => Option.getOrThrow(DateTime.make(value));

export const earliestMarketBootstrapBoundary = (
  eligible: EligibleMarketTuplesResponse,
  market: ResolveCommerceMarketResponse,
  policy: MarketBootstrapPolicyResolutionEvidence,
): DateTime.Utc | undefined => {
  const boundaries: DateTime.Utc[] = [];
  if (eligible.outcome === 'ELIGIBLE_MARKET_TUPLES' && eligible.nextApplicabilityBoundary !== undefined) {
    boundaries.push(eligible.nextApplicabilityBoundary);
  }
  if (
    (market.outcome === 'MARKET_RESOLVED' || market.outcome === 'MARKET_SELECTION_REQUIRED') &&
    market.nextApplicabilityBoundary !== undefined
  ) {
    boundaries.push(market.nextApplicabilityBoundary);
  }
  for (const partition of policy.partitions) {
    if (partition.completeness.nextApplicabilityBoundary !== undefined) {
      boundaries.push(decodeValidatedUtc(partition.completeness.nextApplicabilityBoundary));
    }
  }
  return boundaries.toSorted((left, right) => DateTime.toEpochMillis(left) - DateTime.toEpochMillis(right))[0];
};

export const marketBootstrapConfigurationFailure = (reason: string): ResolveCommerceMarketResponse => ({
  outcome: 'MARKET_CONFIGURATION_MISSING_OR_INCONSISTENT',
  reason,
});

export const marketBootstrapDependencyUnavailable = (reason: string): ResolveCommerceMarketResponse => ({
  outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
  reason,
  retryable: true,
});

export const marketBootstrapPolicyEvidenceWithoutPartitions = (
  evaluatedAt: EvaluationInstant,
  status:
    | 'NOT_EVALUATED_EXPLICIT'
    | 'NOT_EVALUATED_MARKET_UNAVAILABLE'
    | 'NOT_EVALUATED_NO_ELIGIBLE_SELLER'
    | 'UNVERIFIABLE',
): MarketBootstrapPolicyResolutionEvidence => ({ evaluatedAt, partitions: [], status });

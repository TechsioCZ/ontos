import type { Effect } from 'effect';
import type { OperationalScope } from '@app/core-runtime';
import type { MarketRetirementStoredBasis } from '../../shared/market-retirement-admission.ts';
import type { RetireMarketPayload } from '../../shared/action-contracts.ts';
import { Context } from 'effect';

import type {
  MarketRetirementImpactAssessment,
  ReservedMarketRetirementImpactAssessment,
} from '../../shared/domain/market-retirement-impact.ts';
import type { MarketRef } from '../../shared/resources/market.ts';
import type { MarketRetirementImpactAssessmentRejected } from '../actions/market-retirement-impact-assessment-rejected.ts';
import type { MarketRetirementImpactAssessmentStale } from '../actions/market-retirement-impact-assessment-stale.ts';
import type { MarketRetirementImpactAssessmentUnavailable } from '../actions/market-retirement-impact-assessment-unavailable.ts';

type MarketRetirementImpactFailure =
  | MarketRetirementImpactAssessmentRejected
  | MarketRetirementImpactAssessmentStale
  | MarketRetirementImpactAssessmentUnavailable;

export interface MarketRetirementImpactAuthority<Requirements = never> {
  readonly assessRetirementImpact: (input: {
    readonly actionInvocationId: string;
    readonly compositionRevision: string;
    readonly effectiveAt: string;
    readonly expectedMarketRevision: number;
    readonly legalEntityId: string;
    readonly marketRef: MarketRef;
  }) => Effect.Effect<MarketRetirementImpactAssessment, MarketRetirementImpactFailure, Requirements>;
  readonly commitRetirementImpact: (input: {
    readonly actionInvocationId: string;
    readonly assessment: ReservedMarketRetirementImpactAssessment;
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly reason: string;
  }) => Effect.Effect<void, MarketRetirementImpactFailure, Requirements>;
  readonly releaseRetirementImpact: (input: {
    readonly actionInvocationId: string;
    readonly assessment: ReservedMarketRetirementImpactAssessment;
    readonly compositionRevision: string;
    readonly legalEntityId: string;
    readonly reason: string;
  }) => Effect.Effect<void, MarketRetirementImpactFailure, Requirements>;
  readonly reserveRetirementImpact: (input: {
    readonly actionInvocationId: string;
    readonly compositionRevision: string;
    readonly effectiveAt: string;
    readonly expectedMarketRevision: number;
    readonly legalEntityId: string;
    readonly marketRef: MarketRef;
    readonly reason: string;
  }) => Effect.Effect<ReservedMarketRetirementImpactAssessment, MarketRetirementImpactFailure, Requirements>;
}

export interface MarketRetirementImpactAttempt {
  readonly basis: MarketRetirementStoredBasis;
  readonly compositionRevision: string;
  readonly originalCompositionRevision: string;
  readonly releaseGuardHash: string;
  readonly retirement: RetireMarketPayload;
  readonly scope: OperationalScope;
  readonly sourceActionInvocationId: string;
}
export interface MarketRetirementImpactFactory {
  readonly forAdmission: (attempt: MarketRetirementImpactAttempt) => MarketRetirementImpactAuthority & {
    readonly cleanupOriginal: (releaseProof: string) => Effect.Effect<void, MarketRetirementImpactFailure>;
  };

  readonly prepareBasis: (
    attempt: Pick<
      MarketRetirementImpactAttempt,
      'scope' | 'compositionRevision' | 'retirement' | 'sourceActionInvocationId'
    >,
  ) => Effect.Effect<MarketRetirementStoredBasis, MarketRetirementImpactFailure>;
}
export class MarketRetirementImpactAuthorityFactory extends Context.Service<
  MarketRetirementImpactAuthorityFactory,
  MarketRetirementImpactFactory
>()(
  '@app/commerce-market-catalog/services/market-retirement-impact-authority/MarketRetirementImpactAuthorityFactory',
) {}

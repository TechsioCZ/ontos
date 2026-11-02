import type { ReserveMarketRetirementPayload } from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import type { DateTime, Effect } from 'effect';
import { Context } from 'effect';

import type {
  MarketRetirementImpactAssessment,
  ReservedMarketRetirementImpactAssessment,
} from '../../shared/domain/market-retirement-impact.ts';
import type { MarketRef } from '../../shared/resources/market.ts';
import type { MarketRetirementImpactFailure } from '../domain/market-retirement-workflow.ts';

/** Exact owner-call context. Each call obtains its own audience-scoped gateway assertion. */
export interface MarketRetirementOwnerCallContext {
  readonly compositionRevision: string;
  readonly legalEntityId: string;
  readonly requestCorrelation: string;
}

export type MarketRetirementReserveRequest = Extract<ReserveMarketRetirementPayload, { readonly operation: 'RESERVE' }>;

export interface PreparedMarketRetirementReservation {
  readonly assessment: MarketRetirementImpactAssessment;
  /** RESERVE request persisted before it is sent, so every replay is byte-identical. */
  readonly reservationRequest: MarketRetirementReserveRequest;
}

/**
 * Customer Context retirement-impact authority as seen by the Market owner worker. Every operation is one
 * remote call (plus its own recovery read) and must run outside any SQL transaction.
 */
export interface MarketRetirementImpactAuthority<Requirements = never> {
  /** COMMIT is idempotent per key; `action_already_committed` for the same key proves the commit. */
  readonly commitRetirementImpact: (
    input: MarketRetirementOwnerCallContext & {
      readonly assessment: ReservedMarketRetirementImpactAssessment;
      readonly idempotencyKey: string;
      readonly reason: string;
    },
  ) => Effect.Effect<void, MarketRetirementImpactFailure, Requirements>;
  /** Reads current affected-use evidence and derives the exact RESERVE request; it reserves nothing. */
  readonly prepareRetirementReservation: (
    input: MarketRetirementOwnerCallContext & {
      readonly effectiveAt: DateTime.Utc;
      readonly expectedMarketRevision: number;
      readonly marketRef: MarketRef;
      readonly reason: string;
    },
  ) => Effect.Effect<PreparedMarketRetirementReservation, MarketRetirementImpactFailure, Requirements>;
  /** RELEASE of a never-committed reservation; idempotent per key like COMMIT. */
  readonly releaseRetirementImpact: (
    input: MarketRetirementOwnerCallContext & {
      readonly assessment: ReservedMarketRetirementImpactAssessment;
      readonly idempotencyKey: string;
      readonly reason: string;
    },
  ) => Effect.Effect<void, MarketRetirementImpactFailure, Requirements>;
  /**
   * Sends the persisted RESERVE request. A replay whose key already committed recovers the reservation through
   * Customer Context's exact reservation read instead of reserving again.
   */
  readonly reserveRetirementImpact: (
    input: MarketRetirementOwnerCallContext & {
      readonly assessment: MarketRetirementImpactAssessment;
      readonly idempotencyKey: string;
      readonly reservationRequest: MarketRetirementReserveRequest;
    },
  ) => Effect.Effect<ReservedMarketRetirementImpactAssessment, MarketRetirementImpactFailure, Requirements>;
}

export class MarketRetirementImpactAuthorityService extends Context.Service<
  MarketRetirementImpactAuthorityService,
  MarketRetirementImpactAuthority
>()(
  '@app/commerce-market-catalog/services/market-retirement-impact-authority/MarketRetirementImpactAuthorityService',
) {}

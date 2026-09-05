import { Context } from 'effect';
import type { Effect } from 'effect';
import type { CounterpartyRef } from '../resources/counterparty.ts';
import type { PartyRef } from '../resources/party.ts';
import type { CurrentCounterpartyRole, SearchLegalEntityContext } from './search-result.ts';
import type { PartySearchProjectionUnavailable } from './search-projection-error.ts';

export interface PartySearchProjectionQuery {
  readonly includeArchived: boolean;
  readonly query: string;
  readonly tenantId: string;
}

export interface CounterpartySearchProjectionQuery extends PartySearchProjectionQuery {
  readonly effectiveAt: string;
  readonly legalEntityId: string;
  readonly role?: CurrentCounterpartyRole;
}

export interface PartySearchProjectionHit {
  readonly archived: boolean;
  readonly canonicalPartyRef: PartyRef;
  readonly matchedPartyRef?: PartyRef;
  readonly title: string;
}

export interface CounterpartyRoleProjectionPeriod {
  readonly role: CurrentCounterpartyRole;
  readonly validFrom: string;
  readonly validTo?: string;
}

export interface CounterpartySearchProjectionHit {
  readonly canonicalPartyRef: PartyRef;
  readonly counterpartyRef: CounterpartyRef;
  readonly legalEntity: SearchLegalEntityContext;
  readonly matchedPartyRef?: PartyRef;
  readonly partyArchived: boolean;
  readonly partyTitle: string;
  readonly rolePeriods: readonly CounterpartyRoleProjectionPeriod[];
}

export interface PartySearchProjectionGatewayService {
  readonly searchCounterparties: (
    input: CounterpartySearchProjectionQuery,
  ) => Effect.Effect<readonly CounterpartySearchProjectionHit[], PartySearchProjectionUnavailable>;
  readonly searchParties: (
    input: PartySearchProjectionQuery,
  ) => Effect.Effect<readonly PartySearchProjectionHit[], PartySearchProjectionUnavailable>;
}

/**
 * Owner-facing port implemented by OntOS Core Search. Party Registry supplies business semantics;
 * the implementation supplies only the rebuildable, eventually-consistent projection/query runtime.
 */
export class PartySearchProjectionGateway extends Context.Service<
  PartySearchProjectionGateway,
  PartySearchProjectionGatewayService
>()('@app/party-registry/shared/domain/search-projection-gateway/PartySearchProjectionGateway') {}

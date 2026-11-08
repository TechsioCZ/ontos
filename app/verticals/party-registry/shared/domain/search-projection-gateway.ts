import type { CoreSearchAuthorization, CoreSearchTextField, OperationalScope } from '@app/core-runtime';
import type { ListAccessPredicate } from '@app/core-runtime/access/decision/list-access';
import { Context, Option } from 'effect';
import type { Effect, Schema } from 'effect';

import type { CounterpartyRef } from '../resources/counterparty.ts';
import type { PartyRef } from '../resources/party.ts';
import type { CounterpartyIsoTimestampSchema } from './counterparty-contract.ts';
import type { PartySearchProjectionUnavailable } from './search-projection-error.ts';
import type { CurrentCounterpartyRole, SearchLegalEntityContext } from './search-result.ts';

export interface PartySearchProjectionQuery {
  readonly includeArchived: boolean;
  readonly query: string;
  readonly tenantId: string;
}

export interface CounterpartySearchProjectionQuery extends PartySearchProjectionQuery {
  readonly effectiveAt: Schema.Schema.Type<typeof CounterpartyIsoTimestampSchema>;
  readonly legalEntityId: string;
  readonly role?: CurrentCounterpartyRole;
}

export interface PartySearchProjectionHit {
  readonly archived: boolean;
  readonly canonicalPartyRef: PartyRef;
  readonly matchedPartyRef?: PartyRef;
  readonly title: string;
}

interface CounterpartyRoleProjectionPeriod {
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
    scope: OperationalScope,
    authorization: CoreSearchAuthorization,
  ) => Effect.Effect<readonly CounterpartySearchProjectionHit[], PartySearchProjectionUnavailable>;
  readonly searchParties: (
    input: PartySearchProjectionQuery,
    scope: OperationalScope,
    authorization: CoreSearchAuthorization,
  ) => Effect.Effect<readonly PartySearchProjectionHit[], PartySearchProjectionUnavailable>;
}

/**
 * Every OntOS Core Search surface that can carry a Party's name (O17, O25). A name reaches the index
 * as the row title, as searchable text — which includes every alias's own searchable text — and as
 * temporal searchable text, so a denied name denies all three: what the read may not report must
 * also not match, not order, and not confirm itself through an alias.
 */
export const PARTY_SEARCH_NAME_TEXT_FIELDS: readonly CoreSearchTextField[] = Object.freeze([
  'searchableText',
  'temporalSearchableText',
  'title',
]);

/** The result path of a Party Search row that names the Party (its declared identity field group). */
export const PARTY_SEARCH_NAME_PATH: readonly string[] = Object.freeze(['title']);

/** The result path of a Counterparty Search row that names the Counterparty's Party. */
export const COUNTERPARTY_SEARCH_NAME_PATH: readonly string[] = Object.freeze(['party', 'title']);

/** A denied path denies its whole subtree, so a denied `party` group also hides `party.title`. */
const deniesPath = (deniedPath: readonly string[], namePath: readonly string[]): boolean =>
  deniedPath.length <= namePath.length && deniedPath.every((segment, index) => segment === namePath[index]);

/**
 * What one Party search query may match, order and report (O17, O25): the row filter the read's gate
 * answered and the text surfaces a denied name takes out of the index. Both halves are answers the
 * trusted read already holds, never caller input. `Option.none` means the read received no gate
 * answer for its rows or its name field, so a caller can refuse the query instead of widening it into
 * an unrestricted search.
 */
export const partySearchAuthorization = (input: {
  readonly deniedFieldPaths: readonly (readonly string[])[] | undefined;
  readonly listAccess: ListAccessPredicate | undefined;
  readonly namePath: readonly string[];
}): Option.Option<CoreSearchAuthorization> => {
  const { deniedFieldPaths, listAccess, namePath } = input;
  if (deniedFieldPaths === undefined || listAccess === undefined) {
    return Option.none();
  }
  return Option.some(
    Object.freeze({
      hiddenTextFields: deniedFieldPaths.some((path) => deniesPath(path, namePath))
        ? PARTY_SEARCH_NAME_TEXT_FIELDS
        : [],
      listAccess,
    }),
  );
};

/**
 * Owner-facing port implemented by OntOS Core Search. Party Registry supplies business semantics;
 * the implementation supplies only the rebuildable, eventually-consistent projection/query runtime.
 * Every query carries the Read factory's OperationalScope, which Core Search installs for its query.
 */
export class PartySearchProjectionGateway extends Context.Service<
  PartySearchProjectionGateway,
  PartySearchProjectionGatewayService
>()('@app/party-registry/shared/domain/search-projection-gateway/PartySearchProjectionGateway') {}

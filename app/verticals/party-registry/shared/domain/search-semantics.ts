import { DateTime, Option, Schema } from 'effect';
import type { CounterpartyRef } from '../resources/counterparty.ts';
import type { PartyRef } from '../resources/party.ts';
import type {
  CounterpartySearchProjectionHit,
  PartySearchProjectionHit,
} from './search-projection-gateway.ts';
import type {
  CounterpartySearchResult,
  CurrentCounterpartyRole,
  PartySearchResult,
} from './search-result.ts';

export const SearchProjectionViolationSchema = Schema.TaggedStruct('SearchProjectionViolation', {
  reason: Schema.String,
});
export type SearchProjectionViolation = typeof SearchProjectionViolationSchema.Type;

const SearchResultsTagSchema = Schema.TaggedStruct('SearchResults', {});
type SearchResultsTag = typeof SearchResultsTagSchema.Type;
export type SearchResults<Result> = SearchResultsTag & {
  readonly items: readonly Result[];
};

export type SearchNormalizationResult<Result> = SearchProjectionViolation | SearchResults<Result>;

const violation = (reason: string): SearchProjectionViolation =>
  SearchProjectionViolationSchema.make({ reason });

const searchResults = <Result>(items: readonly Result[]): SearchResults<Result> => ({
  ...SearchResultsTagSchema.make({}),
  items,
});

const refKey = (ref: PartyRef | CounterpartyRef): string =>
  `${ref.tenantId}:${ref.resourceType}:${ref.resourceId}`;

const samePartyRef = (left: PartyRef, right: PartyRef): boolean => refKey(left) === refKey(right);

const isAliasHit = (canonical: PartyRef, matched: PartyRef | undefined): boolean =>
  matched !== undefined && !samePartyRef(canonical, matched);

export const normalizePartySearchHits = (
  scope: Readonly<{ readonly includeArchived: boolean; readonly tenantId: string }>,
  hits: readonly PartySearchProjectionHit[],
): SearchNormalizationResult<PartySearchResult> => {
  const byCanonicalParty = new Map<string, PartySearchResult>();
  for (const hit of hits) {
    if (
      hit.canonicalPartyRef.tenantId !== scope.tenantId ||
      (hit.matchedPartyRef !== undefined && hit.matchedPartyRef.tenantId !== scope.tenantId) ||
      hit.title.trim().length === 0
    ) {
      return violation('Party Search projection returned data outside its trusted tenant contract');
    }
    const key = refKey(hit.canonicalPartyRef);
    const existing = byCanonicalParty.get(key);
    if (
      existing !== undefined &&
      (existing.archived !== hit.archived || existing.title !== hit.title.trim())
    ) {
      return violation('Party Search projection returned conflicting canonical Party facts');
    }
    const matchedViaAlias = isAliasHit(hit.canonicalPartyRef, hit.matchedPartyRef);
    if (existing === undefined) {
      byCanonicalParty.set(key, {
        archived: hit.archived,
        matchedViaAlias,
        ref: hit.canonicalPartyRef,
        title: hit.title.trim(),
      });
    } else if (matchedViaAlias && !existing.matchedViaAlias) {
      byCanonicalParty.set(key, { ...existing, matchedViaAlias: true });
    }
  }

  return searchResults(
    [...byCanonicalParty.values()].filter(({ archived }) => scope.includeArchived || !archived),
  );
};

const parseInstant = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);

const currentRolesAt = (
  periods: CounterpartySearchProjectionHit['rolePeriods'],
  effectiveAt: DateTime.Utc,
): Option.Option<readonly CurrentCounterpartyRole[]> => {
  const current = new Set<CurrentCounterpartyRole>();
  for (const period of periods) {
    const from = parseInstant(period.validFrom);
    const to = period.validTo === undefined ? Option.none() : parseInstant(period.validTo);
    if (Option.isNone(from) || (period.validTo !== undefined && Option.isNone(to))) {
      return Option.none();
    }
    if (
      DateTime.Order(from.value, effectiveAt) <= 0 &&
      (Option.isNone(to) || DateTime.Order(effectiveAt, to.value) < 0)
    ) {
      current.add(period.role);
    }
  }
  return Option.some((['CUSTOMER', 'SUPPLIER'] as const).filter((role) => current.has(role)));
};

const sameCurrentProjection = (
  existing: CounterpartySearchResult,
  hit: CounterpartySearchProjectionHit,
  currentRoles: readonly CurrentCounterpartyRole[],
): boolean =>
  samePartyRef(existing.party.ref, hit.canonicalPartyRef) &&
  existing.party.archived === hit.partyArchived &&
  existing.party.title === hit.partyTitle.trim() &&
  existing.legalEntity.tenantId === hit.legalEntity.tenantId &&
  existing.legalEntity.legalEntityId === hit.legalEntity.legalEntityId &&
  existing.currentRoles.length === currentRoles.length &&
  existing.currentRoles.every((role, index) => role === currentRoles[index]);

export const normalizeCounterpartySearchHits = (
  scope: Readonly<{
    readonly effectiveAt: typeof Schema.DateTimeUtcFromString.Encoded;
    readonly includeArchived: boolean;
    readonly legalEntityId: string;
    readonly role?: CurrentCounterpartyRole;
    readonly tenantId: string;
  }>,
  hits: readonly CounterpartySearchProjectionHit[],
): SearchNormalizationResult<CounterpartySearchResult> => {
  const effectiveAt = parseInstant(scope.effectiveAt);
  if (Option.isNone(effectiveAt)) {
    return violation('Counterparty Search effective time is invalid');
  }

  const byCounterparty = new Map<string, CounterpartySearchResult>();
  for (const hit of hits) {
    if (
      hit.counterpartyRef.tenantId !== scope.tenantId ||
      hit.canonicalPartyRef.tenantId !== scope.tenantId ||
      (hit.matchedPartyRef !== undefined && hit.matchedPartyRef.tenantId !== scope.tenantId) ||
      hit.legalEntity.tenantId !== scope.tenantId ||
      hit.legalEntity.legalEntityId !== scope.legalEntityId ||
      hit.partyTitle.trim().length === 0
    ) {
      return violation(
        'Counterparty Search projection returned data outside its trusted tenant or Legal Entity contract',
      );
    }
    const currentRoles = currentRolesAt(hit.rolePeriods, effectiveAt.value);
    if (Option.isNone(currentRoles)) {
      return violation('Counterparty Search projection returned an invalid role period');
    }
    const key = refKey(hit.counterpartyRef);
    const existing = byCounterparty.get(key);
    if (existing !== undefined && !sameCurrentProjection(existing, hit, currentRoles.value)) {
      return violation('Counterparty Search projection returned conflicting Counterparty facts');
    }
    if (existing === undefined) {
      byCounterparty.set(key, {
        currentRoles: currentRoles.value,
        legalEntity: hit.legalEntity,
        party: {
          archived: hit.partyArchived,
          matchedViaAlias: isAliasHit(hit.canonicalPartyRef, hit.matchedPartyRef),
          ref: hit.canonicalPartyRef,
          title: hit.partyTitle.trim(),
        },
        ref: hit.counterpartyRef,
      });
    } else if (
      isAliasHit(hit.canonicalPartyRef, hit.matchedPartyRef) &&
      !existing.party.matchedViaAlias
    ) {
      byCounterparty.set(key, {
        ...existing,
        party: { ...existing.party, matchedViaAlias: true },
      });
    }
  }

  const filtered = [...byCounterparty.values()].filter(
    (item) =>
      (scope.includeArchived || !item.party.archived) &&
      (scope.role === undefined || item.currentRoles.includes(scope.role)),
  );
  const byCanonicalParty = new Map<string, CounterpartySearchResult[]>();
  for (const item of filtered) {
    const key = refKey(item.party.ref);
    byCanonicalParty.set(key, [...(byCanonicalParty.get(key) ?? []), item]);
  }

  return searchResults(
    filtered.map((item) => {
      const colliding = byCanonicalParty.get(refKey(item.party.ref)) ?? [];
      if (colliding.length < 2) {
        return item;
      }
      return {
        ...item,
        collision: {
          counterpartyRefs: colliding
            .map(({ ref }) => ref)
            .toSorted((left, right) => left.resourceId.localeCompare(right.resourceId)),
          kind: 'CANONICAL_PARTY_COUNTERPARTY_COLLISION' as const,
        },
      };
    }),
  );
};

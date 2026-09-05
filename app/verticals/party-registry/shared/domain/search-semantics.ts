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

export interface SearchProjectionViolation {
  readonly _tag: 'SearchProjectionViolation';
  readonly reason: string;
}

export interface SearchResults<Result> {
  readonly _tag: 'SearchResults';
  readonly items: readonly Result[];
}

export type SearchNormalizationResult<Result> = SearchProjectionViolation | SearchResults<Result>;

const violation = (reason: string): SearchProjectionViolation => ({
  _tag: 'SearchProjectionViolation',
  reason,
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

  return {
    _tag: 'SearchResults',
    items: [...byCanonicalParty.values()].filter(
      ({ archived }) => scope.includeArchived || !archived,
    ),
  };
};

const parseInstant = (value: string): number | undefined => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const currentRolesAt = (
  periods: CounterpartySearchProjectionHit['rolePeriods'],
  effectiveAt: number,
): readonly CurrentCounterpartyRole[] | undefined => {
  const current = new Set<CurrentCounterpartyRole>();
  for (const period of periods) {
    const from = parseInstant(period.validFrom);
    const to = period.validTo === undefined ? undefined : parseInstant(period.validTo);
    if (from === undefined || (period.validTo !== undefined && to === undefined)) {
      return undefined;
    }
    if (from <= effectiveAt && (to === undefined || effectiveAt < to)) {
      current.add(period.role);
    }
  }
  return (['CUSTOMER', 'SUPPLIER'] as const).filter((role) => current.has(role));
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
    readonly effectiveAt: string;
    readonly includeArchived: boolean;
    readonly legalEntityId: string;
    readonly role?: CurrentCounterpartyRole;
    readonly tenantId: string;
  }>,
  hits: readonly CounterpartySearchProjectionHit[],
): SearchNormalizationResult<CounterpartySearchResult> => {
  const effectiveAt = parseInstant(scope.effectiveAt);
  if (effectiveAt === undefined) {
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
    const currentRoles = currentRolesAt(hit.rolePeriods, effectiveAt);
    if (currentRoles === undefined) {
      return violation('Counterparty Search projection returned an invalid role period');
    }
    const key = refKey(hit.counterpartyRef);
    const existing = byCounterparty.get(key);
    if (existing !== undefined && !sameCurrentProjection(existing, hit, currentRoles)) {
      return violation('Counterparty Search projection returned conflicting Counterparty facts');
    }
    if (existing === undefined) {
      byCounterparty.set(key, {
        currentRoles,
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

  return {
    _tag: 'SearchResults',
    items: filtered.map((item) => {
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
  };
};

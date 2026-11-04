import { CoreSearchProjectionHitSchema } from '@app/core-runtime';
import { coreSearchTokens, matchesCoreSearchValues, normalizeCoreSearchText } from '@app/core-runtime/search-contract';
import { compareCoreSearchHits } from '@app/core-runtime/search-ranking';
import { DateTime, Option, Schema } from 'effect';

import type { CounterpartyRef } from '../resources/counterparty.ts';
import type { PartyRef } from '../resources/party.ts';
import type { CounterpartySearchProjectionHit, PartySearchProjectionHit } from './search-projection-gateway.ts';
import type { CounterpartySearchResult, CurrentCounterpartyRole, PartySearchResult } from './search-result.ts';

const SearchProjectionViolationSchema = Schema.TaggedStruct('SearchProjectionViolation', {
  reason: Schema.String,
});
type SearchProjectionViolation = typeof SearchProjectionViolationSchema.Type;

const SearchResultsTagSchema = Schema.TaggedStruct('SearchResults', {});
type SearchResultsTag = typeof SearchResultsTagSchema.Type;
export type SearchResults<Result> = SearchResultsTag & {
  readonly items: readonly Result[];
};

export type SearchNormalizationResult<Result> = SearchProjectionViolation | SearchResults<Result>;

const violation = (reason: string): SearchProjectionViolation => SearchProjectionViolationSchema.make({ reason });

const searchResults = <Result>(items: readonly Result[]): SearchResults<Result> => ({
  ...SearchResultsTagSchema.make({}),
  items,
});

const refKey = (ref: PartyRef | CounterpartyRef): string => `${ref.tenantId}:${ref.resourceType}:${ref.resourceId}`;

const samePartyRef = (left: PartyRef, right: PartyRef): boolean => refKey(left) === refKey(right);

const isAliasHit = (canonical: PartyRef, matched: PartyRef | undefined): boolean =>
  matched !== undefined && !samePartyRef(canonical, matched);

const partyHitViolatesScope = (hit: PartySearchProjectionHit, tenantId: string): boolean =>
  hit.canonicalPartyRef.tenantId !== tenantId ||
  (hit.matchedPartyRef !== undefined && hit.matchedPartyRef.tenantId !== tenantId) ||
  hit.title.trim().length === 0;

export const normalizePartySearchHits = (
  scope: Readonly<{
    readonly includeArchived: boolean;
    readonly tenantId: string;
  }>,
  hits: readonly PartySearchProjectionHit[],
): SearchNormalizationResult<PartySearchResult> => {
  const byCanonicalParty = new Map<string, PartySearchResult>();
  for (const hit of hits) {
    if (partyHitViolatesScope(hit, scope.tenantId)) {
      return violation('Party Search projection returned data outside its trusted tenant contract');
    }
    const key = refKey(hit.canonicalPartyRef);
    const existing = byCanonicalParty.get(key);
    if (existing !== undefined && (existing.archived !== hit.archived || existing.title !== hit.title.trim())) {
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
    } else if (!matchedViaAlias && existing.matchedViaAlias) {
      byCanonicalParty.set(key, { ...existing, matchedViaAlias: false });
    }
  }

  return searchResults([...byCanonicalParty.values()].filter(({ archived }) => scope.includeArchived || !archived));
};

export const CurrentPartySearchTimeSchema = Schema.DateTimeUtcFromString;
export const CurrentPartySearchScopeSchema = Schema.Struct({
  effectiveAt: Schema.DateTimeUtc,
  includeArchived: Schema.Boolean,
  query: Schema.String,
  tenantId: Schema.String,
});
export type CurrentPartySearchScope = typeof CurrentPartySearchScopeSchema.Type;

export const CurrentPartySearchValueSchema = Schema.Struct({
  value: Schema.String,
  state: Schema.String,
  isCurrent: Schema.Boolean,
  validFrom: CurrentPartySearchTimeSchema,
  validTo: Schema.optionalKey(CurrentPartySearchTimeSchema),
});
export type CurrentPartySearchValue = typeof CurrentPartySearchValueSchema.Encoded;

export interface CurrentPartySearchIdentity {
  readonly ref: PartyRef;
  readonly displayName: string | null;
  readonly archived: boolean;
  readonly identifiers: readonly CurrentPartySearchValue[];
  readonly contacts: readonly (CurrentPartySearchValue & {
    readonly type: string;
    readonly privacy: string;
  })[];
}

/** Request-local owner facts, never a replacement projection or a persisted privacy fence. */
export interface CurrentPartySearchEvidence {
  readonly identities: readonly CurrentPartySearchIdentity[];
  readonly aliases: readonly {
    readonly aliasPartyRef: PartyRef;
    readonly canonicalPartyRef: PartyRef;
  }[];
}

const parseInstant = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString);

const currentSearchValueAt = (value: CurrentPartySearchValue, effectiveAt: DateTime.Utc): boolean => {
  const from = parseInstant(value.validFrom);
  const to = value.validTo === undefined ? Option.none() : parseInstant(value.validTo);
  return (
    value.state === 'ACTIVE' &&
    value.isCurrent &&
    Option.isSome(from) &&
    (value.validTo === undefined || Option.isSome(to)) &&
    DateTime.Order(from.value, effectiveAt) <= 0 &&
    (Option.isNone(to) || DateTime.Order(effectiveAt, to.value) < 0)
  );
};

const currentPartyCanonicalIds = (
  tenantId: string,
  evidence: CurrentPartySearchEvidence,
): Option.Option<ReadonlyMap<string, string>> => {
  const identities = new Map(evidence.identities.map((identity) => [identity.ref.resourceId, identity]));
  const aliases = new Map(
    evidence.aliases.map(({ aliasPartyRef, canonicalPartyRef }) => [
      aliasPartyRef.resourceId,
      canonicalPartyRef.resourceId,
    ]),
  );
  if (
    identities.size !== evidence.identities.length ||
    aliases.size !== evidence.aliases.length ||
    evidence.identities.some(({ ref }) => ref.tenantId !== tenantId) ||
    evidence.aliases.some(
      ({ aliasPartyRef, canonicalPartyRef }) =>
        aliasPartyRef.tenantId !== tenantId ||
        canonicalPartyRef.tenantId !== tenantId ||
        !identities.has(aliasPartyRef.resourceId),
    )
  ) {
    return Option.none();
  }
  const canonicalIds = new Map<string, string>();
  for (const id of identities.keys()) {
    const seen = new Set<string>();
    let current = id;
    while (aliases.has(current)) {
      if (seen.has(current) || !identities.has(current)) {
        return Option.none();
      }
      seen.add(current);
      current = aliases.get(current) ?? current;
    }
    if (!identities.has(current)) {
      return Option.none();
    }
    canonicalIds.set(id, current);
  }
  return Option.some(canonicalIds);
};

const currentIdentityMatches = (
  identity: CurrentPartySearchIdentity,
  effectiveAt: DateTime.Utc,
  tokens: readonly string[],
): boolean =>
  matchesCoreSearchValues(
    [
      ...(identity.displayName === null ? [] : [identity.displayName]),
      ...identity.identifiers.filter((value) => currentSearchValueAt(value, effectiveAt)).map(({ value }) => value),
      ...identity.contacts
        .filter(
          (value) =>
            value.privacy === 'PUBLIC' &&
            (value.type === 'EMAIL' || value.type === 'PHONE') &&
            currentSearchValueAt(value, effectiveAt),
        )
        .map(({ value }) => value),
    ],
    tokens,
  );

const rankCurrentPartyHits = (
  hits: readonly PartySearchProjectionHit[],
  text: string,
  tokens: readonly string[],
): SearchNormalizationResult<PartySearchProjectionHit> => {
  const query = { phrase: normalizeCoreSearchText(text).trim().split(/\s+/u).join(' '), tokens };
  const ranked = [];
  for (const hit of hits) {
    // Party's public DTO refs are unbranded. Decode the approved Core schema before ranking;
    // no assertion may promote an owner ref into a Core resource identity.
    const ranking = Schema.decodeUnknownOption(CoreSearchProjectionHitSchema)({
      archived: hit.archived,
      facets: [],
      metadata: [],
      ref: hit.canonicalPartyRef,
      title: hit.title,
    });
    if (Option.isNone(ranking)) {
      return violation('Party Search current evidence contains an invalid ranking identity');
    }
    ranked.push({ hit, ranking: ranking.value });
  }
  return searchResults(
    ranked.toSorted((left, right) => compareCoreSearchHits(left.ranking, right.ranking, query)).map(({ hit }) => hit),
  );
};

/**
 * The index supplies candidates only. Rebuild selection, attribution and ordering exclusively
 * from current, authorized owner facts. In particular, a stale contact cannot contribute even
 * one token to a mixed name/contact query or improve a surviving name hit's rank/reason.
 */
export const rematchCurrentPartySearchHits = (
  scope: CurrentPartySearchScope,
  hits: readonly PartySearchProjectionHit[],
  evidence: CurrentPartySearchEvidence,
  authorizedPartyIds: ReadonlySet<string>,
): SearchNormalizationResult<PartySearchProjectionHit> => {
  const normalized = normalizePartySearchHits({ ...scope, includeArchived: true }, hits);
  if (Schema.is(SearchProjectionViolationSchema)(normalized)) {
    return normalized;
  }
  const tokens = coreSearchTokens(scope.query);
  if (!Schema.is(Schema.DateTimeUtc)(scope.effectiveAt) || tokens.length === 0) {
    return violation('Party Search current evidence requires a valid query and effective time');
  }
  const resolved = currentPartyCanonicalIds(scope.tenantId, evidence);
  if (Option.isNone(resolved)) {
    return violation('Party Search current evidence contains an invalid identity or alias chain');
  }
  const canonicalIds = resolved.value;
  const identities = new Map(evidence.identities.map((identity) => [identity.ref.resourceId, identity]));
  const matches = (identity: CurrentPartySearchIdentity): boolean =>
    authorizedPartyIds.has(identity.ref.resourceId) && currentIdentityMatches(identity, scope.effectiveAt, tokens);
  const currentHits: PartySearchProjectionHit[] = [];
  for (const { ref } of normalized.items) {
    const canonical = identities.get(ref.resourceId);
    if (
      canonical === undefined ||
      canonicalIds.get(ref.resourceId) !== ref.resourceId ||
      !authorizedPartyIds.has(ref.resourceId) ||
      (!scope.includeArchived && canonical.archived)
    ) {
      continue;
    }
    const base = {
      archived: canonical.archived,
      canonicalPartyRef: canonical.ref,
      title: canonical.displayName ?? 'Unnamed Party',
    };
    if (matches(canonical)) {
      currentHits.push(base);
      continue;
    }
    const [alias] = evidence.identities
      .filter(
        (identity) =>
          identity.ref.resourceId !== ref.resourceId &&
          canonicalIds.get(identity.ref.resourceId) === ref.resourceId &&
          matches(identity),
      )
      .toSorted((left, right) => left.ref.resourceId.localeCompare(right.ref.resourceId));
    if (alias !== undefined) {
      currentHits.push({ ...base, matchedPartyRef: alias.ref });
    }
  }
  return rankCurrentPartyHits(currentHits, scope.query, tokens);
};

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

const counterpartyHitViolatesScope = (
  hit: CounterpartySearchProjectionHit,
  scope: Readonly<{ tenantId: string; legalEntityId: string }>,
): boolean =>
  hit.counterpartyRef.tenantId !== scope.tenantId ||
  hit.canonicalPartyRef.tenantId !== scope.tenantId ||
  (hit.matchedPartyRef !== undefined && hit.matchedPartyRef.tenantId !== scope.tenantId) ||
  hit.legalEntity.tenantId !== scope.tenantId ||
  hit.legalEntity.legalEntityId !== scope.legalEntityId ||
  hit.partyTitle.trim().length === 0;

const withCounterpartyCollisions = (
  filtered: readonly CounterpartySearchResult[],
): SearchNormalizationResult<CounterpartySearchResult> => {
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
    if (counterpartyHitViolatesScope(hit, scope)) {
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
    } else if (!isAliasHit(hit.canonicalPartyRef, hit.matchedPartyRef) && existing.party.matchedViaAlias) {
      byCounterparty.set(key, {
        ...existing,
        party: { ...existing.party, matchedViaAlias: false },
      });
    }
  }

  const filtered = [...byCounterparty.values()].filter(
    (item) =>
      (scope.includeArchived || !item.party.archived) &&
      (scope.role === undefined || item.currentRoles.includes(scope.role)),
  );
  return withCounterpartyCollisions(filtered);
};

import type { PartyRef } from '../../shared/resources/party.ts';

type PartyOwnedReference = Readonly<{ partyRef: PartyRef }>;
export interface MergeCollisionInput {
  readonly absorbedPartyRefs: readonly PartyRef[];
  readonly connectorCorrelations: readonly (PartyOwnedReference & {
    readonly connectorKey: string;
    readonly externalSubjectId: string;
  })[];
  readonly consumerProfiles: readonly (PartyOwnedReference & {
    readonly consumerKey: string;
    readonly profileId: string;
    readonly uniquePerParty: boolean;
  })[];
  readonly counterparties: readonly (PartyOwnedReference & {
    readonly counterpartyId: string;
    readonly legalEntityId: string;
  })[];
  readonly counterpartyRoles: readonly (PartyOwnedReference & {
    readonly legalEntityId: string;
    readonly rolePeriodId: string;
    readonly roleType: string;
    readonly validFrom: string;
    readonly validTo: string | null;
  })[];
  readonly officialIdentifiers: readonly (PartyOwnedReference & {
    readonly active: boolean;
    readonly authoritative: boolean;
    readonly identifierId: string;
    readonly identifierTypeKey: string;
    readonly namespace: string;
    readonly normalizedValue: string;
    readonly strongClaim: boolean;
  })[];
  readonly relationships: readonly {
    readonly forbidsOverlap: boolean;
    readonly fromPartyRef: PartyRef;
    readonly relationshipId: string;
    readonly relationshipTypeKey: string;
    readonly toPartyRef: PartyRef;
    readonly validFrom: string;
    readonly validTo: string | null;
  }[];
  readonly survivorPartyRef: PartyRef;
}

export interface MergeCollision {
  readonly code:
    | 'CONNECTOR_CORRELATION_COLLISION'
    | 'CONSUMER_PROFILE_COLLISION'
    | 'COUNTERPARTY_COLLISION'
    | 'COUNTERPARTY_ROLE_PERIOD_COLLISION'
    | 'RELATIONSHIP_PERIOD_COLLISION'
    | 'RELATIONSHIP_SELF_REFERENCE'
    | 'STRONG_IDENTIFIER_CONFLICT';
  readonly ownerKey: string;
  readonly recordIds: readonly string[];
  readonly resolution: 'CORRECTION_REQUIRED' | 'RECONCILIATION_REQUIRED';
}

const groupsWithCollisions = <Value>(
  values: readonly Value[],
  groupKey: (value: Value) => string,
): readonly [string, readonly Value[]][] => {
  const groups = new Map<string, Value[]>();
  for (const value of values) {
    const key = groupKey(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return [...groups]
    .filter(([, group]) => group.length > 1)
    .toSorted(([left], [right]) => left.localeCompare(right));
};

const periodsOverlap = (
  left: Readonly<{ validFrom: string; validTo: string | null }>,
  right: Readonly<{ validFrom: string; validTo: string | null }>,
) =>
  (left.validTo === null || right.validFrom < left.validTo) &&
  (right.validTo === null || left.validFrom < right.validTo);
const partyKey = ({ resourceId, tenantId }: PartyRef) => `${tenantId}:${resourceId}`;

export const analyzeMergeCollisions = (input: MergeCollisionInput): readonly MergeCollision[] => {
  const mergePartyKeys = new Set([
    partyKey(input.survivorPartyRef),
    ...input.absorbedPartyRefs.map(partyKey),
  ]);
  const inMergeSet = <Value extends PartyOwnedReference>(values: readonly Value[]) =>
    values.filter(({ partyRef }) => mergePartyKeys.has(partyKey(partyRef)));
  const canonicalPartyId = (partyRef: PartyRef) =>
    mergePartyKeys.has(partyKey(partyRef)) ? partyKey(input.survivorPartyRef) : partyKey(partyRef);

  const identifierCollisions = groupsWithCollisions(
    inMergeSet(input.officialIdentifiers).filter(
      ({ active, authoritative, strongClaim }) => active && (authoritative || strongClaim),
    ),
    ({ identifierTypeKey, namespace }) => `${identifierTypeKey}:${namespace}`,
  )
    .filter(([, rows]) => new Set(rows.map(({ normalizedValue }) => normalizedValue)).size > 1)
    .map(([claimKey, rows]) => ({
      code: 'STRONG_IDENTIFIER_CONFLICT' as const,
      ownerKey: `party.registry:${claimKey}`,
      recordIds: rows.map(({ identifierId }) => identifierId).toSorted(),
      resolution: 'CORRECTION_REQUIRED' as const,
    }));

  const relationshipCollisions: MergeCollision[] = [];
  const relationships = input.relationships
    .filter(
      ({ fromPartyRef, toPartyRef }) =>
        mergePartyKeys.has(partyKey(fromPartyRef)) || mergePartyKeys.has(partyKey(toPartyRef)),
    )
    .map((relationship) => ({
      ...relationship,
      canonicalFromPartyId: canonicalPartyId(relationship.fromPartyRef),
      canonicalToPartyId: canonicalPartyId(relationship.toPartyRef),
    }));
  for (const relationship of relationships) {
    if (
      relationship.forbidsOverlap &&
      relationship.canonicalFromPartyId === relationship.canonicalToPartyId
    ) {
      relationshipCollisions.push({
        code: 'RELATIONSHIP_SELF_REFERENCE',
        ownerKey: 'party.registry',
        recordIds: [relationship.relationshipId],
        resolution: 'RECONCILIATION_REQUIRED',
      });
    }
  }
  for (const [, rows] of groupsWithCollisions(
    relationships.filter(({ forbidsOverlap }) => forbidsOverlap),
    ({ canonicalFromPartyId, canonicalToPartyId, relationshipTypeKey }) =>
      `${relationshipTypeKey}:${canonicalFromPartyId}:${canonicalToPartyId}`,
  )) {
    if (
      rows.some((left, index) => rows.slice(index + 1).some((right) => periodsOverlap(left, right)))
    ) {
      relationshipCollisions.push({
        code: 'RELATIONSHIP_PERIOD_COLLISION',
        ownerKey: 'party.registry',
        recordIds: rows.map(({ relationshipId }) => relationshipId).toSorted(),
        resolution: 'RECONCILIATION_REQUIRED',
      });
    }
  }

  const roleCollisions = groupsWithCollisions(
    inMergeSet(input.counterpartyRoles),
    ({ legalEntityId, roleType }) => `${legalEntityId}:${roleType}`,
  )
    .filter(([, rows]) =>
      rows.some((left, index) =>
        rows.slice(index + 1).some((right) => periodsOverlap(left, right)),
      ),
    )
    .map(([, rows]) => ({
      code: 'COUNTERPARTY_ROLE_PERIOD_COLLISION' as const,
      ownerKey: 'party.registry',
      recordIds: rows.map(({ rolePeriodId }) => rolePeriodId).toSorted(),
      resolution: 'RECONCILIATION_REQUIRED' as const,
    }));

  const counterpartyCollisions = groupsWithCollisions(
    inMergeSet(input.counterparties),
    ({ legalEntityId }) => legalEntityId,
  ).map(([, rows]) => ({
    code: 'COUNTERPARTY_COLLISION' as const,
    ownerKey: 'party.registry',
    recordIds: rows.map(({ counterpartyId }) => counterpartyId).toSorted(),
    resolution: 'RECONCILIATION_REQUIRED' as const,
  }));
  const consumerCollisions = groupsWithCollisions(
    inMergeSet(input.consumerProfiles).filter(({ uniquePerParty }) => uniquePerParty),
    ({ consumerKey }) => consumerKey,
  ).map(([consumerKey, rows]) => ({
    code: 'CONSUMER_PROFILE_COLLISION' as const,
    ownerKey: consumerKey,
    recordIds: rows.map(({ profileId }) => profileId).toSorted(),
    resolution: 'RECONCILIATION_REQUIRED' as const,
  }));
  const connectorCollisions = groupsWithCollisions(
    inMergeSet(input.connectorCorrelations),
    ({ connectorKey }) => connectorKey,
  ).map(([connectorKey, rows]) => ({
    code: 'CONNECTOR_CORRELATION_COLLISION' as const,
    ownerKey: connectorKey,
    recordIds: rows.map(({ externalSubjectId }) => externalSubjectId).toSorted(),
    resolution: 'RECONCILIATION_REQUIRED' as const,
  }));

  return [
    ...identifierCollisions,
    ...relationshipCollisions,
    ...roleCollisions,
    ...counterpartyCollisions,
    ...consumerCollisions,
    ...connectorCollisions,
  ];
};

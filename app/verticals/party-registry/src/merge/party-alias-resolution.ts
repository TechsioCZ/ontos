import type { PartyAlias } from '../../shared/resources/party-alias.ts';
import type { PartyRef } from '../../shared/resources/party.ts';

type AliasResolutionRejection = Readonly<{
  _tag:
    | 'PartyAliasCycleRejected'
    | 'PartyAliasSelfReferenceRejected'
    | 'PartyAliasCrossTenantRejected';
  aliasPartyRef: PartyRef;
}>;
type CanonicalPartyResolution =
  | AliasResolutionRejection
  | Readonly<{
      _tag: 'CanonicalPartyResolved';
      canonicalPartyRef: PartyRef;
      requestedAlias?: PartyRef;
      traversedAliasPartyRefs: readonly PartyRef[];
    }>;

const keyOf = ({ resourceId, tenantId }: PartyRef) => `${tenantId}:${resourceId}`;

export const resolveCanonicalPartyRef = (
  requested: PartyRef,
  aliases: readonly PartyAlias[],
): CanonicalPartyResolution => {
  const byAlias = new Map(aliases.map((alias) => [keyOf(alias.aliasPartyRef), alias]));
  const seen = new Set<string>();
  const traversed: PartyRef[] = [];
  let current = requested;

  for (;;) {
    const alias = byAlias.get(keyOf(current));
    if (alias === undefined) {
      const resolved = {
        _tag: 'CanonicalPartyResolved' as const,
        canonicalPartyRef: current,
        traversedAliasPartyRefs: traversed,
      };
      return traversed.length > 0 ? { ...resolved, requestedAlias: requested } : resolved;
    }
    if (alias.aliasPartyRef.tenantId !== alias.survivorPartyRef.tenantId) {
      return { _tag: 'PartyAliasCrossTenantRejected', aliasPartyRef: alias.aliasPartyRef };
    }
    if (alias.aliasPartyRef.resourceId === alias.survivorPartyRef.resourceId) {
      return { _tag: 'PartyAliasSelfReferenceRejected', aliasPartyRef: alias.aliasPartyRef };
    }
    const currentKey = keyOf(alias.aliasPartyRef);
    if (seen.has(currentKey)) {
      return { _tag: 'PartyAliasCycleRejected', aliasPartyRef: alias.aliasPartyRef };
    }
    seen.add(currentKey);
    traversed.push(alias.aliasPartyRef);
    current = alias.survivorPartyRef;
  }
};

export const assertCanonicalWriteTarget = (requested: PartyRef, aliases: readonly PartyAlias[]) => {
  const resolved = resolveCanonicalPartyRef(requested, aliases);
  if (resolved._tag !== 'CanonicalPartyResolved' || resolved.requestedAlias === undefined) {
    return resolved._tag === 'CanonicalPartyResolved'
      ? ({ _tag: 'CanonicalWriteTargetAccepted', partyRef: requested } as const)
      : resolved;
  }
  return {
    _tag: 'AliasWriteRejected',
    aliasPartyRef: requested,
    canonicalPartyRef: resolved.canonicalPartyRef,
    code: 'ALIAS_WRITE_FORBIDDEN',
  } as const;
};

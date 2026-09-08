import { Match, Schema } from 'effect';

import type { PartyAlias } from '../../shared/resources/party-alias.ts';
import { PartyRefSchema } from '../../shared/resources/party.ts';
import type { PartyRef } from '../../shared/resources/party.ts';

const AliasResolutionRejectionSchema = Schema.Union([
  Schema.TaggedStruct('PartyAliasCycleRejected', {
    aliasPartyRef: PartyRefSchema,
  }),
  Schema.TaggedStruct('PartyAliasSelfReferenceRejected', {
    aliasPartyRef: PartyRefSchema,
  }),
  Schema.TaggedStruct('PartyAliasCrossTenantRejected', {
    aliasPartyRef: PartyRefSchema,
  }),
]);
const CanonicalPartyResolutionSchema = Schema.Union([
  AliasResolutionRejectionSchema,
  Schema.TaggedStruct('CanonicalPartyResolved', {
    canonicalPartyRef: PartyRefSchema,
    requestedAlias: Schema.optionalKey(PartyRefSchema),
    traversedAliasPartyRefs: Schema.Array(PartyRefSchema),
  }),
]);
export type CanonicalPartyResolution =
  typeof CanonicalPartyResolutionSchema.Type;

const keyOf = ({ resourceId, tenantId }: PartyRef) =>
  `${tenantId}:${resourceId}`;

export const resolveCanonicalPartyRef = (
  requested: PartyRef,
  aliases: readonly PartyAlias[]
): CanonicalPartyResolution => {
  const byAlias = new Map(
    aliases.map((alias) => [keyOf(alias.aliasPartyRef), alias])
  );
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
      return traversed.length > 0
        ? { ...resolved, requestedAlias: requested }
        : resolved;
    }
    if (alias.aliasPartyRef.tenantId !== alias.survivorPartyRef.tenantId) {
      return {
        _tag: 'PartyAliasCrossTenantRejected',
        aliasPartyRef: alias.aliasPartyRef,
      };
    }
    if (alias.aliasPartyRef.resourceId === alias.survivorPartyRef.resourceId) {
      return {
        _tag: 'PartyAliasSelfReferenceRejected',
        aliasPartyRef: alias.aliasPartyRef,
      };
    }
    const currentKey = keyOf(alias.aliasPartyRef);
    if (seen.has(currentKey)) {
      return {
        _tag: 'PartyAliasCycleRejected',
        aliasPartyRef: alias.aliasPartyRef,
      };
    }
    seen.add(currentKey);
    traversed.push(alias.aliasPartyRef);
    current = alias.survivorPartyRef;
  }
};

export const assertCanonicalWriteTarget = (
  requested: PartyRef,
  aliases: readonly PartyAlias[]
) => {
  const resolved = resolveCanonicalPartyRef(requested, aliases);
  return Match.value(resolved).pipe(
    Match.tag('CanonicalPartyResolved', (resolution) =>
      resolution.requestedAlias === undefined
        ? ({
            _tag: 'CanonicalWriteTargetAccepted',
            partyRef: requested,
          } as const)
        : ({
            _tag: 'AliasWriteRejected',
            aliasPartyRef: requested,
            canonicalPartyRef: resolution.canonicalPartyRef,
            code: 'ALIAS_WRITE_FORBIDDEN',
          } as const)
    ),
    Match.tag('PartyAliasCycleRejected', (rejection) => rejection),
    Match.tag('PartyAliasSelfReferenceRejected', (rejection) => rejection),
    Match.tag('PartyAliasCrossTenantRejected', (rejection) => rejection),
    Match.exhaustive
  );
};

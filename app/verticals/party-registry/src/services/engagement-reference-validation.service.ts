import { Effect, Match } from 'effect';
import type { CounterpartyRef, PartyRef } from '../../shared/party-registry-references.ts';
import {
  EngagementProfileConflict,
  PartyRegistryReferenceUnavailable,
} from '../../shared/domain/engagement-profile.ts';
import type { CounterpartyPersistenceUnavailable } from '../../shared/domain/counterparty-errors.ts';
import type { PartyAliasResolutionError } from '../../shared/domain/merge-alias-resolution.ts';
import type { PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import type { PartyTransaction } from '../db/types.ts';
import { resolvePartyAlias } from '../merge/party-alias-resolution.service.ts';
import { findCounterpartyRecord } from './counterparty-persistence.service.ts';
import { findPartyRecord } from './party-identity-persistence.service.ts';

export interface EngagementPartyReferences {
  readonly counterpartyRef?: CounterpartyRef;
  readonly partyRef: PartyRef;
}

export interface PartyRegistryCounterpartyProjection {
  readonly counterpartyRef: CounterpartyRef;
  readonly partyRef: PartyRef;
  readonly roleTypes: readonly ('CUSTOMER' | 'SUPPLIER')[];
}

export interface PartyRegistryPartyProjection {
  readonly archived: boolean;
  readonly partyRef: PartyRef;
  readonly partyType: 'ORGANIZATION' | 'PERSON' | 'UNRESOLVED';
  readonly requestedPartyRef: PartyRef;
}

type ReferenceValidationError = EngagementProfileConflict | PartyRegistryReferenceUnavailable;

export interface PartyRegistryReferenceOperations {
  readonly readCounterparty: (
    ref: CounterpartyRef,
  ) => Effect.Effect<PartyRegistryCounterpartyProjection, ReferenceValidationError>;
  readonly readParty: (
    ref: PartyRef,
  ) => Effect.Effect<PartyRegistryPartyProjection, ReferenceValidationError>;
}

type ReferencePersistenceError =
  | CounterpartyPersistenceUnavailable
  | PartyAliasResolutionError
  | PartyPersistenceUnavailable;

const unavailable = (cause: ReferencePersistenceError) =>
  new PartyRegistryReferenceUnavailable({
    code: 'party_registry_reference_unavailable',
    reason: `Party Registry reference validation is temporarily unavailable (${cause._tag})`,
  });

const mismatch = (reason: string) =>
  new EngagementProfileConflict({
    code: 'contacts_party_counterparty_mismatch',
    reason,
  });

const makePartyRef = (tenantId: string, resourceId: string): PartyRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party',
  tenantId,
});

interface PartyRegistryReferenceContext {
  readonly legalEntityId: string;
  readonly tenantId: string;
  readonly transaction: Pick<PartyTransaction, 'insert' | 'select' | 'update'>;
}

/** Builds owner-local validation operations over the same Action transaction. */
export const partyRegistryReferenceOperations = ({
  legalEntityId,
  tenantId,
  transaction,
}: PartyRegistryReferenceContext): PartyRegistryReferenceOperations => ({
  readCounterparty: (ref) =>
    ref.tenantId === tenantId
      ? findCounterpartyRecord(transaction, tenantId, legalEntityId, ref.resourceId).pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((result) =>
            Match.value(result).pipe(
              Match.tag('not_found', () =>
                Effect.fail(mismatch('The Counterparty reference does not exist')),
              ),
              Match.tag('found', ({ value }) =>
                Effect.succeed({
                  counterpartyRef: value.counterpartyRef,
                  partyRef: value.party.canonicalPartyRef,
                  roleTypes: value.currentRoles.map(({ roleType }) => roleType),
                }),
              ),
              Match.exhaustive,
            ),
          ),
        )
      : Effect.fail(mismatch('The Counterparty reference does not belong to the trusted tenant')),
  readParty: (ref) =>
    ref.tenantId === tenantId
      ? resolvePartyAlias(transaction, tenantId, ref.resourceId).pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((resolution) =>
            findPartyRecord(transaction, tenantId, resolution.canonicalPartyId).pipe(
              Effect.mapError(unavailable),
              Effect.flatMap((result) =>
                Match.value(result).pipe(
                  Match.tag('not_found', () =>
                    Effect.fail(mismatch('The Party reference does not exist')),
                  ),
                  Match.tag('found', ({ value }) =>
                    Effect.succeed({
                      archived: value.archivedAt !== null,
                      partyRef: value.partyRef,
                      partyType: value.partyType,
                      requestedPartyRef: makePartyRef(tenantId, resolution.requestedPartyId),
                    }),
                  ),
                  Match.exhaustive,
                ),
              ),
            ),
          ),
        )
      : Effect.fail(mismatch('The Party reference does not belong to the trusted tenant')),
});

export const validatePartyRegistryReferences = Effect.fn(
  'EngagementReferenceValidationService.validatePartyRegistryReferences',
)(function* validatePartyRegistryReferencesEffect(
  operations: PartyRegistryReferenceOperations,
  refs: EngagementPartyReferences,
  options: { readonly expectedPartyType: 'ORGANIZATION' | 'PERSON' },
) {
  const party = yield* operations.readParty(refs.partyRef);
  if (
    party.requestedPartyRef.resourceId !== refs.partyRef.resourceId ||
    party.requestedPartyRef.tenantId !== refs.partyRef.tenantId ||
    party.partyRef.tenantId !== refs.partyRef.tenantId
  ) {
    return yield* new EngagementProfileConflict({
      code: 'contacts_party_counterparty_mismatch',
      reason: 'The Party response does not resolve the supplied tenant reference',
    });
  }
  if (party.partyRef.resourceId !== refs.partyRef.resourceId) {
    return yield* new EngagementProfileConflict({
      code: 'contacts_party_alias_requires_canonical_reference',
      reason: 'New engagement profiles must target the canonical survivor Party reference',
    });
  }
  if (party.archived) {
    return yield* new EngagementProfileConflict({
      code: 'contacts_party_archived',
      reason: 'New engagement profiles cannot attach to an archived Party',
    });
  }
  const expectedType =
    party.partyType === options.expectedPartyType ||
    (options.expectedPartyType === 'PERSON' && party.partyType === 'UNRESOLVED');
  if (!expectedType) {
    return yield* new EngagementProfileConflict({
      code: 'contacts_party_type_mismatch',
      reason: 'The Party type does not support this engagement profile',
    });
  }
  if (refs.counterpartyRef === undefined) {
    return yield* Effect.void;
  }
  const counterparty = yield* operations.readCounterparty(refs.counterpartyRef);
  if (
    counterparty.counterpartyRef.resourceId !== refs.counterpartyRef.resourceId ||
    counterparty.counterpartyRef.tenantId !== refs.counterpartyRef.tenantId ||
    refs.counterpartyRef.tenantId !== refs.partyRef.tenantId ||
    counterparty.partyRef.resourceId !== party.partyRef.resourceId ||
    counterparty.partyRef.tenantId !== refs.partyRef.tenantId
  ) {
    return yield* new EngagementProfileConflict({
      code: 'contacts_party_counterparty_mismatch',
      reason: 'The Counterparty does not resolve to the supplied Party',
    });
  }
  if (!counterparty.roleTypes.includes('CUSTOMER')) {
    return yield* new EngagementProfileConflict({
      code: 'contacts_counterparty_customer_role_required',
      reason: 'An explicit commercial context requires a current CUSTOMER role',
    });
  }
  return yield* Effect.void;
});

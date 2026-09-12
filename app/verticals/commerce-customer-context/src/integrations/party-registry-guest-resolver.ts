import { GuestPartyResolutionResponseSchema, executeGuestPartyResolution } from '@app/party-registry/api/client';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';

import type { ProfilePersistenceDependencies } from '../persistence/profile-persistence.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';
import type { GuestPartyResolutionOutcome } from '../../shared/domain/profile-contracts.ts';

type GuestPartyResolver = NonNullable<ProfilePersistenceDependencies['resolveGuestParty']>;
type GuestPartyResolutionExecutor = typeof executeGuestPartyResolution;

export interface PartyRegistryGuestResolverFactoryInput {
  readonly legalEntityId: string;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}

export interface PartyRegistryGuestResolverFactoryService {
  readonly make: (input: PartyRegistryGuestResolverFactoryInput) => GuestPartyResolver;
}

export class PartyRegistryGuestResolverFactory extends Context.Service<
  PartyRegistryGuestResolverFactory,
  PartyRegistryGuestResolverFactoryService
>()('@app/commerce-customer-context/integrations/party-registry-guest-resolver/PartyRegistryGuestResolverFactory') {}

const dependencyFailure = (reason: string, cause?: unknown) => {
  const failure = new ProfilePersistenceDependencyFailure({ reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const invalidScope = dependencyFailure('Guest Party resolution scope is not trusted');

const isTrustedPartyRef = (
  ref: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  scope: PartyRegistryGuestResolverFactoryInput,
) =>
  ref.moduleId === 'party.registry' &&
  ref.resourceType === 'party.registry.party' &&
  ref.resourceId.trim().length > 0 &&
  ref.tenantId === scope.tenantId;

const mapGuestPartyResolution = (
  response: Schema.Schema.Type<typeof GuestPartyResolutionResponseSchema>,
  scope: PartyRegistryGuestResolverFactoryInput,
): Effect.Effect<GuestPartyResolutionOutcome, ProfilePersistenceDependencyFailure> => {
  if (!Schema.is(GuestPartyResolutionResponseSchema)(response)) {
    return Effect.fail(dependencyFailure('The Party Registry returned an invalid guest-evidence outcome'));
  }
  if (response.outcome === 'EXISTING_PARTY_RESOLVED' || response.outcome === 'UNRESOLVED_PARTY_CREATED') {
    return isTrustedPartyRef(response.partyRef, scope)
      ? Effect.succeed(response)
      : Effect.fail(dependencyFailure('The Party Registry returned a Party outside the trusted Tenant'));
  }
  if (response.outcome === 'AMBIGUOUS_MATCH') {
    return response.caseRef.tenantId === scope.tenantId && response.caseRef.resourceId.trim().length > 0
      ? Effect.succeed({
          caseRef: response.caseRef.resourceId,
          outcome: response.outcome,
        })
      : Effect.fail(dependencyFailure('The Party Registry returned a review case outside the trusted Tenant'));
  }
  return Effect.succeed(response);
};

/**
 * Builds the CCC adapter over Party Registry's governed guest-evidence read. Trusted operation
 * scope is captured by the factory; caller-provided Tenant or Legal Entity values never replace
 * it, and a malformed owner result is rejected before CCC profile mutation can run.
 */
export const makePartyRegistryGuestResolver =
  (
    input: PartyRegistryGuestResolverFactoryInput,
    execute: GuestPartyResolutionExecutor = executeGuestPartyResolution,
  ): GuestPartyResolver =>
  (request): ReturnType<GuestPartyResolver> => {
    if (
      request.tenantId !== input.tenantId ||
      request.legalEntityId !== input.legalEntityId ||
      input.requestCorrelation.trim().length === 0 ||
      request.guestEvidenceRef.trim().length === 0 ||
      request.guestEvidenceRef !== request.guestEvidenceRef.trim() ||
      request.correlationRoot.trim().length === 0 ||
      request.correlationRoot !== request.correlationRoot.trim()
    ) {
      return Effect.fail(invalidScope);
    }

    return execute(
      {
        correlationRoot: request.correlationRoot,
        guestEvidenceRef: request.guestEvidenceRef,
        legalEntityRef: {
          moduleId: 'core.identity',
          resourceId: input.legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId: input.tenantId,
        },
        requestedAt: DateTime.makeUnsafe(request.requestedAt),
      },
      input.requestCorrelation,
    ).pipe(
      Effect.mapError((cause) =>
        dependencyFailure('The Party Registry guest-evidence operation is unavailable', cause),
      ),
      Effect.flatMap((response) => mapGuestPartyResolution(response, input)),
    );
  };

export const partyRegistryGuestResolverFactoryLive = Layer.succeed(
  PartyRegistryGuestResolverFactory,
  Object.freeze({ make: makePartyRegistryGuestResolver }),
);

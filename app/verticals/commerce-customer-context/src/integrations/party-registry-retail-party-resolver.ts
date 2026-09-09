import { PartyDetailResponseSchema, executePartyDetail } from '@app/party-registry/api/client';
import { Effect, Layer, Option, Schema, Context } from 'effect';

import type { ProfilePersistenceDependencies } from '../persistence/profile-persistence.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';

type RetailPartyResolver = NonNullable<ProfilePersistenceDependencies['resolveRetailParty']>;
type RetailPartyResolutionExecutor = typeof executePartyDetail;

export type RetailPartyResolution =
  | {
      readonly outcome: 'CURRENT_PARTY_RESOLVED';
      readonly partyResourceId: string;
      readonly partyResourceRevision: string;
    }
  | { readonly outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' };

export interface PartyRegistryRetailPartyResolverFactoryInput {
  readonly requestCorrelation: string;
  readonly tenantId: string;
}

export interface PartyRegistryRetailPartyResolverFactoryService {
  readonly make: (input: PartyRegistryRetailPartyResolverFactoryInput) => RetailPartyResolver;
}

export class PartyRegistryRetailPartyResolverFactory extends Context.Service<
  PartyRegistryRetailPartyResolverFactory,
  PartyRegistryRetailPartyResolverFactoryService
>()(
  '@app/commerce-customer-context/integrations/party-registry-retail-party-resolver/PartyRegistryRetailPartyResolverFactory',
) {}

const dependencyFailure = (reason: string, cause?: unknown) => {
  const failure = new ProfilePersistenceDependencyFailure({ reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const samePartyRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/**
 * Resolves an authenticated Retail subject through Party Registry's public governed Party Detail
 * read. A direct, non-archived canonical Party is the only successful result. Alias responses,
 * cross-Tenant responses, malformed owner payloads, and archived Parties fail closed as invalid
 * owner evidence; transport/owner failures remain retryable dependency failures.
 */
export const makePartyRegistryRetailPartyResolver =
  (
    input: PartyRegistryRetailPartyResolverFactoryInput,
    execute: RetailPartyResolutionExecutor = executePartyDetail,
  ): RetailPartyResolver =>
  (request): ReturnType<RetailPartyResolver> => {
    if (
      request.tenantId !== input.tenantId ||
      input.requestCorrelation.trim().length === 0 ||
      request.partyResourceId.trim().length === 0 ||
      request.partyResourceId !== request.partyResourceId.trim()
    ) {
      return Effect.fail(dependencyFailure('Retail Party resolution scope is not trusted'));
    }

    const requestedPartyRef = {
      moduleId: 'party.registry' as const,
      resourceId: request.partyResourceId,
      resourceType: 'party.registry.party' as const,
      tenantId: input.tenantId,
    };

    return execute({ partyRef: requestedPartyRef }, input.requestCorrelation).pipe(
      Effect.mapError((cause) =>
        dependencyFailure('The Party Registry Party Detail operation is unavailable', cause),
      ),
      Effect.flatMap(
        (response): Effect.Effect<RetailPartyResolution, ProfilePersistenceDependencyFailure> => {
          if (!Schema.is(PartyDetailResponseSchema)(response)) {
            return Effect.fail(
              dependencyFailure('The Party Registry returned an invalid Party Detail outcome'),
            );
          }

          // A direct resolution is deliberately required. Accepting an alias here would make the
          // authenticated caller's subject differ from the canonical owner identity at ensure time.
          const directCanonical =
            response.resolution.kind === 'DIRECT' &&
            samePartyRef(response.resolution.requestedPartyRef, requestedPartyRef) &&
            samePartyRef(response.resolution.canonicalPartyRef, requestedPartyRef) &&
            samePartyRef(response.party.partyRef, requestedPartyRef) &&
            response.resolution.aliasChain.length === 0 &&
            Option.isNone(response.party.archivedAt);

          return directCanonical
            ? Effect.succeed({
                outcome: 'CURRENT_PARTY_RESOLVED' as const,
                partyResourceId: request.partyResourceId,
                partyResourceRevision: String(response.party.revision),
              })
            : Effect.succeed({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const });
        },
      ),
    );
  };

export const partyRegistryRetailPartyResolverFactoryLive = Layer.succeed(
  PartyRegistryRetailPartyResolverFactory,
  Object.freeze({ make: makePartyRegistryRetailPartyResolver }),
);

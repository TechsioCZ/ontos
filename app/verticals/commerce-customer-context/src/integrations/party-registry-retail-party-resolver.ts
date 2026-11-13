import { PartyDetailResponseSchema } from '@app/party-registry/api/client';
import { Context, Effect, Layer, Option, Schema } from 'effect';

import type { ProfilePersistenceDependencies } from '../persistence/profile-persistence.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';
import type { RetailPartyResolutionExecutor } from './retail-party-detail-executor.ts';

type RetailPartyResolver = NonNullable<ProfilePersistenceDependencies['resolveRetailParty']>;
type RetailPartyResolution = Effect.Success<ReturnType<RetailPartyResolver>>;

export interface PartyRegistryRetailPartyResolverFactoryInput {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}

export interface PartyRegistryRetailPartyResolverFactoryService {
  readonly make: (
    input: PartyRegistryRetailPartyResolverFactoryInput,
    execute?: RetailPartyResolutionExecutor,
  ) => RetailPartyResolver;
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

/** Server-only owner read. The native preflight, never transactional persistence, calls this. */
export const makePartyRegistryRetailPartyResolver =
  (input: PartyRegistryRetailPartyResolverFactoryInput, execute: RetailPartyResolutionExecutor): RetailPartyResolver =>
  (request): ReturnType<RetailPartyResolver> => {
    if (
      request.tenantId !== input.tenantId ||
      request.actionInvocationId.trim().length === 0 ||
      !/^[a-f0-9]{64}$/u.test(request.compositionRevision) ||
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
      Effect.mapError((cause) => dependencyFailure('The Party Registry Party Detail operation is unavailable', cause)),
      Effect.flatMap((response): Effect.Effect<RetailPartyResolution, ProfilePersistenceDependencyFailure> => {
        if (!Schema.is(PartyDetailResponseSchema)(response)) {
          return Effect.fail(dependencyFailure('The Party Registry returned an invalid Party Detail outcome'));
        }
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
      }),
    );
  };

/** Party is read only for the Action's own actor; a composition without that transport fails closed. */
export const missingPartyTransport = () =>
  Effect.fail(dependencyFailure('The actor-bound Party Registry Party Detail transport is not composed'));

/** The failure every resolver reports when no matching invocation-scoped owner evidence was prepared. */
export const missingPreparedResolution = () =>
  dependencyFailure('No matching invocation-scoped Retail Party resolution is prepared');

/**
 * No default production path may acquire a remote credential while an Action transaction is open: without an
 * actor-bound executor (the in-transaction persistence path) it fails closed. Given the executor of the Action's own
 * actor, it reads Party once through it.
 */
export const partyRegistryRetailPartyResolverFactoryLive = Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
  make: (input, execute) =>
    execute === undefined
      ? () => Effect.fail(missingPreparedResolution())
      : makePartyRegistryRetailPartyResolver(input, execute),
});

import { ActionPermissionCheckError } from '@app/core-runtime';
import type { ActionAuthorizationPreflightService } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { PartyDetailResponseSchema, executePartyDetailWithAuthorization } from '@app/party-registry/api/client';
import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect';
import type { Scope } from 'effect';

import { EnsureRetailCustomerProfilePayloadSchema } from '../../shared/actions/ensure-retail-customer-profile.ts';
import { acquireRetailPartyGateway } from '../enrollment/journeys/retail-self-enrollment-party-owner.ts';
import type { ProfilePersistenceDependencies } from '../persistence/profile-persistence.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';

type RetailPartyResolver = NonNullable<ProfilePersistenceDependencies['resolveRetailParty']>;
type RetailPartyResolutionExecutor = (
  payload: Parameters<typeof executePartyDetailWithAuthorization>[0],
  requestCorrelation: string,
) => ReturnType<typeof executePartyDetailWithAuthorization>;
type RetailPartyResolution = Effect.Success<ReturnType<RetailPartyResolver>>;

export interface PartyRegistryRetailPartyResolverFactoryInput {
  readonly legalEntityId: string;
  readonly principalId: string;
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

/** Server-only owner read. The native preflight, never transactional persistence, calls this. */
export const makePartyRegistryRetailPartyResolver =
  (input: PartyRegistryRetailPartyResolverFactoryInput, execute?: RetailPartyResolutionExecutor): RetailPartyResolver =>
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
    const read =
      execute === undefined
        ? acquireRetailPartyGateway({
            compositionRevision: request.compositionRevision,
            legalEntityId: input.legalEntityId,
            requestCorrelation: input.requestCorrelation,
            tenantId: input.tenantId,
          }).pipe(
            Effect.flatMap(({ credential, options }) =>
              executePartyDetailWithAuthorization(
                { partyRef: requestedPartyRef },
                Redacted.value(credential),
                input.requestCorrelation,
                options,
              ),
            ),
          )
        : execute({ partyRef: requestedPartyRef }, input.requestCorrelation);
    return read.pipe(
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

const missingPreparedResolution = () =>
  dependencyFailure('No matching invocation-scoped Retail Party resolution is prepared');

/** No default production path may acquire a remote credential while an Action transaction is open. */
export const partyRegistryRetailPartyResolverFactoryLive = Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
  make: () => () => Effect.fail(missingPreparedResolution()),
});

export interface PreparedRetailPartyResolution {
  readonly clear: () => void;
  readonly factory: PartyRegistryRetailPartyResolverFactoryService;
  readonly preflight: ActionAuthorizationPreflightService;
}

const permissionUnavailable = (cause: unknown) =>
  new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    // Do not attach transport causes: they can retain bearer headers and request bodies.
    reason: Schema.is(ProfilePersistenceDependencyFailure)(cause)
      ? 'The current Retail Party owner evidence is unavailable'
      : 'The Retail Party preflight input or approved composition is unavailable',
  });
const sameScope = (
  left: PartyRegistryRetailPartyResolverFactoryInput,
  right: PartyRegistryRetailPartyResolverFactoryInput,
) =>
  left.tenantId === right.tenantId &&
  left.legalEntityId === right.legalEntityId &&
  left.principalId === right.principalId &&
  left.requestCorrelation === right.requestCorrelation;

/** Acquired once per native invocation; all HTTP finishes in prepare, before Core opens its transaction. */
export const preparedRetailPartyResolution: Effect.Effect<
  PreparedRetailPartyResolution,
  never,
  ActiveApplicationCompositionService | Scope.Scope
> = Effect.gen(function* prepareRetailPartyResolution() {
  const compositions = yield* ActiveApplicationCompositionService;
  let prepared: {
    readonly request: Parameters<RetailPartyResolver>[0];
    readonly result: RetailPartyResolution;
    readonly scope: PartyRegistryRetailPartyResolverFactoryInput;
  } | null = null;
  const execution: PreparedRetailPartyResolution = {
    clear: () => {
      prepared = null;
    },
    factory: {
      make: (scope) => (request) =>
        Effect.suspend(() => {
          const current = prepared;
          prepared = null;
          return current !== null &&
            sameScope(current.scope, scope) &&
            current.request.actionInvocationId === request.actionInvocationId &&
            current.request.compositionRevision === request.compositionRevision &&
            current.request.partyResourceId === request.partyResourceId &&
            current.request.tenantId === request.tenantId
            ? Effect.succeed(current.result)
            : Effect.fail(missingPreparedResolution());
        }),
    },
    preflight: {
      prepare: Effect.fn('RetailPartyResolution.prepare')(function* prepare(input) {
        prepared = null;
        if (input.actionKey !== 'commerce.customer-context.ensure-retail-customer-profile') {
          return { outcome: 'not_applicable' } as const;
        }
        const payload = yield* Schema.decodeUnknownEffect(EnsureRetailCustomerProfilePayloadSchema, {
          onExcessProperty: 'error',
        })(input.payload);
        const { legalEntityId } = input.scope;
        if (
          legalEntityId === undefined ||
          input.scope.tenantId !== input.principal.tenantId ||
          input.scope.principalId !== input.principal.principalId ||
          legalEntityId !== input.principal.legalEntityId ||
          input.correlationId !== input.scope.correlationId ||
          payload.subject.partyRef.tenantId !== input.scope.tenantId ||
          payload.subject.sellingLegalEntityRef.tenantId !== input.scope.tenantId ||
          payload.subject.sellingLegalEntityRef.resourceId !== legalEntityId
        ) {
          return { outcome: 'denied' } as const;
        }
        const active = yield* compositions.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
        const scope = {
          legalEntityId,
          principalId: input.principal.principalId,
          requestCorrelation: input.correlationId,
          tenantId: input.scope.tenantId,
        };
        const request = {
          actionInvocationId: input.actionInvocationId,
          compositionRevision: active.composition.revision,
          partyResourceId: payload.subject.partyRef.resourceId,
          tenantId: scope.tenantId,
        };
        const result = yield* makePartyRegistryRetailPartyResolver(scope)(request);
        prepared = { request, result, scope };
        // Owner evidence is not a grant: ordinary native Action authorization still applies.
        return { outcome: 'not_applicable' } as const;
      }, Effect.mapError(permissionUnavailable)),
    },
  };
  yield* Effect.addFinalizer(() => Effect.sync(execution.clear));
  return execution;
});

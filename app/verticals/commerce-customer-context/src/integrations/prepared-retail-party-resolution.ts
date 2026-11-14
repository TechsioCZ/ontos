import { ActionPermissionCheckError } from '@app/core-runtime';
import type { ActionAuthorizationPreflightService } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { Effect, Option, Schema } from 'effect';
import type { Scope } from 'effect';

import { EnsureRetailCustomerProfilePayloadSchema } from '../../shared/actions/ensure-retail-customer-profile.ts';
import type { ProfilePersistenceDependencies } from '../persistence/profile-persistence.ts';
import { ProfilePersistenceDependencyFailure } from '../persistence/profile-persistence.ts';
import {
  missingPartyTransport,
  missingPreparedResolution,
  PartyRegistryRetailPartyResolverFactory,
} from './party-registry-retail-party-resolver.ts';
import type {
  PartyRegistryRetailPartyResolverFactoryInput,
  PartyRegistryRetailPartyResolverFactoryService,
} from './party-registry-retail-party-resolver.ts';
import { RetailPartyDetailExecutor } from './retail-party-detail-executor.ts';
import type { RetailPartyResolutionExecutor } from './retail-party-detail-executor.ts';

type RetailPartyResolver = NonNullable<ProfilePersistenceDependencies['resolveRetailParty']>;
type RetailPartyResolution = Effect.Success<ReturnType<RetailPartyResolver>>;

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
const notApplicable = { outcome: 'not_applicable' } as const;
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
  ActiveApplicationCompositionService | PartyRegistryRetailPartyResolverFactory | Scope.Scope
> = Effect.gen(function* prepareRetailPartyResolution() {
  const transport = yield* Effect.serviceOption(RetailPartyDetailExecutor);
  // The deployment's owner read: given the Action's own actor-bound executor it reads Party once through it.
  const ownerRead = yield* PartyRegistryRetailPartyResolverFactory;
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
      // Prepared evidence is consumed once. Without a match, only a caller holding the Action's own actor-bound
      // executor reads Party itself; every other caller (the in-transaction persistence path) fails closed.
      make: (scope, execute) => (request) =>
        Effect.suspend(() => {
          const current = prepared;
          prepared = null;
          if (
            current !== null &&
            sameScope(current.scope, scope) &&
            current.request.actionInvocationId === request.actionInvocationId &&
            current.request.compositionRevision === request.compositionRevision &&
            current.request.partyResourceId === request.partyResourceId &&
            current.request.tenantId === request.tenantId
          ) {
            return Effect.succeed(current.result);
          }
          return execute === undefined
            ? Effect.fail(missingPreparedResolution())
            : ownerRead.make(scope, execute)(request);
        }),
    },
    preflight: {
      prepare: Effect.fn('RetailPartyResolution.prepare')(function* prepare(input) {
        prepared = null;
        if (input.actionKey !== 'commerce.customer-context.ensure-retail-customer-profile') {
          return notApplicable;
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
        // A source Ensure proves its Party through the source PERSON admission in the owner transaction (bound to the
        // workload's own principal), never through this actor-bound Retail read, so it prepares no Party evidence.
        if (payload.source !== undefined) {
          return notApplicable;
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
        if (Option.isNone(transport)) {
          return yield* missingPartyTransport();
        }
        const execute: RetailPartyResolutionExecutor = (detailRequest, correlation) =>
          transport.value.execute(detailRequest, correlation, {
            actionInvocationId: input.actionInvocationId,
            compositionRevision: active.composition.revision,
            scope: input.scope,
          });
        const result = yield* ownerRead.make(scope, execute)(request);
        prepared = { request, result, scope };
        // Owner evidence is not a grant: ordinary native Action authorization still applies.
        return notApplicable;
      }, Effect.mapError(permissionUnavailable)),
    },
  };
  yield* Effect.addFinalizer(() => Effect.sync(execution.clear));
  return execution;
});

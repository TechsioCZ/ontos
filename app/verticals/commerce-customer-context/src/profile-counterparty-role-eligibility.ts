import { ActiveApplicationCompositionService, validateActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import {
  CounterpartyReadResponseSchema,
  executeCounterpartyReadWithAuthorization,
} from '@app/party-registry/api/client';
import type { executeCounterpartyRead } from '@app/party-registry/api/client';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { Config, Context, DateTime, Effect, Layer, Option, Schema } from 'effect';

import { ProfilePersistenceDependencyFailure } from './persistence/profile-persistence.ts';
import type { CounterpartyRoleEligibility, ProfilePersistenceDependencies } from './persistence/profile-persistence.ts';

type CounterpartyReadExecutor = typeof executeCounterpartyRead;
type CounterpartyRoleEligibilityResolver = NonNullable<ProfilePersistenceDependencies['resolveCounterpartyRole']>;

export interface ProfileCounterpartyRoleEligibilityScope {
  readonly legalEntityId: string;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}

const dependencyFailure = (reason: string, cause?: unknown): ProfilePersistenceDependencyFailure => {
  const failure = new ProfilePersistenceDependencyFailure({ reason });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const serverConfiguration = Config.all({
  apiKey: Config.Redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  shellBaseUrl: Config.schema(
    Schema.URLFromString.check(
      Schema.makeFilter((url) =>
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        url.search.length === 0 &&
        url.hash.length === 0
          ? undefined
          : 'Shell gateway URL must be HTTP(S) without credentials, query, or fragment',
      ),
    ),
    'ONTOS_SHELL_GATEWAY_BASE_URL',
  ),
});

const executeServerCounterpartyRead = Effect.fn('ProfileCounterpartyRoleEligibility.executeServerCounterpartyRead')(
  function* serverCounterpartyRead(
    scope: ProfileCounterpartyRoleEligibilityScope,
    payload: Parameters<CounterpartyReadExecutor>[0],
  ) {
    const composition = yield* Effect.serviceOption(ActiveApplicationCompositionService);
    if (Option.isNone(composition)) {
      return yield* dependencyFailure('The server Application Composition authority is unavailable');
    }
    const active = yield* composition.value.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
    const configured = yield* serverConfiguration;
    const compositionRevision = active.composition.revision;
    const issued = yield* issueApiKeyGatewayContext(
      { audience: 'party-registry', compositionRevision, legalEntityId: scope.legalEntityId },
      { apiKey: configured.apiKey, baseUrl: configured.shellBaseUrl, requestCorrelation: scope.requestCorrelation },
    );
    if (issued.compositionRevision !== compositionRevision) {
      return yield* dependencyFailure('The Party credential does not match the active composition revision');
    }
    yield* validateActiveApplicationCompositionSnapshot(active);
    return yield* executeCounterpartyReadWithAuthorization(
      payload,
      `Bearer ${issued.token}`,
      scope.requestCorrelation,
      { baseUrl: new URL(issued.apiBaseUrl, configured.shellBaseUrl), compositionRevision },
    );
  },
);

const isCanonicalInstant = (value: string): boolean => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value;
};

type CounterpartyReadResponse = Schema.Schema.Type<typeof CounterpartyReadResponseSchema>;
type CounterpartyRole = CounterpartyReadResponse['currentRoles'][number];

const indeterminateEligibility = (): CounterpartyRoleEligibility => ({ outcome: 'INDETERMINATE' });
const ineligibleEligibility = (): CounterpartyRoleEligibility => ({ outcome: 'INELIGIBLE' });

const hasExactTenantEvidence = (
  response: CounterpartyReadResponse,
  scope: ProfileCounterpartyRoleEligibilityScope,
  counterpartyResourceId: string,
): boolean =>
  response.counterpartyRef.tenantId === scope.tenantId &&
  response.counterpartyRef.resourceId === counterpartyResourceId &&
  response.party.canonicalPartyRef.tenantId === scope.tenantId &&
  response.party.storedPartyRef.tenantId === scope.tenantId &&
  response.currentRoles.every(({ rolePeriodRef }) => rolePeriodRef.tenantId === scope.tenantId);

const isEligibleCustomerRole = (role: CounterpartyRole, now: string): boolean =>
  role.roleType === 'CUSTOMER' &&
  role.state === 'ACTIVE' &&
  role.validFrom <= now &&
  (role.validTo === null || role.validTo > now);

const classifyEligibleRoles = (
  eligibleRoles: readonly CounterpartyRole[],
  managedLegalEntityId: string,
  now: string,
): CounterpartyRoleEligibility => {
  if (eligibleRoles.length === 0) {
    return ineligibleEligibility();
  }
  const [eligibleRole] = eligibleRoles;
  if (
    eligibleRoles.length !== 1 ||
    eligibleRole === undefined ||
    !isCanonicalInstant(eligibleRole.recordedAt) ||
    eligibleRole.recordedAt > now
  ) {
    return indeterminateEligibility();
  }

  return {
    managedLegalEntityId,
    outcome: 'ELIGIBLE',
    roleResourceId: eligibleRole.rolePeriodRef.resourceId,
    // Role periods are immutable owner facts. Party Registry currently publishes their canonical
    // recordedAt instant, rather than a synthetic numeric revision, as the evidence version.
    roleResourceRevision: eligibleRole.recordedAt,
  };
};

export const classifyProfileCounterpartyRoleEligibility = (
  response: CounterpartyReadResponse,
  scope: ProfileCounterpartyRoleEligibilityScope,
  counterpartyResourceId: string,
  now: string,
): CounterpartyRoleEligibility => {
  const exactManagedLegalEntity =
    response.legalEntityRef.tenantId === scope.tenantId && response.legalEntityRef.resourceId === scope.legalEntityId;

  if (!hasExactTenantEvidence(response, scope, counterpartyResourceId)) {
    return indeterminateEligibility();
  }
  if (!exactManagedLegalEntity || response.party.archived) {
    return ineligibleEligibility();
  }

  return classifyEligibleRoles(
    response.currentRoles.filter((role) => isEligibleCustomerRole(role, now)),
    response.legalEntityRef.resourceId,
    now,
  );
};

/**
 * Builds the Commerce adapter over Party Registry's governed Counterparty Read. The scope is
 * captured from trusted operation context; neither the Action payload nor the Party response can
 * replace its Tenant or managed Legal Entity.
 */
export const makeProfileCounterpartyRoleEligibilityResolver =
  (
    scope: ProfileCounterpartyRoleEligibilityScope,
    execute?: CounterpartyReadExecutor,
  ): CounterpartyRoleEligibilityResolver =>
  ({ counterpartyResourceId, tenantId }) => {
    if (tenantId !== scope.tenantId) {
      return Effect.succeed({ outcome: 'INDETERMINATE' as const });
    }

    const payload: Parameters<CounterpartyReadExecutor>[0] = {
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: counterpartyResourceId,
        resourceType: 'party.registry.counterparty',
        tenantId: scope.tenantId,
      },
    };
    const read: Effect.Effect<
      CounterpartyReadResponse,
      | Effect.Error<ReturnType<typeof executeServerCounterpartyRead>>
      | Effect.Error<ReturnType<CounterpartyReadExecutor>>
    > =
      execute === undefined
        ? executeServerCounterpartyRead(scope, payload)
        : execute(payload, scope.requestCorrelation);
    return read.pipe(
      Effect.mapError((cause) => dependencyFailure('Party Registry Counterparty eligibility is unavailable', cause)),
      Effect.flatMap((response) =>
        DateTime.now.pipe(
          Effect.map(DateTime.formatIso),
          Effect.map((now) =>
            Schema.is(CounterpartyReadResponseSchema)(response) && isCanonicalInstant(now)
              ? classifyProfileCounterpartyRoleEligibility(response, scope, counterpartyResourceId, now)
              : ({ outcome: 'INDETERMINATE' } as const),
          ),
        ),
      ),
    );
  };

export interface ProfileCounterpartyRoleEligibilityResolverFactoryService {
  readonly make: (
    scope: ProfileCounterpartyRoleEligibilityScope,
    execute?: CounterpartyReadExecutor,
  ) => CounterpartyRoleEligibilityResolver;
}

export class ProfileCounterpartyRoleEligibilityResolverFactory extends Context.Service<
  ProfileCounterpartyRoleEligibilityResolverFactory,
  ProfileCounterpartyRoleEligibilityResolverFactoryService
>()(
  '@app/commerce-customer-context/profile-counterparty-role-eligibility/ProfileCounterpartyRoleEligibilityResolverFactory',
) {}

export const profileCounterpartyRoleEligibilityResolverFactoryLive = Layer.succeed(
  ProfileCounterpartyRoleEligibilityResolverFactory,
  Object.freeze({ make: makeProfileCounterpartyRoleEligibilityResolver }),
);

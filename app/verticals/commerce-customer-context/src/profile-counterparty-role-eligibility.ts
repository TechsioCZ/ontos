import { ActiveApplicationCompositionService, validateActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import {
  CounterpartyReadResponseSchema,
  executeCounterpartyReadWithAuthorization,
} from '@app/party-registry/api/client';
import type { executeCounterpartyRead } from '@app/party-registry/api/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, DateTime, Effect, Layer, Option, Schema } from 'effect';

import { ProfilePersistenceDependencyFailure } from './persistence/profile-persistence.ts';
import type { CounterpartyRoleEligibility, ProfilePersistenceDependencies } from './persistence/profile-persistence.ts';

type CounterpartyReadExecutor = typeof executeCounterpartyRead;
type CounterpartyRoleEligibilityResolver = NonNullable<ProfilePersistenceDependencies['resolveCounterpartyRole']>;
type DelegatedGatewayAcquisition = typeof acquireDelegatedGatewayContext;
/** Seams for the Shell-issued admission and the Party read; production omits `execute`. */
export interface ProfileCounterpartyRoleEligibilitySeams {
  readonly acquire: DelegatedGatewayAcquisition;
  readonly crypto: Crypto.Crypto;
  readonly execute?: CounterpartyReadExecutor | undefined;
}

/** The Tenant and managed Legal Entity that classify Party evidence; the admission scope is not needed to classify. */
type ProfileCounterpartyRoleEligibilityBoundary = Pick<
  ProfileCounterpartyRoleEligibilityScope,
  'legalEntityId' | 'tenantId'
>;

export interface ProfileCounterpartyRoleEligibilityScope {
  readonly legalEntityId: string;
  /** The verified request scope; the Customer whose eligibility is read is its subject. */
  readonly operationalScope: OperationalScope;
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

const executeServerCounterpartyRead = Effect.fn('ProfileCounterpartyRoleEligibility.executeServerCounterpartyRead')(
  function* serverCounterpartyRead(
    scope: ProfileCounterpartyRoleEligibilityScope,
    seams: ProfileCounterpartyRoleEligibilitySeams,
    payload: Parameters<CounterpartyReadExecutor>[0],
  ) {
    const composition = yield* Effect.serviceOption(ActiveApplicationCompositionService);
    if (Option.isNone(composition)) {
      return yield* dependencyFailure('The server Application Composition authority is unavailable');
    }
    const active = yield* composition.value.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
    const compositionRevision = active.composition.revision;
    const issued = yield* seams
      .acquire(
        {
          audience: 'party-registry',
          callingAppId: 'commerce-customer-context',
          legalEntityScope: 'subject',
          requestCorrelation: scope.requestCorrelation,
          subject: { _tag: 'Assertion', scope: scope.operationalScope },
        },
        seams.crypto,
      )
      .pipe(Effect.mapError((cause) => dependencyFailure('The Party credential could not be issued', cause)));
    if (issued.compositionRevision !== compositionRevision) {
      return yield* dependencyFailure('The Party credential does not match the active composition revision');
    }
    yield* validateActiveApplicationCompositionSnapshot(active);
    return yield* executeCounterpartyReadWithAuthorization(payload, issued.authorization, scope.requestCorrelation, {
      baseUrl: new URL(issued.apiBaseUrl),
      compositionRevision,
    });
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
  scope: ProfileCounterpartyRoleEligibilityBoundary,
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
    observedAt: now,
    outcome: 'ELIGIBLE',
    roleResourceId: eligibleRole.rolePeriodRef.resourceId,
    // Role periods are immutable owner facts. Party Registry currently publishes their canonical
    // recordedAt instant, rather than a synthetic numeric revision, as the evidence version.
    roleResourceRevision: eligibleRole.recordedAt,
    validUntil: DateTime.formatIso(
      DateTime.makeUnsafe(
        Math.min(
          DateTime.toEpochMillis(DateTime.makeUnsafe(now)) + 30_000,
          eligibleRole.validTo === null ? Infinity : DateTime.toEpochMillis(DateTime.makeUnsafe(eligibleRole.validTo)),
        ),
      ),
    ),
  };
};

export const classifyProfileCounterpartyRoleEligibility = (
  response: CounterpartyReadResponse,
  scope: ProfileCounterpartyRoleEligibilityBoundary,
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
    seams: ProfileCounterpartyRoleEligibilitySeams,
  ): CounterpartyRoleEligibilityResolver =>
  ({ counterpartyResourceId, tenantId }) => {
    if (
      tenantId !== scope.tenantId ||
      scope.operationalScope.tenantId !== scope.tenantId ||
      scope.operationalScope.legalEntityId !== scope.legalEntityId
    ) {
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
      seams.execute === undefined
        ? executeServerCounterpartyRead(scope, seams, payload)
        : seams.execute(payload, scope.requestCorrelation);
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

/** A prepared observation is usable only inside its exclusive owner-evidence window. */
export const assertPreparedCounterpartyRoleCurrent = Effect.fn(
  'ProfileCounterpartyRoleEligibility.assertPreparedCurrent',
)(function* assertPreparedCurrent(role: CounterpartyRoleEligibility) {
  if (role.outcome !== 'ELIGIBLE') {
    return yield* Effect.void;
  }
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (
    role.observedAt === undefined ||
    !isCanonicalInstant(role.observedAt) ||
    role.validUntil === undefined ||
    role.validUntil === null ||
    !isCanonicalInstant(role.validUntil) ||
    now < DateTime.toEpochMillis(DateTime.makeUnsafe(role.observedAt)) ||
    now >= DateTime.toEpochMillis(DateTime.makeUnsafe(role.validUntil)) ||
    DateTime.toEpochMillis(DateTime.makeUnsafe(role.validUntil)) >
      DateTime.toEpochMillis(DateTime.makeUnsafe(role.observedAt)) + 30_000
  ) {
    return yield* dependencyFailure('The prepared Counterparty customer-role observation is absent or expired');
  }
  return yield* Effect.void;
});

/** Check before and after mutation so expiration cannot commit a partially authorized write. */
export const withPreparedCounterpartyRoleCurrent = <Value, Failure, Requirements>(
  role: CounterpartyRoleEligibility,
  operation: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, Failure | ProfilePersistenceDependencyFailure, Requirements> =>
  assertPreparedCounterpartyRoleCurrent(role).pipe(
    Effect.andThen(operation),
    Effect.tap(() => assertPreparedCounterpartyRoleCurrent(role)),
  );

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

export const profileCounterpartyRoleEligibilityResolverFactoryLive = Layer.effect(
  ProfileCounterpartyRoleEligibilityResolverFactory,
  Effect.gen(function* makeProfileCounterpartyRoleEligibilityResolverFactory() {
    const crypto = yield* Crypto.Crypto;
    return Object.freeze({
      make: (scope: ProfileCounterpartyRoleEligibilityScope, execute?: CounterpartyReadExecutor) =>
        makeProfileCounterpartyRoleEligibilityResolver(scope, {
          acquire: acquireDelegatedGatewayContext,
          crypto,
          execute,
        }),
    });
  }),
);

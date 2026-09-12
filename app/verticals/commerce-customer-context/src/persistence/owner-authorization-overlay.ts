import type {
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  OwnerAuthorizationTarget,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { OwnerAuthorizationOverlay } from '@app/core-runtime';
import { Effect, Layer, Option, Result, Schema } from 'effect';

import {
  CounterpartyRefSchema,
  PrincipalRefSchema as CounterpartyPrincipalRefSchema,
} from '../../shared/domain/access-contract.ts';
import type { CounterpartyPermissionScope } from '../../shared/domain/access-contract.ts';
import { CounterpartyPermissionCodeSchema } from '../../shared/domain/permission-catalog.ts';
import { RetailAccessDecisionRequestSchema } from '../../shared/apis/retail-access-decision.ts';
import { RetailCustomerProfileRefSchema } from '../../shared/resources/retail-customer-profile.ts';
import { RetailPortalPermissionCodeSchema } from '../../shared/domain/profile-contracts.ts';
import { ProfileRetailPermissionReaderFactory } from '../integrations/retail-permission-reader.ts';
import { lockingCurrentOwnerAccessForTransaction } from './access-persistence.ts';
import { profilePersistenceServicesForTransaction } from './profile-persistence.ts';

const ownerDecision = (decision: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE'): OwnerAuthorizationDecision => {
  if (decision === 'ALLOWED') {
    return 'allowed';
  }
  if (decision === 'DENIED') {
    return 'denied';
  }
  return 'unavailable';
};

/** Positive-union semantics: a current ACTIVE owner grant wins over narrower stale rows. */
const combineOwnerDecisions = (decisions: readonly OwnerAuthorizationDecision[]): OwnerAuthorizationDecision => {
  if (decisions.length === 0) {
    return 'allowed';
  }
  if (decisions.some((decision) => decision === 'allowed')) {
    return 'allowed';
  }
  if (decisions.some((decision) => decision === 'unavailable')) {
    return 'unavailable';
  }
  return 'denied';
};

interface DecodedCounterpartyTarget {
  readonly counterpartyRef: typeof CounterpartyRefSchema.Type;
  readonly permission: typeof CounterpartyPermissionCodeSchema.Type;
  readonly permissionScope: CounterpartyPermissionScope;
  readonly principal: typeof CounterpartyPrincipalRefSchema.Type;
}
type BusinessPermissionTarget = Extract<OwnerAuthorizationTarget, { readonly kind: 'business_permission' }>;
type CounterpartyBusinessTarget = Exclude<BusinessPermissionTarget['target'], { readonly kind: 'retail_profile' }>;

const counterpartyTargetMatchesScope = (
  target: CounterpartyBusinessTarget,
  trustedStorefrontId: BusinessPermissionTarget['trustedStorefrontId'],
  scope: OwnerAuthorizationInput['scope'],
): boolean =>
  scope.legalEntityId !== undefined &&
  target.tenantId === scope.tenantId &&
  target.legalEntityId === scope.legalEntityId &&
  (target.kind === 'counterparty' ||
    (target.storefrontId === scope.trustedStorefrontId && trustedStorefrontId === target.storefrontId));

const decodeCounterpartyTargetValues = (
  target: CounterpartyBusinessTarget,
  permissionCode: BusinessPermissionTarget['permission'],
  scope: OwnerAuthorizationInput['scope'],
): Option.Option<DecodedCounterpartyTarget> => {
  const permission = Schema.decodeUnknownResult(CounterpartyPermissionCodeSchema)(permissionCode);
  const counterpartyRef = Schema.decodeResult(CounterpartyRefSchema)({
    moduleId: 'party.registry',
    resourceId: target.counterpartyId,
    resourceType: 'party.registry.counterparty',
    tenantId: target.tenantId,
  });
  const principal = Schema.decodeResult(CounterpartyPrincipalRefSchema)({
    principalId: scope.principalId,
    tenantId: scope.tenantId,
  });
  if (Result.isFailure(permission) || Result.isFailure(counterpartyRef) || Result.isFailure(principal)) {
    return Option.none();
  }
  return Option.some({
    counterpartyRef: counterpartyRef.success,
    permission: permission.success,
    permissionScope:
      target.kind === 'counterparty'
        ? { kind: 'counterparty' }
        : { kind: 'storefront', storefrontKey: target.storefrontId },
    principal: principal.success,
  });
};

const decodeCounterpartyTarget = (
  target: Extract<OwnerAuthorizationTarget, { readonly kind: 'business_permission' }>,
  scope: OwnerAuthorizationInput['scope'],
): Effect.Effect<Option.Option<DecodedCounterpartyTarget>> => {
  if (target.target.kind === 'retail_profile') {
    return Effect.succeedNone;
  }
  if (!counterpartyTargetMatchesScope(target.target, target.trustedStorefrontId, scope)) {
    return Effect.succeedNone;
  }
  return Effect.succeed(decodeCounterpartyTargetValues(target.target, target.permission, scope));
};

const checkCounterpartyTarget = (
  transaction: ScopedTransactionExecutor,
  target: Extract<OwnerAuthorizationTarget, { readonly kind: 'business_permission' }>,
  scope: OwnerAuthorizationInput['scope'],
): Effect.Effect<OwnerAuthorizationDecision> =>
  decodeCounterpartyTarget(target, scope).pipe(
    Effect.flatMap((decoded) => {
      if (Option.isNone(decoded) || scope.legalEntityId === undefined) {
        return Effect.succeed('unavailable' as const);
      }
      return lockingCurrentOwnerAccessForTransaction(transaction, {
        legalEntityId: scope.legalEntityId,
        tenantId: scope.tenantId,
      })({
        counterpartyRef: decoded.value.counterpartyRef,
        legalEntityId: scope.legalEntityId,
        permission: decoded.value.permission,
        principal: decoded.value.principal,
        scope: decoded.value.permissionScope,
      }).pipe(
        Effect.map(ownerDecision),
        Effect.orElseSucceed(() => 'unavailable' as const),
      );
    }),
  );

const checkRetailTarget = (
  transaction: ScopedTransactionExecutor,
  target: Extract<OwnerAuthorizationTarget, { readonly kind: 'business_permission' }>,
  scope: OwnerAuthorizationInput['scope'],
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- The pure helper is also exercised with a deterministic reader factory in unit tests.
  readerFactory: (typeof ProfileRetailPermissionReaderFactory)['Service'],
): Effect.Effect<OwnerAuthorizationDecision> => {
  if (
    target.target.kind !== 'retail_profile' ||
    scope.legalEntityId === undefined ||
    target.target.tenantId !== scope.tenantId ||
    target.target.legalEntityId !== scope.legalEntityId
  ) {
    return Effect.succeed('unavailable' as const);
  }
  const request = Schema.decodeUnknownResult(RetailAccessDecisionRequestSchema)({
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: target.target.profileId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: target.target.tenantId,
    },
    requiredPermission: target.permission,
  });
  if (Result.isFailure(request)) {
    return Effect.succeed('unavailable' as const);
  }
  const profileRef = Schema.decodeResult(RetailCustomerProfileRefSchema)(request.success.profileRef);
  const permission = Schema.decodeResult(RetailPortalPermissionCodeSchema)(request.success.requiredPermission);
  if (Result.isFailure(profileRef) || Result.isFailure(permission)) {
    return Effect.succeed('unavailable' as const);
  }
  const services = profilePersistenceServicesForTransaction(
    transaction,
    {
      legalEntityId: scope.legalEntityId,
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    },
    {
      readRetailPermissions: readerFactory.make({
        legalEntityId: scope.legalEntityId,
        principalId: scope.principalId,
        tenantId: scope.tenantId,
      }),
    },
  );
  return services.retailAccessDecision
    .decideAccess(
      {
        profileRef: profileRef.success,
        requiredPermission: permission.success,
      },
      scope.principalId,
      scope.tenantId,
    )
    .pipe(
      Effect.map(({ decision }) => {
        if (decision.allowed) {
          return 'allowed' as const;
        }
        if (decision.outcome === 'AUTHORIZATION_UNAVAILABLE') {
          return 'unavailable' as const;
        }
        return 'denied' as const;
      }),
      Effect.orElseSucceed(() => 'unavailable' as const),
    );
};

export const makeCommerceCustomerContextOwnerAuthorizationOverlay = (
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- The pure helper is also exercised with a deterministic reader factory in unit tests.
  readerFactory: (typeof ProfileRetailPermissionReaderFactory)['Service'],
): OwnerAuthorizationOverlayService => ({
  authorize: (transaction, input) =>
    Effect.forEach(
      input.targets,
      (target) => {
        if (target.kind !== 'business_permission') {
          return Effect.succeed(Option.none<OwnerAuthorizationDecision>());
        }
        if (target.target.kind === 'retail_profile') {
          return checkRetailTarget(transaction, target, input.scope, readerFactory).pipe(Effect.asSome);
        }
        return checkCounterpartyTarget(transaction, target, input.scope).pipe(Effect.asSome);
      },
      { concurrency: 1 },
    ).pipe(
      Effect.map((decisions) =>
        combineOwnerDecisions(decisions.flatMap((decision) => (Option.isSome(decision) ? [decision.value] : []))),
      ),
    ),
});

export const commerceCustomerContextOwnerAuthorizationOverlayLive = Layer.effect(
  OwnerAuthorizationOverlay,
  Effect.gen(function* makeCommerceCustomerContextOwnerAuthorizationOverlayLive() {
    const readerFactory = yield* ProfileRetailPermissionReaderFactory;
    return makeCommerceCustomerContextOwnerAuthorizationOverlay(readerFactory);
  }),
);

import type {
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { OwnerAuthorizationOverlay } from '@app/core-runtime';
import { Effect, Layer, Result, Schema } from 'effect';

import {
  CounterpartyRefSchema,
  PrincipalRefSchema as CounterpartyPrincipalRefSchema,
} from '../../shared/domain/access-contract.ts';
import { COUNTERPARTY_PERMISSION_CODES, permissionDescriptor } from '../../shared/domain/permission-catalog.ts';
import type { CounterpartyPermissionCode } from '../../shared/domain/permission-catalog.ts';
import { RetailAccessDecisionRequestSchema } from '../../shared/apis/retail-access-decision.ts';
import { RetailCustomerProfileRefSchema } from '../../shared/resources/retail-customer-profile.ts';
import { RetailPortalPermissionCodeSchema } from '../../shared/domain/profile-contracts.ts';
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

/**
 * O70: Core passes the owner's own fact bag (`accessOwnerFacts`) into the overlay unchanged. It is
 * computed from the payload by the descriptor, never supplied by the caller (O64), and it never
 * reaches the decision engine.
 */
const OWNER_FACT_COUNTERPARTY = 'counterpartyId';
const OWNER_FACT_RETAIL_PERMISSION = 'retailPermission';
const OWNER_FACT_RETAIL_PROFILE = 'retailProfileId';
const OWNER_FACT_STOREFRONT = 'storefrontId';

/** The owner-local Counterparty Permission a profile-reading capability needs (O67-Q1). */
const COUNTERPARTY_PROFILE_READ: CounterpartyPermissionCode = 'counterparty.profile.read';

/**
 * The owner-local Counterparty Permission each protected entrypoint needs (O67-Q1). It is read from
 * the owner's own Permission catalogue, so a capability that needs a Counterparty grant can never
 * be satisfied by the v2 capability alone.
 *
 * R5b-1: a handful of counterparty-governed entrypoints are not yet published in the catalogue, so
 * their owner permission is stated here explicitly. Every counterparty-governed operation must be
 * mapped; `decideOwnerFacts` default-denies a Counterparty fact with no mapping, so an unpublished
 * operation can never fall through to the scope-wide capability (O67-Q1, O70).
 */
const unpublishedCounterpartyOperationPermissions: readonly (readonly [string, CounterpartyPermissionCode])[] = [
  ['commerce.customer-context.api.customer-payment-term-entitlement-read', COUNTERPARTY_PROFILE_READ],
  ['commerce.customer-context.api.payment-terms-resolution', COUNTERPARTY_PROFILE_READ],
  ['commerce.customer-context.api.customer-price-group-assignment-read', COUNTERPARTY_PROFILE_READ],
  ['commerce.customer-context.api.customer-price-group-resolution', COUNTERPARTY_PROFILE_READ],
  ['commerce.customer-context.api.order-commitment-approval-evidence', 'counterparty.purchase.submit'],
];

export const counterpartyPermissionByOperation: ReadonlyMap<string, CounterpartyPermissionCode> = new Map([
  ...COUNTERPARTY_PERMISSION_CODES.flatMap((permission) =>
    permissionDescriptor(permission).protectedEntrypoints.map((entrypoint) => [entrypoint, permission] as const),
  ),
  ...unpublishedCounterpartyOperationPermissions,
]);

/** One owner-local Counterparty grant check for the fact the descriptor published (O70). */
const checkCounterpartyFacts = (
  transaction: ScopedTransactionExecutor,
  input: OwnerAuthorizationInput,
  facts: Readonly<Record<string, string>>,
  permission: CounterpartyPermissionCode,
): Effect.Effect<OwnerAuthorizationDecision> => {
  const counterpartyId = facts[OWNER_FACT_COUNTERPARTY];
  const storefrontId = facts[OWNER_FACT_STOREFRONT];
  const counterpartyRef = Schema.decodeResult(CounterpartyRefSchema)({
    moduleId: 'party.registry',
    resourceId: counterpartyId ?? '',
    resourceType: 'party.registry.counterparty',
    tenantId: input.scope.tenantId,
  });
  const principal = Schema.decodeResult(CounterpartyPrincipalRefSchema)({
    principalId: input.scope.principalId,
    tenantId: input.scope.tenantId,
  });
  if (Result.isFailure(counterpartyRef) || Result.isFailure(principal)) {
    // A capability that needs a Counterparty grant cannot be decided without the Counterparty it
    // acts on; a missing or malformed fact is a denial (O70).
    return Effect.succeed('denied' as const);
  }
  const { legalEntityId } = input.scope;
  if (legalEntityId === undefined) {
    return Effect.succeed('unavailable' as const);
  }
  return lockingCurrentOwnerAccessForTransaction(transaction, { legalEntityId, tenantId: input.scope.tenantId })({
    counterpartyRef: counterpartyRef.success,
    legalEntityId,
    permission,
    principal: principal.success,
    scope:
      storefrontId === undefined
        ? { kind: 'counterparty' as const }
        : { kind: 'storefront' as const, storefrontKey: storefrontId },
  }).pipe(
    Effect.map(ownerDecision),
    Effect.orElseSucceed(() => 'unavailable' as const),
  );
};

/** The Retail Portal Self-Service limit: the bound profile's own durable authorization state. */
const checkRetailFacts = (
  transaction: ScopedTransactionExecutor,
  input: OwnerAuthorizationInput,
  facts: Readonly<Record<string, string>>,
): Effect.Effect<OwnerAuthorizationDecision> => {
  const profileId = facts[OWNER_FACT_RETAIL_PROFILE];
  const requiredPermission = facts[OWNER_FACT_RETAIL_PERMISSION];
  const { legalEntityId } = input.scope;
  if (profileId === undefined || requiredPermission === undefined || legalEntityId === undefined) {
    return Effect.succeed('denied' as const);
  }
  const request = Schema.decodeUnknownResult(RetailAccessDecisionRequestSchema)({
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: profileId,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: input.scope.tenantId,
    },
    requiredPermission,
  });
  if (Result.isFailure(request)) {
    return Effect.succeed('denied' as const);
  }
  const profileRef = Schema.decodeResult(RetailCustomerProfileRefSchema)(request.success.profileRef);
  const permission = Schema.decodeResult(RetailPortalPermissionCodeSchema)(request.success.requiredPermission);
  if (Result.isFailure(profileRef) || Result.isFailure(permission)) {
    return Effect.succeed('denied' as const);
  }
  const services = profilePersistenceServicesForTransaction(transaction, {
    legalEntityId,
    principalId: input.scope.principalId,
    tenantId: input.scope.tenantId,
  });
  return services.retailAccessDecision
    .decideAccess(
      { profileRef: profileRef.success, requiredPermission: permission.success },
      input.scope.principalId,
      input.scope.tenantId,
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

/**
 * Facts are the v2 carrier (O70). The decision reads ccc's own Postgres state only — the v2 gate has
 * already decided the capability itself, and there is no second permission store (O62).
 */
const decideOwnerFacts = (
  transaction: ScopedTransactionExecutor,
  input: OwnerAuthorizationInput,
  facts: Readonly<Record<string, string>>,
): Effect.Effect<OwnerAuthorizationDecision> => {
  if (facts[OWNER_FACT_RETAIL_PROFILE] !== undefined || facts[OWNER_FACT_RETAIL_PERMISSION] !== undefined) {
    return checkRetailFacts(transaction, input, facts);
  }
  if (facts[OWNER_FACT_COUNTERPARTY] !== undefined) {
    const permission = counterpartyPermissionByOperation.get(input.operationKey);
    // R5b-1: a Counterparty-governed operation the owner has not mapped is denied, never allowed.
    // Falling through to the scope-wide capability would let a buyer with the read's capability
    // read another counterparty's profile data by naming its ids (O67-Q1, O70).
    return permission === undefined
      ? Effect.succeed('denied' as const)
      : checkCounterpartyFacts(transaction, input, facts, permission);
  }
  // A non-empty fact bag that names neither a Counterparty nor a Retail record is not an
  // owner-neutral read: only an explicitly empty bag (a descriptor that published no governed
  // record, handled in `authorize`) is owner-neutral. Anything else fails closed (O70).
  return Effect.succeed('denied' as const);
};

export const makeCommerceCustomerContextOwnerAuthorizationOverlay = (): OwnerAuthorizationOverlayService => ({
  authorize: (transaction, input) => {
    // O70: Core computes the owner's fact bag from the descriptor and passes it unchanged; the
    // caller never supplies it (O64) and it never reaches the decision engine.
    const facts = input.ownerFacts;
    if (facts === undefined) {
      // A capability that needs a Counterparty grant cannot be decided without its owner facts, so
      // a descriptor that declares no resolver denies instead of falling back to the scope-wide
      // capability (O70, fail closed).
      return Effect.succeed(
        counterpartyPermissionByOperation.has(input.operationKey) ? ('denied' as const) : ('allowed' as const),
      );
    }
    if (Object.keys(facts).length === 0) {
      // A declared resolver may name no owner record at all (for example a guest purchase
      // resolution): there is nothing owner-local to check, and the entrypoint's own declaration
      // plus its handler own the request (O70).
      return Effect.succeed('allowed' as const);
    }
    return decideOwnerFacts(transaction, input, facts);
  },
});

export const commerceCustomerContextOwnerAuthorizationOverlayLive = Layer.effect(
  OwnerAuthorizationOverlay,
  Effect.sync(makeCommerceCustomerContextOwnerAuthorizationOverlay),
);

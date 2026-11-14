import type {
  OwnerAuthorizationInput,
  OwnerAuthorizationOutcome,
  OwnerAuthorizationOverlayService,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { OwnerAuthorizationOverlay, ownerAuthorizationDenial } from '@app/core-runtime';
import { readScopedAdmittedWorkload } from '@app/core-runtime/access/enforcement';
import { Effect, Layer, Option, Result, Schema } from 'effect';

import {
  CounterpartyRefSchema,
  PrincipalRefSchema as CounterpartyPrincipalRefSchema,
} from '../../shared/domain/access-contract.ts';
import { COUNTERPARTY_PERMISSION_CODES, permissionDescriptor } from '../../shared/domain/permission-catalog.ts';
import type { CounterpartyPermissionCode } from '../../shared/domain/permission-catalog.ts';
import { RetailAccessDecisionRequestSchema } from '../../shared/apis/retail-access-decision.ts';
import { RetailCustomerProfileRefSchema } from '../../shared/resources/retail-customer-profile.ts';
import { RetailPortalPermissionCodeSchema } from '../../shared/domain/profile-contracts.ts';
import type { RetailPortalPermissionCode } from '../../shared/domain/profile-contracts.ts';
import { PORTAL_SESSION_FACT, portalOwnPermissionByOperation } from '../../shared/portal-auth/own-session.ts';
import { readRetailEnrollmentAccountAuthority } from '../enrollment/attempts/registration-persistence.ts';
import { CommercePortalSessionLiveness } from '../portal-auth/persistence/portal-auth-session-liveness.ts';
import type { CommercePortalSessionLivenessService } from '../portal-auth/persistence/portal-auth-session-liveness.ts';
import { lockingCurrentOwnerAccessForTransaction } from './access-persistence.ts';
import { profilePersistenceServicesForTransaction } from './profile-persistence.ts';

/**
 * The stable reason codes of this owner's refusals. They reach the 403 body and Core's refusal
 * warning, because neither the v2 gate nor "Proč?" sees an owner rule: a person who holds the
 * capability is told it is this rule that refuses, and which owner-local right is missing
 * (`requires.<permission>`).
 */
export const OWNER_DENIAL_REASON = {
  counterpartyFactMissing: 'deny.owner.counterparty_fact_missing',
  counterpartyGrantMissing: 'deny.owner.counterparty_grant_missing',
  factsMissing: 'deny.owner.facts_missing',
  factsUnrecognized: 'deny.owner.facts_unrecognized',
  operationUnmapped: 'deny.owner.operation_unmapped',
  portalPartyMismatch: 'deny.owner.portal_party_mismatch',
  portalSessionFactMissing: 'deny.owner.portal_session_fact_missing',
  portalSessionNotLive: 'deny.owner.portal_session_not_live',
  portalSessionUnbound: 'deny.owner.portal_session_unbound',
  retailFactMissing: 'deny.owner.retail_fact_missing',
} as const;

const requires = (permission: string) => `requires.${permission}`;

/** The retail decision's own outcome names the refusal: `deny.owner.retail_binding_not_found`, … */
const retailDenialReason = (outcome: string) => `deny.owner.retail_${outcome.toLowerCase()}`;

const ownerDecision =
  (permission: CounterpartyPermissionCode) =>
  (decision: 'ALLOWED' | 'DENIED' | 'UNAVAILABLE'): OwnerAuthorizationOutcome => {
    if (decision === 'ALLOWED') {
      return 'allowed';
    }
    if (decision === 'DENIED') {
      // No ACTIVE owner grant of this exact permission for this principal on this Counterparty.
      return ownerAuthorizationDenial(OWNER_DENIAL_REASON.counterpartyGrantMissing, requires(permission));
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
  ['commerce.customer-context.api.customer-price-group-assignment-receipt', COUNTERPARTY_PROFILE_READ],
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
): Effect.Effect<OwnerAuthorizationOutcome> => {
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
    return Effect.succeed(ownerAuthorizationDenial(OWNER_DENIAL_REASON.counterpartyFactMissing, requires(permission)));
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
    Effect.map(ownerDecision(permission)),
    Effect.orElseSucceed(() => 'unavailable' as const),
  );
};

/** The Retail Portal Self-Service limit: the bound profile's own durable authorization state. */
const checkRetailFacts = (
  transaction: ScopedTransactionExecutor,
  input: OwnerAuthorizationInput,
  facts: Readonly<Record<string, string>>,
): Effect.Effect<OwnerAuthorizationOutcome> => {
  const profileId = facts[OWNER_FACT_RETAIL_PROFILE];
  const requiredPermission = facts[OWNER_FACT_RETAIL_PERMISSION];
  const { legalEntityId } = input.scope;
  const factMissing = Effect.succeed(ownerAuthorizationDenial(OWNER_DENIAL_REASON.retailFactMissing));
  if (profileId === undefined || requiredPermission === undefined || legalEntityId === undefined) {
    return factMissing;
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
    return factMissing;
  }
  const profileRef = Schema.decodeResult(RetailCustomerProfileRefSchema)(request.success.profileRef);
  const permission = Schema.decodeResult(RetailPortalPermissionCodeSchema)(request.success.requiredPermission);
  if (Result.isFailure(profileRef) || Result.isFailure(permission)) {
    return factMissing;
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
      Effect.map(({ decision }): OwnerAuthorizationOutcome => {
        if (decision.allowed) {
          return 'allowed';
        }
        if (decision.outcome === 'AUTHORIZATION_UNAVAILABLE') {
          return 'unavailable';
        }
        return ownerAuthorizationDenial(retailDenialReason(decision.outcome), requires(permission.success));
      }),
      Effect.orElseSucceed(() => 'unavailable' as const),
    );
};

/**
 * The storefront customer's own portal operations: "the session itself is the owner rule". The facts name the admitted
 * session's account (its binding, its customer principal, its provider subject) and the Party the request addresses;
 * none of them is authority. Inside the operation's own transaction the overlay reads which Party that account is
 * bound to here, refuses any other Party, and asks that account's own retail right for this operation (the right the
 * operation needs is chosen by the operation, never by the request). A second customer's session can only ever name
 * its own account, so it can only ever reach its own Party.
 */
const checkPortalSessionFacts = (
  transaction: ScopedTransactionExecutor,
  input: OwnerAuthorizationInput,
  permission: RetailPortalPermissionCode,
  sessions: Option.Option<CommercePortalSessionLivenessService>,
): Effect.Effect<OwnerAuthorizationOutcome> => {
  const facts = input.ownerFacts ?? {};
  const authBindingId = facts[PORTAL_SESSION_FACT.authBindingId];
  const customerPrincipalId = facts[PORTAL_SESSION_FACT.customerPrincipalId];
  const partyId = facts[PORTAL_SESSION_FACT.partyId];
  const providerSubjectId = facts[PORTAL_SESSION_FACT.providerSubjectId];
  const sessionRefDigest = facts[PORTAL_SESSION_FACT.sessionRefDigest];
  const { legalEntityId } = input.scope;
  if (
    authBindingId === undefined ||
    customerPrincipalId === undefined ||
    partyId === undefined ||
    providerSubjectId === undefined ||
    sessionRefDigest === undefined ||
    legalEntityId === undefined
  ) {
    return Effect.succeed(ownerAuthorizationDenial(OWNER_DENIAL_REASON.portalSessionFactMissing, requires(permission)));
  }
  if (Option.isNone(sessions)) {
    // A runtime that cannot read the portal realm's sessions cannot prove one is live: never allowed.
    return Effect.succeed('unavailable' as const);
  }
  return Effect.gen(function* portalSession() {
    // The session the route admitted must still be live for this provider subject when the operation is decided. Its
    // sessions live in the portal realm's own database, read through the realm's own role while this transaction is
    // open (never a grant of the token table to the owner role); a signed-out or expired session is refused.
    const live = yield* sessions.value.isLive({ providerSubjectId, sessionRefDigest });
    if (!live) {
      return ownerAuthorizationDenial(OWNER_DENIAL_REASON.portalSessionNotLive, requires(permission));
    }
    const bound = yield* readRetailEnrollmentAccountAuthority(transaction, {
      authBindingId,
      principalId: customerPrincipalId,
      providerSubjectId,
    });
    if (Option.isNone(bound)) {
      return ownerAuthorizationDenial(OWNER_DENIAL_REASON.portalSessionUnbound, requires(permission));
    }
    if (bound.value.party_id !== partyId) {
      return ownerAuthorizationDenial(OWNER_DENIAL_REASON.portalPartyMismatch);
    }
    const profileRef = yield* Schema.decodeEffect(RetailCustomerProfileRefSchema)({
      moduleId: 'commerce.customer-context',
      resourceId: bound.value.profile_id,
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: input.scope.tenantId,
    });
    const services = profilePersistenceServicesForTransaction(transaction, {
      legalEntityId,
      principalId: customerPrincipalId,
      tenantId: input.scope.tenantId,
    });
    const { decision } = yield* services.retailAccessDecision.decideAccess(
      { profileRef, requiredPermission: permission },
      customerPrincipalId,
      input.scope.tenantId,
    );
    if (decision.allowed) {
      return 'allowed' as const;
    }
    return decision.outcome === 'AUTHORIZATION_UNAVAILABLE'
      ? ('unavailable' as const)
      : ownerAuthorizationDenial(retailDenialReason(decision.outcome), requires(permission));
  }).pipe(Effect.orElseSucceed(() => 'unavailable' as const));
};

/**
 * Facts are the v2 carrier (O70). The decision reads ccc's own Postgres state only — the v2 gate has
 * already decided the capability itself, and there is no second permission store (O62).
 */
const decideOwnerFacts = (
  transaction: ScopedTransactionExecutor,
  input: OwnerAuthorizationInput,
  facts: Readonly<Record<string, string>>,
): Effect.Effect<OwnerAuthorizationOutcome> => {
  if (facts[OWNER_FACT_RETAIL_PROFILE] !== undefined || facts[OWNER_FACT_RETAIL_PERMISSION] !== undefined) {
    return checkRetailFacts(transaction, input, facts);
  }
  if (facts[OWNER_FACT_COUNTERPARTY] !== undefined) {
    const permission = counterpartyPermissionByOperation.get(input.operationKey);
    // R5b-1: a Counterparty-governed operation the owner has not mapped is denied, never allowed.
    // Falling through to the scope-wide capability would let a buyer with the read's capability
    // read another counterparty's profile data by naming its ids (O67-Q1, O70).
    return permission === undefined
      ? Effect.succeed(ownerAuthorizationDenial(OWNER_DENIAL_REASON.operationUnmapped))
      : checkCounterpartyFacts(transaction, input, facts, permission);
  }
  // A non-empty fact bag that names neither a Counterparty nor a Retail record is not an
  // owner-neutral read: only an explicitly empty bag (a descriptor that published no governed
  // record, handled in `authorize`) is owner-neutral. Anything else fails closed (O70).
  return Effect.succeed(ownerAuthorizationDenial(OWNER_DENIAL_REASON.factsUnrecognized));
};

const authorizeStandardOwnerFacts = (
  transaction: ScopedTransactionExecutor,
  input: OwnerAuthorizationInput,
): Effect.Effect<OwnerAuthorizationOutcome> => {
  // O70: Core computes the owner's fact bag from the descriptor and passes it unchanged; the
  // caller never supplies it (O64) and it never reaches the decision engine.
  const facts = input.ownerFacts;
  if (facts === undefined) {
    // A capability that needs a Counterparty grant cannot be decided without its owner facts, so
    // a descriptor that declares no resolver denies instead of falling back to the scope-wide
    // capability (O70, fail closed).
    const permission = counterpartyPermissionByOperation.get(input.operationKey);
    return Effect.succeed(
      permission === undefined
        ? 'allowed'
        : ownerAuthorizationDenial(OWNER_DENIAL_REASON.factsMissing, requires(permission)),
    );
  }
  if (Object.keys(facts).length === 0) {
    // A declared resolver may name no owner record at all (for example a guest purchase
    // resolution): there is nothing owner-local to check, and the entrypoint's own declaration
    // plus its handler own the request (O70).
    return Effect.succeed('allowed' as const);
  }
  return decideOwnerFacts(transaction, input, facts);
};
const authorizeSourceOwnerFacts = (
  transaction: ScopedTransactionExecutor,
  input: OwnerAuthorizationInput,
  workloadKey: 'commerce.customer-context.source-write' | 'commerce.customer-context.source-read',
): Effect.Effect<OwnerAuthorizationOutcome> =>
  readScopedAdmittedWorkload(transaction, input.scope, workloadKey).pipe(
    Effect.flatMap((selected) =>
      selected ? Effect.succeed('allowed' as const) : authorizeStandardOwnerFacts(transaction, input),
    ),
    Effect.orElseSucceed(() => 'unavailable' as const),
  );

const sourceAddressActions = new Set([
  'commerce.customer-context.add-saved-address',
  'commerce.customer-context.update-saved-address',
  'commerce.customer-context.remove-saved-address',
]);
export const makeCommerceCustomerContextOwnerAuthorizationOverlay = (
  sessions: Option.Option<CommercePortalSessionLivenessService> = Option.none(),
): OwnerAuthorizationOverlayService => ({
  authorize: (transaction, input) => {
    // A portal self-service operation is decided by its session rule alone, whatever facts it carries. No source
    // workload operation below is one of them.
    const portalPermission = portalOwnPermissionByOperation.get(input.operationKey);
    if (portalPermission !== undefined) {
      return checkPortalSessionFacts(transaction, input, portalPermission, sessions);
    }
    const sourceManagedOwnerFacts =
      (sourceAddressActions.has(input.operationKey) && input.ownerFacts?.[OWNER_FACT_RETAIL_PROFILE] !== undefined) ||
      (input.operationKey === 'commerce.customer-context.assign-counterparty-price-group' &&
        input.ownerFacts?.[OWNER_FACT_COUNTERPARTY] !== undefined);
    if (input.operation === 'action' && sourceManagedOwnerFacts) {
      // This is the successful Core gate's sealed branch, never a credential or payload claim.
      // Source factories retain their exact source/Privacy, profile and business invariant checks.
      return authorizeSourceOwnerFacts(transaction, input, 'commerce.customer-context.source-write');
    }
    if (
      input.operation === 'read' &&
      input.operationKey === 'commerce.customer-context.api.customer-price-group-assignment-receipt' &&
      input.ownerFacts?.[OWNER_FACT_COUNTERPARTY] !== undefined
    ) {
      // The factory first proves the immutable original actor/action/hash, then current scoped
      // profile association and Privacy. This grants no generic Counterparty profile Read.
      return authorizeSourceOwnerFacts(transaction, input, 'commerce.customer-context.source-read');
    }
    return authorizeStandardOwnerFacts(transaction, input);
  },
});

/** The portal session rule needs the realm's session liveness; without it, a portal operation is unavailable. */
export const commerceCustomerContextOwnerAuthorizationOverlayLive = Layer.effect(
  OwnerAuthorizationOverlay,
  Effect.map(Effect.serviceOption(CommercePortalSessionLiveness), makeCommerceCustomerContextOwnerAuthorizationOverlay),
);

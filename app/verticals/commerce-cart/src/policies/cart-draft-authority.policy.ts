import type {
  OwnerAccessFacts,
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import type { CartDraftRejected } from '../../shared/domain/cart-draft.ts';
import { cartAuthorityForScope } from '../services/cart-population.service.ts';
import { Effect, Layer, Match, Schema } from 'effect';
import {
  OwnerAuthorizationOverlay,
  defineMicroverticalPolicy,
  denyPolicy,
  isVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { InitializePopulationAuthorityPayloadSchema } from '../../shared/actions/initialize-population-authority.ts';
import { CreateCartDraftPayloadSchema } from '../../shared/actions/create-cart-draft.ts';
import { ReviseCartDraftPayloadSchema } from '../../shared/actions/revise-cart-draft.ts';
import { FinalizeCartCandidatePayloadSchema } from '../../shared/actions/finalize-cart-candidate.ts';
import { CloseCartDraftPayloadSchema } from '../../shared/actions/close-cart-draft.ts';

const cartModuleKey = 'commerce.cart';
const populationReadKey = 'commerce.cart.api.open-selection-population';
const initKey = 'commerce.cart.initialize-population-authority';
const createKey = 'commerce.cart.create-cart-draft';
const reviseKey = 'commerce.cart.revise-cart-draft';
const closeKey = 'commerce.cart.close-cart-draft';
const finalizeKey = 'commerce.cart.finalize-cart-candidate';
const finalReadKey = 'commerce.cart.api.final-cart-candidate';
const preapprovalObservationReadKey = 'commerce.cart.api.preapproval-cart-observation';

// This pre-transaction policy checks caller targets only. Stored creator/SLE/CAS
// authorization is checked again by the transaction-scoped durable owner service.
const denied = () => Effect.fail(denyPolicy('cart_target_denied', 'The Cart command does not name its trusted Tenant'));

export const cartDraftAuthorityPolicy = defineMicroverticalPolicy<unknown, typeof cartModuleKey>({
  evaluate: ({ action, payload, principal }) => {
    if (action.owningModuleKey !== cartModuleKey) {
      return denied();
    }
    if (action.actionKey === initKey) {
      return Schema.is(InitializePopulationAuthorityPayloadSchema)(payload) ? Effect.void : denied();
    }
    if (action.actionKey === createKey && Schema.is(CreateCartDraftPayloadSchema)(payload)) {
      return payload.entries.every(
        ({ quantity, selection }) =>
          quantity.unitRef.tenantId === principal.tenantId && selection.productRef.tenantId === principal.tenantId,
      )
        ? Effect.void
        : denied();
    }
    if (action.actionKey === reviseKey && Schema.is(ReviseCartDraftPayloadSchema)(payload)) {
      return payload.cartRef.tenantId === principal.tenantId &&
        payload.entries.every(
          (entry) =>
            entry.kind === 'RETAIN' ||
            (entry.quantity.unitRef.tenantId === principal.tenantId &&
              entry.selection.productRef.tenantId === principal.tenantId),
        )
        ? Effect.void
        : denied();
    }
    if (action.actionKey === finalizeKey && Schema.is(FinalizeCartCandidatePayloadSchema)(payload)) {
      return payload.cartRef.tenantId === principal.tenantId && payload.requestRef.tenantId === principal.tenantId
        ? Effect.void
        : denied();
    }
    if (action.actionKey === closeKey && Schema.is(CloseCartDraftPayloadSchema)(payload)) {
      return payload.cartRef.tenantId === principal.tenantId ? Effect.void : denied();
    }
    return denied();
  },
  owningModuleKey: cartModuleKey,
  policyKey: 'commerce.cart.cart-draft-authority.v1',
});

const deniedOwnerDecision = (failure: CartDraftRejected): OwnerAuthorizationDecision =>
  Match.value(failure.code).pipe(
    Match.whenOr('cart_permission_denied', 'cart_not_found', 'cart_closed', () => 'denied' as const),
    Match.whenOr(
      'cart_authority_unavailable',
      'cart_entry_invalid',
      'cart_input_invalid',
      'cart_population_unavailable',
      'cart_revision_conflict',
      () => 'unavailable' as const,
    ),
    Match.exhaustive,
  );

const cartResourceType = 'commerce.cart.cart';
const targetModuleKey = `${cartModuleKey}.target.moduleKey` as const;
const targetResourceType = `${cartModuleKey}.target.resourceType` as const;
const targetResourceId = `${cartModuleKey}.target.resourceId` as const;

/**
 * The one Cart record a draft command acts on (O70). Facts are never authority: the gate decides the
 * capability, and the transaction-scoped owner service proves that this exact Cart belongs to the
 * acting Client, is OPEN and lives in the selected Legal Entity.
 */
export const cartTargetOwnerFacts = (
  cartRef: Readonly<{ moduleId: string; resourceId: string }>,
): OwnerAccessFacts => ({
  [targetModuleKey]: cartRef.moduleId,
  [targetResourceId]: cartRef.resourceId,
  [targetResourceType]: cartResourceType,
});

const ownedCartTarget = (
  facts: OwnerAccessFacts | undefined,
): Readonly<{ moduleId: string; resourceId: string; resourceType: string }> | undefined => {
  const moduleId = facts?.[targetModuleKey];
  const resourceId = facts?.[targetResourceId];
  const resourceType = facts?.[targetResourceType];
  return moduleId === undefined || resourceId === undefined || resourceType === undefined
    ? undefined
    : { moduleId, resourceId, resourceType };
};

const matchingOwnerScope = (transaction: ScopedTransactionExecutor, input: OwnerAuthorizationInput) =>
  transaction.scope.tenantId === input.scope.tenantId && transaction.scope.legalEntityId === input.scope.legalEntityId;

export type CartOwnerAuthorityPlan =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'cart_write';
      readonly resource: Readonly<{ moduleId: string; resourceId: string; resourceType: string }>;
    }
  | { readonly kind: 'denied' }
  | { readonly kind: 'initialization' }
  | { readonly kind: 'population' };
const deniedPlan: CartOwnerAuthorityPlan = { kind: 'denied' };
const allowedPlan: CartOwnerAuthorityPlan = { kind: 'allowed' };

/**
 * Read authority of the Cart surfaces. Both Cart reads are bound to the verified gateway principal:
 * the transaction-scoped read service enforces exact service grants for consumption and matches the
 * persisted buyer (or an explicit service grant) for source-revision recovery.
 */
const planReadAuthority = (input: OwnerAuthorizationInput): CartOwnerAuthorityPlan => {
  if (input.operationKey === finalReadKey || input.operationKey === preapprovalObservationReadKey) {
    return input.scope.legalEntityId !== undefined && isVerifiedGatewayPrincipalContext(input.scope)
      ? allowedPlan
      : deniedPlan;
  }
  if (input.operationKey === populationReadKey) {
    return input.scope.legalEntityId === undefined ? { kind: 'population' } : deniedPlan;
  }
  return deniedPlan;
};

const planWriteAuthority = (input: OwnerAuthorizationInput): CartOwnerAuthorityPlan => {
  if (input.operationKey === initKey) {
    return input.scope.legalEntityId === undefined ? { kind: 'initialization' } : deniedPlan;
  }
  if (input.operationKey === createKey) {
    return input.scope.legalEntityId === undefined ? deniedPlan : { kind: 'population' };
  }
  if (input.operationKey !== reviseKey && input.operationKey !== closeKey && input.operationKey !== finalizeKey) {
    return deniedPlan;
  }
  const resource = ownedCartTarget(input.ownerFacts);
  return resource === undefined || input.scope.legalEntityId === undefined
    ? deniedPlan
    : { kind: 'cart_write', resource };
};

/**
 * The pure owner plan of one Cart operation: which Cart-owned state must be proven before the
 * command runs. It names no Core permission - the gate owns the capability (O62, O70).
 */
export const cartOwnerAuthorityPlan = (input: OwnerAuthorizationInput): CartOwnerAuthorityPlan =>
  input.operation === 'read' ? planReadAuthority(input) : planWriteAuthority(input);

const authorizeCartOwner = Effect.fn('CartDraftAuthorityPolicy.authorizeCartOwner')(
  function* authorizeCartOwnerEffect(transaction: ScopedTransactionExecutor, input: OwnerAuthorizationInput) {
    if (!matchingOwnerScope(transaction, input)) {
      return 'denied' as const;
    }
    const plan = cartOwnerAuthorityPlan(input);
    if (plan.kind === 'denied') {
      return 'denied' as const;
    }
    if (plan.kind === 'allowed') {
      return 'allowed' as const;
    }
    const authority = cartAuthorityForScope(transaction, input.scope);
    if (plan.kind === 'initialization') {
      yield* authority.assertInitializationAuthority();
    } else if (plan.kind === 'population') {
      yield* authority.assertPopulationAuthority();
    } else {
      yield* authority.assertCartWriteAuthority(plan.resource);
    }
    return 'allowed' as const;
  },
  Effect.catchTag('CartDraftRejected', (failure) => Effect.succeed(deniedOwnerDecision(failure))),
);

/**
 * The Cart owner rule over its own state (O67-Q1, O70). A Cart deployment registers only its own
 * module, so an entrypoint of another module is answered by the gate alone.
 */
export const cartOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService = {
  authorize: (transaction, input) =>
    input.owningModuleKey === cartModuleKey
      ? authorizeCartOwner(transaction, input)
      : Effect.succeed('allowed' as const),
};
export const CartOwnerAuthorizationOverlayLive = Layer.succeed(
  OwnerAuthorizationOverlay,
  cartOwnerAuthorizationOverlay,
);

import type {
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  OwnerAuthorizationTarget,
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
const tenantAccessTarget = (target: OwnerAuthorizationTarget, tenantId: string) =>
  target.kind === 'tenant' && target.permission === 'access' && target.tenantId === tenantId;
const cartWriteTarget = (target: OwnerAuthorizationTarget) =>
  target.kind === 'resource' &&
  target.permission === 'write' &&
  target.resource.moduleId === cartModuleKey &&
  target.resource.resourceType === 'commerce.cart.cart';
const populationReadTarget = (input: OwnerAuthorizationInput, target: OwnerAuthorizationTarget) =>
  input.operationKey === populationReadKey &&
  input.scope.legalEntityId === undefined &&
  tenantAccessTarget(target, input.scope.tenantId);
const matchingOwnerScope = (transaction: ScopedTransactionExecutor, input: OwnerAuthorizationInput) =>
  input.owningModuleKey === cartModuleKey &&
  transaction.scope.tenantId === input.scope.tenantId &&
  transaction.scope.legalEntityId === input.scope.legalEntityId;

type CartResourceTarget = Extract<OwnerAuthorizationTarget, { readonly kind: 'resource' }>;
type OwnerAuthorityPlan =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'cart_write'; readonly resource: CartResourceTarget['resource'] }
  | { readonly kind: 'denied' }
  | { readonly kind: 'initialization' }
  | { readonly kind: 'population' };
const deniedPlan: OwnerAuthorityPlan = { kind: 'denied' };

const planReadAuthority = (input: OwnerAuthorizationInput, target: OwnerAuthorizationTarget): OwnerAuthorityPlan => {
  if (
    (input.operationKey === finalReadKey || input.operationKey === preapprovalObservationReadKey) &&
    input.scope.legalEntityId !== undefined &&
    target.kind === 'module' &&
    target.moduleId === cartModuleKey
  ) {
    // Core independently requires current module access. The transaction-scoped
    // read service enforces exact service grants for consumption and matches the
    // persisted buyer (or an explicit service grant) for source-revision recovery. The
    // preapproval observation read is bound the same way: exact buyer or configured service.
    return isVerifiedGatewayPrincipalContext(input.scope) ? { kind: 'allowed' } : deniedPlan;
  }
  return populationReadTarget(input, target) ? { kind: 'population' } : deniedPlan;
};
const planWriteAuthority = (input: OwnerAuthorizationInput, target: OwnerAuthorizationTarget): OwnerAuthorityPlan =>
  (input.operationKey !== reviseKey && input.operationKey !== closeKey && input.operationKey !== finalizeKey) ||
  target.kind !== 'resource' ||
  !cartWriteTarget(target) ||
  input.scope.legalEntityId === undefined
    ? deniedPlan
    : { kind: 'cart_write', resource: target.resource };
const planOwnerAuthority = (
  transaction: ScopedTransactionExecutor,
  input: OwnerAuthorizationInput,
): OwnerAuthorityPlan => {
  if (!matchingOwnerScope(transaction, input)) {
    return deniedPlan;
  }
  if (input.operation === 'action' && input.operationKey === initKey) {
    return input.targets.length !== 0 || input.scope.legalEntityId !== undefined
      ? deniedPlan
      : { kind: 'initialization' };
  }
  if (input.operation === 'action' && input.operationKey === createKey) {
    return input.targets.length !== 0 || input.scope.legalEntityId === undefined ? deniedPlan : { kind: 'population' };
  }
  const [target] = input.targets;
  if (input.targets.length !== 1 || target === undefined) {
    return deniedPlan;
  }
  return input.operation === 'read' ? planReadAuthority(input, target) : planWriteAuthority(input, target);
};

const authorizeCartOwner = Effect.fn('CartDraftAuthorityPolicy.authorizeCartOwner')(
  function* authorizeCartOwnerEffect(transaction: ScopedTransactionExecutor, input: OwnerAuthorizationInput) {
    const plan = planOwnerAuthority(transaction, input);
    if (plan.kind === 'denied') {
      return 'denied' as const;
    }
    const authority = cartAuthorityForScope(transaction, input.scope);
    if (plan.kind === 'initialization') {
      yield* authority.assertInitializationAuthority();
    } else if (plan.kind === 'population') {
      yield* authority.assertPopulationAuthority();
    } else if (plan.kind === 'cart_write') {
      yield* authority.assertCartWriteAuthority(plan.resource);
    }
    return 'allowed' as const;
  },
  Effect.catchTag('CartDraftRejected', (failure) => Effect.succeed(deniedOwnerDecision(failure))),
);

export const cartOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService = {
  authorize: authorizeCartOwner,
};
export const CartOwnerAuthorizationOverlayLive = Layer.succeed(
  OwnerAuthorizationOverlay,
  cartOwnerAuthorizationOverlay,
);

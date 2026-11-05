import type { OperationalScope, OwnerAuthorizationInput } from '@app/core-runtime';
import { DateTime } from 'effect';
import { expect, it } from 'effect-rstest';
import { cartOwnerAuthorityPlan, cartTargetOwnerFacts } from '../../src/policies/cart-draft-authority.policy.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const cartId = '90000000-0000-4000-8000-000000000001';
const operationAt = DateTime.makeUnsafe(new Date('2026-11-03T09:00:00.000Z'));
const scope = {
  authContextRef: 'cart-overlay-test',
  authMethod: 'session',
  correlationId: 'cart-overlay-test',
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope;
const { legalEntityId: _legalEntityId, ...tenantScope } = scope;
const cartRef = { moduleId: 'commerce.cart', resourceId: cartId, resourceType: 'commerce.cart.cart' };
const ownedCart = {
  moduleId: 'commerce.cart',
  resourceId: cartId,
  resourceType: 'commerce.cart.cart',
};

const ownerInput = (
  operationKey: string,
  operation: 'action' | 'read',
  overrides: Partial<OwnerAuthorizationInput> = {},
): OwnerAuthorizationInput => ({
  capabilityKey: `${operationKey}.capability`,
  operation,
  operationAt,
  operationKey,
  owningModuleKey: 'commerce.cart',
  scope,
  targets: [],
  ...overrides,
});

it('plans the exact Cart record a draft command must prove before it runs', () => {
  for (const operationKey of [
    'commerce.cart.revise-cart-draft',
    'commerce.cart.close-cart-draft',
    'commerce.cart.finalize-cart-candidate',
  ]) {
    expect(
      cartOwnerAuthorityPlan(ownerInput(operationKey, 'action', { ownerFacts: cartTargetOwnerFacts(cartRef) })),
    ).toStrictEqual({ kind: 'cart_write', resource: ownedCart });
  }
});

it('refuses a draft command that names no owned Cart record', () => {
  // Without owner facts the rule cannot name the Cart it must prove: the command is refused before
  // any owner work instead of being treated as a scope-wide grant.
  expect(cartOwnerAuthorityPlan(ownerInput('commerce.cart.revise-cart-draft', 'action'))).toStrictEqual({
    kind: 'denied',
  });
});

it('keeps population initialisation and population commands in their own scopes', () => {
  expect(
    cartOwnerAuthorityPlan(
      ownerInput('commerce.cart.initialize-population-authority', 'action', { scope: tenantScope }),
    ),
  ).toStrictEqual({ kind: 'initialization' });
  // Initialisation forbids a selected Legal Entity, and a draft is created in exactly one of them.
  expect(cartOwnerAuthorityPlan(ownerInput('commerce.cart.initialize-population-authority', 'action'))).toStrictEqual({
    kind: 'denied',
  });
  expect(cartOwnerAuthorityPlan(ownerInput('commerce.cart.create-cart-draft', 'action'))).toStrictEqual({
    kind: 'population',
  });
  expect(
    cartOwnerAuthorityPlan(ownerInput('commerce.cart.create-cart-draft', 'action', { scope: tenantScope })),
  ).toStrictEqual({ kind: 'denied' });
});

it('keeps the population read tenant-wide and both candidate reads bound to a verified gateway principal', () => {
  expect(
    cartOwnerAuthorityPlan(ownerInput('commerce.cart.api.open-selection-population', 'read', { scope: tenantScope })),
  ).toStrictEqual({ kind: 'population' });
  expect(cartOwnerAuthorityPlan(ownerInput('commerce.cart.api.open-selection-population', 'read'))).toStrictEqual({
    kind: 'denied',
  });
  // A plain session context carries no redeemed gateway provenance, so a candidate read is refused
  // rather than served on a bare session.
  for (const readKey of ['commerce.cart.api.final-cart-candidate', 'commerce.cart.api.preapproval-cart-observation']) {
    expect(cartOwnerAuthorityPlan(ownerInput(readKey, 'read'))).toStrictEqual({ kind: 'denied' });
  }
  expect(cartOwnerAuthorityPlan(ownerInput('commerce.cart.api.unknown', 'read'))).toStrictEqual({ kind: 'denied' });
});

import { expect, it } from 'effect-rstest';
import { Predicate, Schema } from 'effect';

import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import {
  PurchaseValueAmountUnresolvable,
  purchaseValueAccessAmount,
} from '../../src/actions/purchase-value-access-amount.ts';
import { createPurchaseProposalRevisionAction } from '../../src/actions/create-purchase-proposal-revision.action.ts';
import { preparePurchaseProposalBasisAction } from '../../src/actions/prepare-purchase-proposal-basis.action.ts';
import { triggerPurchaseApprovalAction } from '../../src/actions/trigger-purchase-approval.action.ts';
import { MonetaryAmountSchema } from '../../shared/domain/purchase-limit.ts';
import { TriggerPurchaseApprovalPayloadSchema } from '../../shared/actions/trigger-purchase-approval.ts';

/**
 * R5b-6: the three ccc Purchase Value commands resolve the governed amount as one scalar
 * `{minor, currency}` from the owner-verified purchase value the command carries, never from a
 * bare `amount` payload component (O18). The declaration names the server-derived total, and the
 * conversion uses the platform's own currency minor units, rounding up so the governed amount can
 * never understate the purchase beneath a ceiling.
 */

const amountOf = (amount: string, currency: string) => Schema.decodeSync(MonetaryAmountSchema)({ amount, currency });

it('converts a purchase value to the currency minor units exactly', () => {
  expect(purchaseValueAccessAmount(amountOf('101', 'CZK'))).toEqual({ currency: 'CZK', minor: 10_100 });
  expect(purchaseValueAccessAmount(amountOf('0', 'CZK'))).toEqual({ currency: 'CZK', minor: 0 });
  expect(purchaseValueAccessAmount(amountOf('12.5', 'EUR'))).toEqual({ currency: 'EUR', minor: 1250 });
});

it('reads the currency minor unit from the platform data, not a hard-coded two digits', () => {
  // JPY has no fractional minor unit; BHD has three.
  expect(purchaseValueAccessAmount(amountOf('1000', 'JPY'))).toEqual({ currency: 'JPY', minor: 1000 });
  expect(purchaseValueAccessAmount(amountOf('1.234', 'BHD'))).toEqual({ currency: 'BHD', minor: 1234 });
});

it('rounds a value up, never down, when it carries more digits than the currency minor unit', () => {
  // 0.001 CZK is not representable in 2 minor digits; rounding up keeps the amount above a ceiling.
  expect(purchaseValueAccessAmount(amountOf('0.001', 'CZK'))).toEqual({ currency: 'CZK', minor: 1 });
  expect(purchaseValueAccessAmount(amountOf('1.005', 'CZK'))).toEqual({ currency: 'CZK', minor: 101 });
  // An exact value is not inflated.
  expect(purchaseValueAccessAmount(amountOf('1.5', 'CZK'))).toEqual({ currency: 'CZK', minor: 150 });
});

it('refuses a currency the platform does not recognize rather than guessing its exponent', () => {
  const failure = (() => {
    try {
      return purchaseValueAccessAmount(Schema.decodeSync(MonetaryAmountSchema)({ amount: '1', currency: 'ZZZ' }));
    } catch (error) {
      return error;
    }
  })();
  expect(Predicate.isTagged(failure, 'PurchaseValueAmountUnresolvable')).toBe(true);
  expect(failure).toBeInstanceOf(PurchaseValueAmountUnresolvable);
});

it('names a server-derived total with an owner amount resolver on every Purchase Value command', () => {
  for (const action of [
    preparePurchaseProposalBasisAction,
    createPurchaseProposalRevisionAction,
    triggerPurchaseApprovalAction,
  ]) {
    // The declaration names `derived.*`, never a client-supplied amount component (O18).
    expect(action.descriptor.accessDeclaration?.amountInput).toBe('derived.purchaseValue');
    expect(action.descriptor.accessAmount).toBeDefined();
  }
});

it('resolves the amount the declaration names from the command own purchase value', () => {
  const scope = {
    ...Schema.decodeSync(TrustedPrincipalContextSchema)({
      authBindingId: '55555555-5555-4555-8555-555555555555',
      authContextRef: 'better-auth-session:purchase-value-amount',
      authMethod: 'session',
      legalEntityId: '22222222-2222-4222-8222-222222222222',
      principalId: '66666666-6666-4666-8666-666666666666',
      tenantId: '11111111-1111-4111-8111-111111111111',
    }),
    correlationId: 'purchase-value-amount',
  };
  const payload = Schema.decodeSync(TriggerPurchaseApprovalPayloadSchema)({
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: 'counterparty-1',
      resourceType: 'party.registry.counterparty',
      tenantId: '11111111-1111-4111-8111-111111111111',
    },
    expectedSourceRevisions: [
      { revision: 'counterparty-policy:1', source: 'counterparty-policy' },
      { revision: 'customer-commerce-policy:1', source: 'customer-commerce-policy' },
      { revision: 'principal-override:none:1', source: 'principal-override' },
      { revision: 'proposal:1', source: 'purchase-proposal' },
      { revision: '1', source: 'purchasing-profile' },
      { revision: 'storefront:1', source: 'storefront-context' },
    ],
    profileRef: {
      kind: 'COUNTERPARTY',
      moduleId: 'commerce.customer-context',
      resourceId: 'profile-1',
      resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
      tenantId: '11111111-1111-4111-8111-111111111111',
    },
    proposalRevisionRef: 'proposal:1',
    purchaseValue: {
      monetaryAmount: { amount: '250.75', currency: 'CZK' },
      roundingRuleRevision: 'pricing-rounding:1',
      sourceRef: 'proposal:1',
      sourceRevision: 'proposal:1',
    },
    storefrontId: 'storefront-1',
  });
  // The resolver the runner uses is the descriptor's own callback, so the amount the gate receives
  // is exactly the conversion of the payload's purchase value.
  const amount = triggerPurchaseApprovalAction.descriptor.accessAmount?.(payload, scope);
  expect(amount).toEqual({ currency: 'CZK', minor: 25_075 });
});

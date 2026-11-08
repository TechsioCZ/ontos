import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { preapprovalCartBuyerIsSubject } from '../../src/services/preapproval-cart-observation.service.ts';
import { PreapprovalCartObservationRequestSchema } from '../../shared/apis/preapproval-cart-observation.ts';

const buyer = '11111111-1111-4111-8111-111111111111';
const cartTenant = '22222222-2222-4222-8222-222222222222';
it('observes a Cart only for its actual buyer as the acting subject', () => {
  expect(preapprovalCartBuyerIsSubject(buyer, { principalId: buyer })).toBe(true);
  expect(preapprovalCartBuyerIsSubject(buyer, { principalId: '33333333-3333-4333-8333-333333333333' })).toBe(false);
});
it('does not accept absent/latest revision or foreign resource type as an exact Cart selector', () => {
  const cartRef = {
    moduleId: 'commerce.cart',
    resourceId: buyer,
    resourceType: 'commerce.cart.cart',
    tenantId: cartTenant,
  };
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(PreapprovalCartObservationRequestSchema)({
        cartRef,
        revision: 1,
      }),
    ),
  ).toBe(true);
  expect(Option.isNone(Schema.decodeUnknownOption(PreapprovalCartObservationRequestSchema)({ cartRef }))).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(PreapprovalCartObservationRequestSchema)({
        cartRef,
        revision: 0,
      }),
    ),
  ).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(PreapprovalCartObservationRequestSchema)({
        cartRef: { ...cartRef, resourceType: 'commerce.cart.final-cart-candidate' },
        revision: 1,
      }),
    ),
  ).toBe(true);
});

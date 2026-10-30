import { Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { preapprovalCartGrantMatches } from '../../src/services/preapproval-cart-observation.service.ts';
import { PreapprovalCartObservationRequestSchema } from '../../shared/apis/preapproval-cart-observation.ts';

const grant = {
  authenticationNamespaceId: 'service:preproposal',
  legalEntityId: '33333333-3333-4333-8333-333333333333',
  principalId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
};
it('requires an exact explicitly configured service identity independently of Cart buyer data', () => {
  const service = { ...grant, authMethod: 'api_key' as const };
  expect(preapprovalCartGrantMatches(service, grant)).toBe(true);
  for (const input of [
    { ...service, principalId: 'buyer' },
    { ...service, authenticationNamespaceId: 'other' },
    { ...service, tenantId: 'foreign' },
    { ...service, legalEntityId: 'foreign' },
    { ...service, impersonatedByPrincipalId: 'operator' },
  ]) {
    expect(preapprovalCartGrantMatches(input, grant)).toBe(false);
  }
  expect(preapprovalCartGrantMatches({ ...service, authMethod: 'session' }, grant)).toBe(false);
});
it('does not accept absent/latest revision or foreign resource type as an exact Cart selector', () => {
  const cartRef = {
    moduleId: 'commerce.cart',
    resourceId: grant.principalId,
    resourceType: 'commerce.cart.cart',
    tenantId: grant.tenantId,
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

import { expect, it } from 'effect-rstest';
import { finalCartCandidateReadAllowed } from '../../src/services/final-cart-candidate.service.ts';

const buyer = '11111111-1111-4111-8111-111111111111';
const other = '33333333-3333-4333-8333-333333333333';
const actor = {
  appId: 'commerce-customer-context',
  buildMarker: 'build-1',
  principalId: '44444444-4444-4444-8444-444444444444',
};

it('allows an exact candidate read by the recorded buyer through a verified calling module', () => {
  expect(
    finalCartCandidateReadAllowed({ actor, buyerPrincipalId: buyer, byCandidateRef: true }, { principalId: buyer }),
  ).toBe(true);
});

it('denies an exact candidate read without a verified calling module, even for the buyer', () => {
  expect(finalCartCandidateReadAllowed({ buyerPrincipalId: buyer, byCandidateRef: true }, { principalId: buyer })).toBe(
    false,
  );
});

it('denies an exact candidate read when the subject is not the recorded buyer', () => {
  expect(
    finalCartCandidateReadAllowed({ actor, buyerPrincipalId: buyer, byCandidateRef: true }, { principalId: other }),
  ).toBe(false);
});

it('allows recovery by the recorded buyer without a calling module', () => {
  expect(
    finalCartCandidateReadAllowed({ buyerPrincipalId: buyer, byCandidateRef: false }, { principalId: buyer }),
  ).toBe(true);
});

it('denies recovery when the subject is not the recorded buyer', () => {
  expect(
    finalCartCandidateReadAllowed({ buyerPrincipalId: buyer, byCandidateRef: false }, { principalId: other }),
  ).toBe(false);
});

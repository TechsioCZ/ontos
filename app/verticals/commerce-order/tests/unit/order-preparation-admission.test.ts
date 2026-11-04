import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { Effect, Layer, Predicate, Result } from 'effect';
import { describe, expect, it, rs } from 'effect-rstest';

import { prepareOrderCommitmentAction } from '../../src/actions/prepare-order-commitment.action.ts';
import { ApprovalOwnerGateway } from '../../src/services/approval-owner-gateway.ts';
import type { OrderCommitmentServices } from '../../src/services/order-commitment.service.ts';
import { preparationProposalConflicts } from '../../src/services/order-preparation-admission.ts';
import { commerceOrderRegistration } from '../../vertical.registration.ts';
import type { PreparationProposalFacts } from '../../src/services/order-preparation-admission.ts';
import { orderBuyerPrincipalId, orderPreparationInput } from '../support/order-preparation-input.ts';
import type {
  OrderPreparationIdentities,
  OrderTaxCandidateChange,
  OrderTaxCandidateEncoded,
} from '../support/order-preparation-input.ts';
import { orderLegalEntityId, orderTenantId } from '../support/order-revalidation-work.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:order-preparation-admission',
  authMethod: 'session',
  legalEntityId: orderLegalEntityId,
  principalId: orderBuyerPrincipalId,
  tenantId: orderTenantId,
} as const;
const intentRef = {
  moduleId: 'commerce.order',
  resourceId: 'preparation:admitted',
  resourceType: 'commerce.order.finalization-intent',
  tenantId: orderTenantId,
} as const;
const unreachable = () => Effect.die('Only Order preparation admission is exercised');

/** Runs the registered prepare Action; only the owner service behind its admission is substituted. */
const runPreparation = (changed: Partial<OrderPreparationIdentities>, changeTaxCandidate?: OrderTaxCandidateChange) =>
  Effect.gen(function* runRegisteredPreparation() {
    const prepare = rs.fn(() => Effect.succeed({ binding: null, intentRef, status: 'PREPARATION_PENDING' as const }));
    const services: OrderCommitmentServices = {
      cancel: unreachable,
      commit: unreachable,
      completeConsumption: unreachable,
      completePreparation: unreachable,
      loadWork: unreachable,
      prepare,
      reconcile: unreachable,
      recordPrecommitFailure: unreachable,
      recordProofSet: unreachable,
      revalidate: unreachable,
    };
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      legalEntityPermission: 'allowed',
      ownerRegistration: commerceOrderRegistration,
      services: [bindActionTestServices(prepareOrderCommitmentAction, services)],
      tenantPermission: 'allowed',
    });
    const result = yield* harness.runtime
      .runAction({
        payload: orderPreparationInput(changed, changeTaxCandidate),
        principal,
        registration: prepareOrderCommitmentAction,
        transport: { correlationId: 'order-preparation-admission', idempotencyKey: 'prepare:1' },
      })
      .pipe(
        Effect.provide(NodeCrypto.layer),
        // Admission refuses before the owner service; reaching the approval owner is a defect.
        Effect.provide(Layer.mock(ApprovalOwnerGateway, {})),
        Effect.result,
      );
    return { prepare, result, snapshot: harness.snapshot() };
  });

describe('Order preparation admission', () => {
  it.effect('admits a self-consistent input and enqueues exactly its one preparation work', () =>
    Effect.gen(function* admitConsistentInput() {
      const { prepare, result, snapshot } = yield* runPreparation({});
      expect(Result.isSuccess(result)).toBe(true);
      expect(prepare).toHaveBeenCalledOnce();
      expect(snapshot.committed.flatMap(({ evidence }) => evidence.outboxMessages)).toHaveLength(1);
    }),
  );
  for (const [label, changed] of [
    ['a purchase naming another Cart candidate', { purchaseCandidateRef: 'another-candidate' }],
    ['a Tax pricing result naming another Quotation', { pricingResultId: 'another-quotation' }],
    ['traceability naming another storefront', { storefrontRef: 'another-storefront' }],
  ] as const) {
    it.effect(`refuses ${label} before any intent or completion debt exists`, () =>
      Effect.gen(function* refuseContradictoryInput() {
        const { prepare, result, snapshot } = yield* runPreparation(changed);
        const failure = Result.match(result, { onFailure: (error) => error, onSuccess: () => null });
        expect(Predicate.isTagged(failure, 'OrderCommitmentRejected')).toBe(true);
        expect(failure).toMatchObject({ code: 'order_commitment_conflict' });
        expect(prepare).not.toHaveBeenCalled();
        expect(snapshot.committed.flatMap(({ evidence }) => evidence.outboxMessages)).toEqual([]);
        expect(snapshot.committed.flatMap(({ evidence }) => evidence.domainEvents)).toEqual([]);
      }),
    );
  }
});

type CurrentEligibility = Extract<NonNullable<OrderTaxCandidateEncoded['eligibility']>, { readonly _tag: 'CURRENT' }>;
const withCurrentEligibility =
  (change: (eligibility: CurrentEligibility) => NonNullable<OrderTaxCandidateEncoded['eligibility']>) =>
  (candidate: OrderTaxCandidateEncoded): OrderTaxCandidateEncoded =>
    Predicate.isTagged(candidate.eligibility, 'CURRENT')
      ? { ...candidate, eligibility: change(candidate.eligibility) }
      : candidate;

// Each candidate stays schema-valid; Tax would answer NOT_FINALIZED or FINALIZATION_REJECTED for it
// whatever its own rule or seller state, and spend the one finalization key without storing anything.
describe('Order preparation admission of Tax candidate facts', () => {
  const changes: readonly (readonly [string, OrderTaxCandidateChange])[] = [
    ['an omitted supported-case eligibility', ({ eligibility: _omitted, ...candidate }) => candidate],
    [
      'a not-usable eligibility',
      withCurrentEligibility(
        ({
          materialEvidenceCompleteness: _complete,
          requiredTaxRegimes: _regimes,
          requiredTaxTreatments: _treatments,
          ...subject
        }) => ({ ...subject, _tag: 'NOT_USABLE', state: 'STALE' }),
      ),
    ],
    [
      'an incomplete eligibility predicate',
      withCurrentEligibility((eligibility) => ({
        ...eligibility,
        materialEvidenceCompleteness: { _tag: 'NOT_ESTABLISHED' },
      })),
    ],
    [
      'a regime outside Launch coverage',
      withCurrentEligibility((eligibility) => ({ ...eligibility, requiredTaxRegimes: ['ORDINARY_DOMESTIC', 'OSS'] })),
    ],
    [
      'a treatment outside Launch coverage',
      withCurrentEligibility((eligibility) => ({ ...eligibility, requiredTaxTreatments: ['TAXABLE', 'ZERO_RATE'] })),
    ],
    [
      'a non-Czech delivery place',
      (candidate) => ({
        ...candidate,
        places: {
          ...candidate.places,
          deliveryDestination: { _tag: 'OWNER_RESOLVED', countryCode: 'SK', ownerEvidenceRef: 'delivery-evidence' },
        },
      }),
    ],
    [
      'an unestablished selling place',
      (candidate) => ({
        ...candidate,
        places: { ...candidate.places, sellingLegalEntity: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' } },
      }),
    ],
    [
      'an occurrence without its one published line',
      (candidate) => ({ ...candidate, pricing: { ...candidate.pricing, publishedLines: [] } }),
    ],
  ];
  for (const [label, change] of changes) {
    it.effect(`refuses ${label} before any intent or completion debt exists`, () =>
      Effect.gen(function* refuseUnfinalizableTaxCandidate() {
        const { prepare, result, snapshot } = yield* runPreparation({}, change);
        const failure = Result.match(result, { onFailure: (error) => error, onSuccess: () => null });
        expect(failure).toMatchObject({ code: 'order_commitment_conflict' });
        expect(prepare).not.toHaveBeenCalled();
        expect(snapshot.committed.flatMap(({ evidence }) => evidence.outboxMessages)).toEqual([]);
      }),
    );
  }
});

const proposal: PreparationProposalFacts = {
  context: { channelId: 'B2B', locale: 'cs-CZ' },
  currency: 'CZK',
  identity: { counterpartyRef: { resourceId: '70000000-0000-4000-8000-000000000001' } },
  payment: 'NONE',
  purchaseValue: { monetaryAmount: { currency: 'CZK' } },
  reservation: 'NONE',
  totals: { shipping: { amount: '0' }, total: { currency: 'CZK' } },
};

describe('Order preparation proposal admission', () => {
  it('accepts the approved no-payment, no-reservation, no-shipping proposal the worker can settle', () => {
    expect(preparationProposalConflicts(orderPreparationInput(), proposal)).toBe(false);
  });
  it('refuses proposal relationships the worker would refuse on every delivery', () => {
    const input = orderPreparationInput();
    for (const changed of [
      { ...proposal, payment: 'CARD' },
      { ...proposal, reservation: 'HOLD' },
      { ...proposal, totals: { ...proposal.totals, shipping: { amount: '10' } } },
      { ...proposal, purchaseValue: { monetaryAmount: { currency: 'EUR' } } },
      { ...proposal, context: { ...proposal.context, channelId: 'B2C' } },
      { ...proposal, identity: { counterpartyRef: { resourceId: 'another-counterparty' } } },
    ]) {
      expect(preparationProposalConflicts(input, changed)).toBe(true);
    }
  });
});

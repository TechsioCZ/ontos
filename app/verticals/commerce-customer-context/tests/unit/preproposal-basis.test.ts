import { DateTime, Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { PreapprovalCartObservationResponseSchema } from '@app/commerce-cart/api/preapproval-cart-observation';
import { CatalogSelectionSchema } from '@app/catalog-selection-contracts';
import {
  basisCurrentnessMatchesClaim,
  proposalMatchesPreapprovalCart,
  purchaseProposalBasisReadSnapshotMatches,
  quotationPublicationRevision,
  recoverCompletedProposalBasis,
  samePreparedQuantity,
  verifyPreparedBasisMutationWindow,
} from '../../src/services/purchase-proposal-basis.service.ts';
import { PurchaseProposalRevisionSchema } from '../../shared/domain/purchasing-approval.ts';
import { PurchaseLimitEvaluationCurrentFactsSchema } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { PurchaseLimitCounterpartyRefSchema } from '../../shared/domain/purchase-limit-policy.ts';
import { purchasingApprovalCommercialFixture } from './purchasing-approval-fixtures.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const id = '44444444-4444-4444-8444-444444444444';
const at = '2026-10-23T00:00:00.000Z';

it.effect('rejects prepared basis evidence at its exclusive End and when validity is unknown', () =>
  Effect.gen(function* preparedBasisValidity() {
    yield* verifyPreparedBasisMutationWindow(1000, 999);
    for (const boundary of [null, 999, 1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const failure = yield* verifyPreparedBasisMutationWindow(boundary, 1000).pipe(Effect.flip);
      expect(failure.code).toBe('PROPOSAL_NOT_CURRENT');
    }
  }),
);

const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
const money = (amount: string) => ({
  amount,
  currency: 'EUR',
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: ref('commerce.catalog', 'commerce.catalog.product', '55555555-5555-4555-8555-555555555555'),
  variantRef: ref('commerce.catalog', 'commerce.catalog.variant', '66666666-6666-4666-8666-666666666666'),
});
const counterpartyRef = Schema.decodeUnknownSync(PurchaseLimitCounterpartyRefSchema)(
  ref('party.registry', 'party.registry.counterparty', 'counterparty-1'),
);
const commercial = purchasingApprovalCommercialFixture({
  money,
  tenantId,
});
const proposal = Schema.decodeUnknownSync(PurchaseProposalRevisionSchema)({
  ...commercial,
  approvalEvaluation: 'APPROVAL_REQUIRED',
  approvalTrigger: {
    policyRevision: 'limit-r1',
    reasonCode: 'over_limit',
    source: 'PURCHASE_LIMIT',
  },
  canonicalHash: 'a'.repeat(64),
  canonicalizationVersion: 'purchase-proposal.v1',
  context: {
    channelId: 'B2B',
    evaluatedAt: at,
    locale: 'en-US',
    marketId: 'eu',
    sellingLegalEntityId: legalEntityId,
    storefrontId: 'shop',
    tenantId,
  },
  createdAt: at,
  currency: 'EUR',
  deliveryDestination: {
    address: { country: 'CZ' },
    kind: 'DELIVERY',
    method: 'DELIVERY_ADDRESS',
  },
  effectiveLimit: money('50'),
  expiresAt: '2026-10-23T00:30:00.000Z',
  hierarchyInputs: {
    counterpartyRef,
    evaluatedAt: at,
    purchaseValue: money('120'),
    storefrontId: 'shop',
  },
  identity: {
    buyer: {
      principalId,
      tenantId,
    },
    counterpartyRef,
    profileRef: ref(
      'commerce.customer-context',
      'commerce.customer-context.counterparty-purchasing-profile',
      'profile-1',
    ),
  },
  invoiceRecipient: {
    address: { country: 'CZ' },
    kind: 'INVOICE',
    method: 'BILLING_ADDRESS',
  },
  lines: commercial.lines.map((line) => ({
    ...line,
    configuration: selection,
    lineId: '88888888-8888-4888-8888-888888888888',
    productRef: selection.productRef,
  })),
  payment: 'NONE',
  paymentTerm: {
    code: 'NET30',
    definitionRef: ref('payment-term-catalog', 'payment-term-catalog.payment-term-definition', 'net30'),
    definitionRevision: '1',
  },
  policyRefs: [],
  pricingRevision: 'pricing-r1',
  proposalRevisionRef: ref('commerce.customer-context', 'commerce.customer-context.purchase-proposal-revision', id),
  proposalSequence: 1,
  purchaseValue: { ...commercial.purchaseValue, sourceRef: id },
  reservation: 'NONE',
  revision: 1,
  sourceCart: {
    cartRef: { ...commercial.sourceCart.cartRef, resourceId: '99999999-9999-4999-8999-999999999999' },
    revision: '1',
  },
  state: 'CURRENT',
  taxRevision: 'tax-r1',
});
const observation = Schema.decodeUnknownSync(PreapprovalCartObservationResponseSchema)({
  cart: {
    cartRef: proposal.sourceCart.cartRef,
    createdAt: at,
    entries: [
      {
        createdByPrincipalId: principalId,
        originRevisionId: id,
        quantity: {
          amount: '1',
          unitRef: ref('commerce.catalog', 'commerce.catalog.product-unit', '77777777-7777-4777-8777-777777777777'),
        },
        selection,
        selectionId: '88888888-8888-4888-8888-888888888888',
        sourceActionInvocationId: id,
      },
    ],
    intendedContext: {
      legalEntityId,
      verification: 'UNVERIFIED_PREPARATION',
    },
    legalEntityId,
    preparationPrincipalId: principalId,
    recordedAt: at,
    revisionRef: {
      resourceRef: proposal.sourceCart.cartRef,
      revision: 1,
      revisionId: id,
    },
    status: 'OPEN',
  },
  materialHash: 'b'.repeat(64),
  observedAt: at,
});
const facts = Schema.decodeUnknownSync(PurchaseLimitEvaluationCurrentFactsSchema)({
  channelId: 'B2B',
  contextRevision: 'context-1',
  currentSourceRevisions: [
    {
      revision: '1',
      source: 'purchase-proposal',
    },
    {
      revision: '1',
      source: 'purchasing-profile',
    },
    {
      revision: 'policy-1',
      source: 'customer-commerce-policy',
    },
    {
      revision: 'storefront-1',
      source: 'storefront-context',
    },
  ],
  marketId: 'eu',
  purchaseValue: proposal.purchaseValue,
});
const scope = {
  legalEntityId,
  principalId,
  tenantId,
  trustedStorefrontId: 'shop',
};
const claim = {
  claimedPurchaseValue: proposal.purchaseValue,
  counterpartyRef,
  expectedSourceRevisions: facts.currentSourceRevisions,
  observedAt: DateTime.makeUnsafe(at),
  scope: {
    legalEntityId,
    principalId,
    storefrontId: 'shop',
    tenantId,
  },
};
const resolved = {
  basis: {
    proposal,
    status: 'READY' as const,
  },
  facts,
};

it.effect('binds exact owner Cart material including quantity, configuration, revision and buyer', () =>
  Effect.sync(() => {
    expect(proposalMatchesPreapprovalCart(proposal, observation)).toBe(true);
    expect(
      proposalMatchesPreapprovalCart(proposal, {
        ...observation,
        cart: {
          ...observation.cart,
          entries: observation.cart.entries.map((entry) => ({
            ...entry,
            quantity: { ...entry.quantity, amount: '2' },
          })),
        },
      }),
    ).toBe(false);
    expect(
      proposalMatchesPreapprovalCart(
        { ...proposal, sourceCart: { ...proposal.sourceCart, revision: '2' } },
        observation,
      ),
    ).toBe(false);
    expect(
      proposalMatchesPreapprovalCart(proposal, { ...observation, cart: { ...observation.cart, status: 'CLOSED' } }),
    ).toBe(false);
    expect(
      proposalMatchesPreapprovalCart(proposal, {
        ...observation,
        cart: { ...observation.cart, preparationPrincipalId: id },
      }),
    ).toBe(false);
  }),
);

it.effect('compares independent owner money before any expected claim can become facts', () =>
  Effect.sync(() => {
    expect(basisCurrentnessMatchesClaim(resolved, claim, scope, proposal)).toBe(true);
    expect(
      basisCurrentnessMatchesClaim(
        resolved,
        {
          ...claim,
          claimedPurchaseValue: {
            ...claim.claimedPurchaseValue,
            monetaryAmount: Schema.decodeUnknownSync(
              PurchaseProposalRevisionSchema.fields.purchaseValue.fields.monetaryAmount,
            )(money('119')),
          },
        },
        scope,
        proposal,
      ),
    ).toBe(false);
    expect(
      basisCurrentnessMatchesClaim(
        {
          basis: resolved.basis,
          facts: null,
        },
        claim,
        scope,
        proposal,
      ),
    ).toBe(false);
    expect(
      basisCurrentnessMatchesClaim(
        { ...resolved, basis: { ...resolved.basis, status: 'PREPARED' } },
        claim,
        scope,
        proposal,
      ),
    ).toBe(false);
  }),
);

it.effect('refuses unknown or foreign source and revision even when money is identical', () =>
  Effect.sync(() => {
    for (const value of [
      { ...claim.claimedPurchaseValue, sourceRef: id.replace('4444', '5555') },
      { ...claim.claimedPurchaseValue, sourceRevision: '2' },
    ]) {
      expect(basisCurrentnessMatchesClaim(resolved, { ...claim, claimedPurchaseValue: value }, scope, proposal)).toBe(
        false,
      );
    }
    expect(basisCurrentnessMatchesClaim(resolved, { ...claim, expectedSourceRevisions: [] }, scope, proposal)).toBe(
      false,
    );
    expect(
      basisCurrentnessMatchesClaim(
        resolved,
        {
          ...claim,
          expectedSourceRevisions: facts.currentSourceRevisions.map((item) => ({ ...item, revision: 'stale' })),
        },
        scope,
        proposal,
      ),
    ).toBe(false);
  }),
);

it.effect('refuses wrong actual scope, actor, Counterparty or full proposal identity', () =>
  Effect.sync(() => {
    for (const actual of [
      { ...scope, tenantId: id },
      { ...scope, legalEntityId: id },
      { ...scope, principalId: id },
      { ...scope, trustedStorefrontId: 'other-shop' },
    ]) {
      expect(basisCurrentnessMatchesClaim(resolved, claim, actual, proposal)).toBe(false);
    }
    const otherCounterparty = Schema.decodeUnknownSync(PurchaseLimitCounterpartyRefSchema)({
      ...counterpartyRef,
      resourceId: 'other',
    });
    expect(
      basisCurrentnessMatchesClaim(resolved, { ...claim, counterpartyRef: otherCounterparty }, scope, proposal),
    ).toBe(false);
    expect(
      basisCurrentnessMatchesClaim(resolved, claim, scope, {
        ...proposal,
        sourceCart: {
          ...proposal.sourceCart,
          cartRef: {
            ...proposal.sourceCart.cartRef,
            resourceId: Schema.decodeUnknownSync(
              PurchaseProposalRevisionSchema.fields.sourceCart.fields.cartRef.fields.resourceId,
            )('other-cart'),
          },
        },
      }),
    ).toBe(false);
    expect(
      basisCurrentnessMatchesClaim(resolved, claim, scope, {
        ...proposal,
        identity: {
          ...proposal.identity,
          profileRef: {
            ...proposal.identity.profileRef,
            resourceId: Schema.decodeUnknownSync(
              PurchaseProposalRevisionSchema.fields.identity.fields.profileRef.fields.resourceId,
            )('other-profile'),
          },
        },
      }),
    ).toBe(false);
  }),
);

it.effect('rejects malformed owner facts instead of coercing money or incomplete source vectors', () =>
  Effect.sync(() => {
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(PurchaseLimitEvaluationCurrentFactsSchema)({
          ...facts,
          purchaseValue: {
            ...facts.purchaseValue,
            monetaryAmount: {
              amount: '-1',
              currency: 'EUR',
            },
          },
        }),
      ),
    ).toBe(true);
    expect(
      proposalMatchesPreapprovalCart(proposal, { ...observation, cart: { ...observation.cart, entries: [] } }),
    ).toBe(false);
  }),
);

it.effect(
  'retains original completed provenance and expired window on replay, rejecting another quotation intent',
  () =>
    Effect.gen(function* replayCompletedBasis() {
      const retained = {
        checkedAt: at,
        completionInvocationId: principalId,
        pricingIssuanceInvocationId: id,
        proposal,
        validUntil: at,
      };
      const replay = yield* recoverCompletedProposalBasis(retained, {
        pricingIssuanceInvocationId: id,
        sourceRef: id,
        sourceRevision: '1',
      });
      expect(replay).toBe(retained);
      expect(replay.validUntil).toBe(at);
      const conflict = yield* recoverCompletedProposalBasis(retained, {
        pricingIssuanceInvocationId: principalId,
        sourceRef: id,
        sourceRevision: '1',
      }).pipe(Effect.result);
      expect(Result.isFailure(conflict)).toBe(true);
    }),
);

const publicationLine = (profileVersion: string) => ({ publicationProfile: { profileVersion } });

it('retains only a uniform actual publication rounding revision across all quoted lines', () => {
  expect(quotationPublicationRevision([publicationLine('publication-v1'), publicationLine('publication-v1')])).toBe(
    'publication-v1',
  );
  expect(
    quotationPublicationRevision([publicationLine('publication-v1'), publicationLine('publication-v2')]),
  ).toBeUndefined();
  expect(quotationPublicationRevision([])).toBeUndefined();
});

it('accepts a canonically formatted Catalog quantity equal in value to the Cart amount', () => {
  expect(samePreparedQuantity('2', '2.0')).toBe(true);
  expect(samePreparedQuantity('2.5', '2.50')).toBe(true);
  expect(samePreparedQuantity('2', '2.01')).toBe(false);
  expect(samePreparedQuantity('2', 'two')).toBe(false);
});

it.effect('revalidates the full owner snapshot after released HTTP and ignores only the observation clock', () =>
  Effect.sync(() => {
    const assignments: readonly string[] = [];
    const before = {
      basis: resolved.basis,
      operationTime: at,
      snapshot: {
        assignments,
        currencyPolicy: { generation: 2 },
        ownerAccess: 'ALLOWED',
        paymentPolicy: { generation: 4 },
        profile: { revision: 3, state: 'ACTIVE' },
      },
    };
    const afterClock = { ...before, operationTime: 'later' };
    expect(purchaseProposalBasisReadSnapshotMatches(before, afterClock)).toBe(true);
    for (const snapshot of [
      { ...before.snapshot, assignments: ['new-assignment'] },
      { ...before.snapshot, currencyPolicy: { generation: 3 } },
      { ...before.snapshot, ownerAccess: 'DENIED' },
      { ...before.snapshot, paymentPolicy: { generation: 5 } },
      { ...before.snapshot, profile: { revision: 4, state: 'ACTIVE' } },
      { ...before.snapshot, profile: { revision: 3, state: 'ARCHIVED' } },
    ]) {
      expect(purchaseProposalBasisReadSnapshotMatches(before, { ...before, snapshot })).toBe(false);
    }
    expect(
      purchaseProposalBasisReadSnapshotMatches(before, {
        ...before,
        basis: { ...before.basis, proposal: { ...proposal, canonicalHash: 'changed' } },
      }),
    ).toBe(false);
  }),
);

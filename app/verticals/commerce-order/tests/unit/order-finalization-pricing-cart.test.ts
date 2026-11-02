import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { FinalCartCandidateSchema } from '@app/commerce-cart-finalization-contracts/final-candidate';
import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
} from '@app/core-runtime/modules/active-application-composition';
import { canonicalizeApplicationComposition } from '@app/core-runtime';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { TestClock } from 'effect/testing';
import { describe, expect, it, rs } from 'effect-rstest';
import { executeQuotationVerificationWithAuthorization } from '@app/pricing-contracts/quotation-verification/client';

import { OrderFinalizationContextSchema } from '../../shared/domain/order-finalization-evidence.ts';
import { OrderCommitmentRejected } from '../../shared/domain/order-commitment.ts';
import {
  OrderFinalizationPricingCart,
  OrderFinalizationPricingCartLive,
} from '../../src/integrations/order-finalization-pricing-cart.ts';

const dependencies = rs.hoisted(() => ({
  issueGateway: rs.fn<() => Effect.Effect<unknown>>(),
  verifyQuotation: rs.fn<() => Effect.Effect<unknown>>(),
}));

// Replace only the external owner clients, not Order's layer or its verification logic.
rs.mock('@app/shared-contracts/server/gateway-context-api-key', () => ({
  issueApiKeyGatewayContext: dependencies.issueGateway,
}));
rs.mock('@app/pricing-contracts/quotation-verification/client', () => ({
  executeQuotationVerificationWithAuthorization: dependencies.verifyQuotation,
}));

const businessTime = '2026-10-24T11:59:00.000Z';
const operationTime = '2026-10-24T12:00:00.000Z';
const verificationTime = '2026-10-24T12:00:02.000Z';
const validUntil = '2026-10-24T13:00:00.000Z';
const quotationRef = 'quotation:order-finalization';
const scope = Schema.decodeUnknownSync(OrderFinalizationContextSchema)({
  buyerPrincipalId: '11111111-1111-4111-8111-111111111111',
  correlationId: 'order-quotation-verification',
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  tenantId: '33333333-3333-4333-8333-333333333333',
});
const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId: scope.tenantId,
});
const profileRef = ref(
  'commerce.customer-context',
  'commerce.customer-context.retail-customer-profile',
  '44444444-4444-4444-8444-444444444444',
);
const subject = { authorizationSubject: { kind: 'RETAIL' }, kind: 'PROFILE', profileRef } as const;
const unitRef = ref('commerce.catalog', 'commerce.catalog.product-unit', '55555555-5555-4555-8555-555555555555');
const selection = {
  productRef: ref('commerce.catalog', 'commerce.catalog.product', '66666666-6666-4666-8666-666666666666'),
  variantRef: ref('commerce.catalog', 'commerce.catalog.variant', '77777777-7777-4777-8777-777777777777'),
};
const decision = {
  commercialScope: { channelId: 'B2C', marketId: 'CZ', sellingLegalEntityId: scope.legalEntityId },
  currencyCode: 'CZK',
  lines: [
    {
      catalog: {
        completeness: {
          observedAt: businessTime,
          ownerRevision: 'catalog:1',
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'catalog:selection' },
        },
        divisible: false,
        equivalentSelectionKey: 'pricing-purpose:variant:1',
        evidence: {
          assessedAt: businessTime,
          basis: [
            { role: 'PRODUCT', source: { resourceRef: selection.productRef, revision: 1 } },
            { role: 'VARIANT', source: { resourceRef: selection.variantRef, revision: 1 } },
            {
              provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION',
              role: 'PRODUCT_TYPE_UNTYPED_DECISION',
              source: { resourceRef: selection.productRef, revision: 1 },
            },
          ],
          membership: {
            attestationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            observedAt: businessTime,
            productRef: selection.productRef,
            source: 'CATALOG_OWNER_CURRENT_READ',
            variant: { resourceRef: selection.variantRef, revision: 1 },
          },
          purpose: 'PRICING',
          selection,
          status: 'VALID',
          validUntil,
        },
        hierarchyRevision: 'hierarchy:1',
        ownerRevision: 'catalog:1',
        quantity: {
          changed: false,
          notice: null,
          requested: '1',
          resulting: '1',
          rounding: 'HALF_UP',
          status: 'VALID',
          step: '1',
          targetId: selection.variantRef.resourceId,
          tenantId: scope.tenantId,
          unitId: unitRef.resourceId,
          unitRuleRevision: 1,
        },
        quantityBasis: {
          targetDivisibilityRevision: 1,
          targetRef: selection.variantRef,
          unitRef,
          unitRuleRevision: 1,
        },
        selection,
        status: 'READY',
        unitRef,
      },
      occurrenceId: 'line:1',
      pricingBasis: { quantity: '1', unitRef },
    },
  ],
  monetaryBoundary: 'PRE_TAX',
  operationTime: businessTime,
  purchasingContext: {
    accessDecision: { decisionRef: 'access:1', decisionRevision: '1' },
    actor: { kind: 'PRINCIPAL', principalId: scope.buyerPrincipalId },
    commercialSettingsDecision: { decisionRef: 'settings:1', decisionRevision: '1' },
    contextRef: 'purchase-context:1',
    contextRevision: '1',
    currencyResolution: { currencyCode: 'CZK', resolutionRef: 'currency:1', resolutionRevision: '1' },
    subject,
  },
  tenantId: scope.tenantId,
};
const cartRef = ref('commerce.cart', 'commerce.cart.cart', '88888888-8888-4888-8888-888888888888');
const candidate = Schema.decodeUnknownSync(FinalCartCandidateSchema)({
  approval: {
    proposalHash: 'a'.repeat(64),
    proposalRevisionRef: ref(
      'commerce.customer-context',
      'commerce.customer-context.purchase-proposal-revision',
      'proposal:1',
    ),
    requestRef: ref('commerce.customer-context', 'commerce.customer-context.purchase-approval-request', 'request:1'),
  },
  buyerPrincipalId: scope.buyerPrincipalId,
  candidateHash: 'b'.repeat(64),
  candidateRef: ref('commerce.cart', 'commerce.cart.final-cart-candidate', '99999999-9999-4999-8999-999999999999'),
  finalCartRevision: { cartRef, revision: 2, revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  legalEntityId: scope.legalEntityId,
  orderCommitmentTime: businessTime,
  pricing: { decision, subject },
  sourceCart: { cartRef, revision: 1, revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  storefrontId: 'unit-storefront',
  tenantId: scope.tenantId,
  version: 'FINAL_CART_CANDIDATE.v1',
});
const unrevisedComposition = {
  modules: [],
  revision: '0'.repeat(64),
  schemaVersion: '2',
  shell: {
    contributionAbi: { id: 'ontos.shell-contributions', version: '1' },
    coreCapabilities: [],
    deployment: { appId: 'shell-super-app', buildMarker: 'shell-unit' },
    federationManifest: { sha256: 'a'.repeat(64), url: 'https://shell.unit.invalid/mf-manifest.json' },
    runtimeContract: { sha256: 'b'.repeat(64), url: 'https://shell.unit.invalid/ontos-shell-runtime.json' },
    sharedSingletons: [],
  },
} as const;
const composition = {
  ...unrevisedComposition,
  revision: Hex.encode(sha256(utf8ToBytes(canonicalizeApplicationComposition(unrevisedComposition)))),
};
const testLayer = OrderFinalizationPricingCartLive.pipe(
  Layer.provide(
    Layer.succeed(ActiveApplicationCompositionService, {
      load: Schema.decodeUnknownEffect(ActiveApplicationCompositionSnapshotSchema)({
        composition,
        observedAt: operationTime,
        validUntil,
      }).pipe(Effect.orDie),
    }),
  ),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_COMMERCE_CART_API_BASE_URL: 'https://cart.unit.invalid',
        ONTOS_ORDER_FINALIZATION_GATEWAY_API_KEY: 'unit-api-key',
        ONTOS_PRICING_API_BASE_URL: 'https://pricing.unit.invalid',
        ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.unit.invalid',
      }),
    ),
  ),
);

// This owner-client double supplies the Quotation projection consumed by Order. Pricing's
// retained material evidence and authenticity issuance are deliberately outside this unit test.
const ownerResponse = (issuedAt: string) => ({
  authenticityEvidence: { quotationRef, verifiedAt: verificationTime },
  pricingResultRef: { pricingResultId: quotationRef, revision: 1 },
  quotation: {
    binding: {
      candidateRef: candidate.candidateRef.resourceId,
      commercialScope: candidate.pricing.decision.commercialScope,
      subject: { kind: 'AUTHENTICATED', subjectRef: profileRef },
      tenantId: scope.tenantId,
    },
    issuedAt,
    quotationRef,
    quotedResult: { decision: { ...candidate.pricing.decision, operationTime } },
    validity: { validFrom: businessTime, validUntil },
  },
});
// Pricing's terminal outcome after re-reading its own authentic, already expired Quotation.
const expiryEvaluations = {
  beforeEnd: '2026-10-24T12:00:00.000Z',
  fresh: verificationTime,
  future: '2026-10-24T12:00:05.000Z',
} as const;
const expiredResponse = (
  evaluation: keyof typeof expiryEvaluations = 'fresh',
  expiredQuotationRef: string = quotationRef,
) => ({
  authenticityEvidence: { quotationRef: expiredQuotationRef, verifiedAt: expiryEvaluations[evaluation] },
  expired: {
    _tag: 'EXPIRED',
    evaluatedAt: expiryEvaluations[evaluation],
    quotationRef: expiredQuotationRef,
    validity: { validFrom: businessTime, validUntil: '2026-10-24T12:00:01.000Z' },
  },
  outcome: 'QUOTATION_EXPIRED',
});
const verify = (response: ReturnType<typeof ownerResponse> | ReturnType<typeof expiredResponse>) =>
  Effect.gen(function* verifyOwnerQuotation() {
    yield* TestClock.setTime(Date.parse(verificationTime));
    dependencies.issueGateway.mockReset();
    dependencies.issueGateway.mockReturnValue(
      Effect.succeed({
        apiBaseUrl: '/pricing-api',
        compositionRevision: composition.revision,
        expiresAt: Date.parse(validUntil) / 1000,
        token: 'unit-pricing-assertion',
      }),
    );
    dependencies.verifyQuotation.mockReset();
    dependencies.verifyQuotation.mockReturnValue(Effect.succeed(response));
    const service = yield* OrderFinalizationPricingCart;
    return yield* service.verifyQuotation({ candidate, quotationRef }, scope);
  }).pipe(Effect.provide(testLayer));

describe('Order finalization Quotation issuance time', () => {
  it.effect(
    'accepts an exact binding issued after Pricing operation time while preserving frozen Cart business time',
    () =>
      Effect.gen(function* acceptAfterValidation() {
        const response = ownerResponse('2026-10-24T12:00:01.000Z');
        expect(yield* verify(response)).toBe(response);
        expect(candidate.pricing.decision.operationTime).toBe(businessTime);
        expect(executeQuotationVerificationWithAuthorization).toHaveBeenCalledExactlyOnceWith(
          { candidateHash: candidate.candidateHash, candidateRef: candidate.candidateRef, quotationRef },
          'Bearer unit-pricing-assertion',
          scope.correlationId,
          {
            authorization: 'Bearer unit-pricing-assertion',
            baseUrl: new URL('https://pricing.unit.invalid'),
            compositionRevision: composition.revision,
          },
        );
      }),
  );
  it.effect('rejects issuance before Pricing operation time as a conflict', () =>
    Effect.gen(function* rejectBeforeEvaluation() {
      const failure = yield* verify(ownerResponse('2026-10-24T11:59:59.000Z')).pipe(Effect.flip);
      expect(Schema.is(OrderCommitmentRejected)(failure)).toBe(true);
      expect(failure.code).toBe('order_commitment_conflict');
    }),
  );
  it.effect('still rejects a different candidate binding even when issuance follows operation time', () =>
    Effect.gen(function* rejectDifferentCandidate() {
      const response = ownerResponse('2026-10-24T12:00:01.000Z');
      const failure = yield* verify({
        ...response,
        quotation: {
          ...response.quotation,
          binding: { ...response.quotation.binding, candidateRef: 'another-candidate' },
        },
      }).pipe(Effect.flip);
      expect(Schema.is(OrderCommitmentRejected)(failure)).toBe(true);
      expect(failure.code).toBe('order_commitment_conflict');
    }),
  );
});

describe('Order finalization expired Quotation', () => {
  it.effect("returns Pricing's fresh authenticated expiry of the exact retained Quotation as a terminal outcome", () =>
    Effect.gen(function* acceptOwnerExpiry() {
      const response = expiredResponse();
      expect(yield* verify(response)).toBe(response);
    }),
  );
  it.effect('rejects an expiry naming another Quotation or observed outside the freshness window', () =>
    Effect.gen(function* rejectInconsistentExpiry() {
      for (const response of [
        expiredResponse('fresh', 'quotation:other'),
        expiredResponse('future'),
        expiredResponse('beforeEnd'),
      ]) {
        const failure = yield* verify(response).pipe(Effect.flip);
        expect(Schema.is(OrderCommitmentRejected)(failure)).toBe(true);
        expect(failure.code).toBe('order_commitment_conflict');
      }
    }),
  );
});

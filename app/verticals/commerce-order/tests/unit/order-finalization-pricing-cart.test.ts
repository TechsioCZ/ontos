import { FinalCartCandidateSchema } from '@app/commerce-cart-finalization-contracts/final-candidate';
import { NodeCrypto } from '@effect/platform-node';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
} from '@app/core-runtime/modules/active-application-composition';
import { canonicalizeApplicationComposition } from '@app/core-runtime';
import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { PricingCommitmentConfirmationBinding } from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import {
  QuotationVerificationRequestSchema,
  QuotationVerificationResponseSchema,
} from '@app/pricing-contracts/quotation-verification';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { Hex } from 'effect/encoding';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';

import { OrderFinalizationContextSchema } from '../../shared/domain/order-finalization-evidence.ts';
import { OrderCommitmentRejected } from '../../shared/domain/order-commitment.ts';
import {
  OrderFinalizationPricingCart,
  OrderFinalizationPricingCartLive,
} from '../../src/integrations/order-finalization-pricing-cart.ts';
import { ActionInvocationIdSchema, callAs } from '../../src/services/order-module-call.ts';
import {
  commitmentConfirmationVerificationPath,
  makeOrderOwnerTransport,
  manageCommitmentConfirmationPath,
  ownerForgery,
  ownerTransportLayer,
  ownerWire,
  quotationVerificationPath,
} from '../support/order-owner-transport.ts';
import type { OwnerReply } from '../support/order-owner-transport.ts';
import { pricedOperationTime, pricedQuotation, pricedQuotationValidUntil } from '../support/pricing-owner-quotation.ts';

/** The authenticated buyer Pricing evaluated as the principal of its purchasing context. */
const pricedBuyerPrincipalId = '12121212-1212-4212-8212-121212121212';
const quotationRef = 'quotation:order-finalization';
const { quotedResult: pricedTotal } = pricedQuotation('order', { issuedAt: pricedOperationTime, quotationRef });
const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId: pricedTotal.decision.tenantId,
});
const cartRef = ref('commerce.cart', 'commerce.cart.cart', '88888888-8888-4888-8888-888888888888');
const cartBusinessTime = '2026-09-28T11:59:00.000Z';

/**
 * The authenticated buyer's final Cart candidate that froze Pricing's own commercial decision one minute
 * before Pricing evaluated it.
 */
const pricedCandidate = Schema.decodeUnknownSync(FinalCartCandidateSchema)({
  approval: {
    proposalHash: 'a'.repeat(64),
    proposalRevisionRef: ref(
      'commerce.customer-context',
      'commerce.customer-context.purchase-proposal-revision',
      'proposal:1',
    ),
    requestRef: ref('commerce.customer-context', 'commerce.customer-context.purchase-approval-request', 'request:1'),
  },
  buyerPrincipalId: pricedBuyerPrincipalId,
  candidateHash: 'b'.repeat(64),
  candidateRef: ref('commerce.cart', 'commerce.cart.final-cart-candidate', pricedTotal.candidateRef),
  finalCartRevision: { cartRef, revision: 2, revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  legalEntityId: pricedTotal.decision.commercialScope.sellingLegalEntityId,
  orderCommitmentTime: cartBusinessTime,
  pricing: {
    decision: { ...pricedTotal.decision, operationTime: cartBusinessTime },
    subject: pricedTotal.decision.purchasingContext.subject,
  },
  sourceCart: { cartRef, revision: 1, revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  storefrontId: 'unit-storefront',
  tenantId: pricedTotal.decision.tenantId,
  version: 'FINAL_CART_CANDIDATE.v1',
});

const verificationTime = '2026-09-28T12:00:02.000Z';
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
        observedAt: pricedOperationTime,
        validUntil: pricedQuotationValidUntil,
      }).pipe(Effect.orDie),
    }),
  ),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_COMMERCE_CART_API_BASE_URL: 'https://cart.unit.invalid',
        ONTOS_PRICING_API_BASE_URL: 'https://pricing.unit.invalid',
      }),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

/** Order's finalization call for the buyer of Cart's exact final candidate. */
const candidateScope = callAs(
  Schema.decodeUnknownSync(OrderFinalizationContextSchema)({
    buyerPrincipalId: pricedCandidate.buyerPrincipalId,
    correlationId: 'order-quotation-verification',
    legalEntityId: pricedCandidate.legalEntityId,
    tenantId: pricedCandidate.tenantId,
  }),
  {
    _tag: 'Originator',
    actionInvocationId: Schema.decodeUnknownSync(ActionInvocationIdSchema)('80000000-0000-4000-8000-0000000000b2'),
  },
);
const authenticity = (verifiedAt: string, authenticQuotationRef: string = quotationRef) => ({
  authenticityRef: 'pricing:quotation-proof:order-unit',
  authority: 'EVIDENCE_ONLY' as const,
  issuerRef: 'commerce.pricing',
  keyRef: 'pricing-key',
  keyStatus: 'ACTIVE' as const,
  keyVersion: '1',
  lineageRef: 'pricing-lineage',
  payloadDigest: 'c'.repeat(64),
  proofVersion: '1',
  quotationRef: authenticQuotationRef,
  verifiedAt,
});
/** Pricing's verified answer for its authentic, still valid Quotation. */
const verifiedAnswer = (quotation: PricingQuotationIssued): typeof QuotationVerificationResponseSchema.Type => ({
  authenticityEvidence: authenticity(verificationTime, quotation.quotationRef),
  outcome: 'QUOTATION_VERIFIED',
  pricingResultRef: { pricingResultId: quotation.quotationRef, revision: 1 },
  quotation,
});
// Pricing's terminal outcome after re-reading its own authentic, already expired Quotation.
const expiryEvaluations = {
  fresh: verificationTime,
  future: '2026-09-28T12:00:05.000Z',
} as const;
const expiredValidity = {
  policyEvidence: { maximumValidityDurationMilliseconds: 3_600_000, policyRef: 'policy', policyVersion: '1' },
  validFrom: '2026-09-28T11:30:00.000Z',
  validUntil: '2026-09-28T12:00:01.000Z',
};
const expiredAnswer = (
  evaluation: keyof typeof expiryEvaluations = 'fresh',
  expiredQuotationRef: string = quotationRef,
): typeof QuotationVerificationResponseSchema.Type => ({
  authenticityEvidence: authenticity(expiryEvaluations[evaluation], expiredQuotationRef),
  expired: {
    _tag: 'EXPIRED',
    evaluatedAt: expiryEvaluations[evaluation],
    quotationRef: expiredQuotationRef,
    validity: expiredValidity,
  },
  outcome: 'QUOTATION_EXPIRED',
});
const answer = (value: typeof QuotationVerificationResponseSchema.Type) =>
  ownerWire(QuotationVerificationResponseSchema, value);

/**
 * The actual Order integration, its delegated Shell client and Pricing's actual owner clients run over
 * HTTP; only the Shell and Pricing peers are fakes. The Shell issues a live assertion exactly bound to
 * the active composition; each Pricing route answers its scripted replies.
 */
const overPricing = Effect.fn('test.overPricing')(function* overPricing(routes: Readonly<Record<string, OwnerReply>>) {
  yield* TestClock.setTime(Date.parse(verificationTime));
  const transport = makeOrderOwnerTransport({
    compositionRevision: composition.revision,
    expiresAt: Date.parse(pricedQuotationValidUntil) / 1000,
    token: 'unit-pricing-assertion',
  });
  for (const [path, reply] of Object.entries(routes)) {
    transport.reply(path, reply);
  }
  return transport;
});
const overHttp = (transport: ReturnType<typeof makeOrderOwnerTransport>) =>
  ownerTransportLayer(async (input, init) => transport.answer(input, init));
const verify = Effect.fn('test.verifyQuotation')(function* verifyOwnerQuotation(reply: OwnerReply) {
  const transport = yield* overPricing({ [quotationVerificationPath]: reply });
  const outcome = yield* OrderFinalizationPricingCart.pipe(
    Effect.flatMap((service) => service.verifyQuotation({ candidate: pricedCandidate, quotationRef }, candidateScope)),
    Effect.provide(testLayer),
    Effect.provide(overHttp(transport)),
    Effect.result,
  );
  return { outcome, transport };
});
const accepted = Effect.fn('test.acceptedQuotation')(function* acceptedQuotation(reply: OwnerReply) {
  const { outcome, transport } = yield* verify(reply);
  return { transport, verified: yield* Effect.fromResult(outcome) };
});
/** Pricing answered exactly once and Order refused that answer. */
const refusal = Effect.fn('test.refusedQuotation')(function* refusedQuotation(reply: OwnerReply) {
  const { outcome, transport } = yield* verify(reply);
  expect(transport.sentTo(quotationVerificationPath)).toHaveLength(1);
  const failure = yield* Effect.flip(Effect.fromResult(outcome));
  expect(Schema.is(OrderCommitmentRejected)(failure)).toBe(true);
  return failure;
});

it.effect('refuses a parked proposal instead of advancing confirmation verification', () =>
  Effect.gen(function* proposalIsNotConfirmation() {
    const quotation = pricedQuotation('order', { issuedAt: verificationTime, quotationRef });
    const binding: PricingCommitmentConfirmationBinding = {
      attemptRef: 'attempt:proposal-rejection',
      decisionBundleHash: 'decision-bundle-hash',
      decisionBundleRef: 'decision-bundle:proposal-rejection',
      decisionBundleVersion: '1',
      purchase: quotation.binding,
    };
    const transport = yield* overPricing({
      [manageCommitmentConfirmationPath]: ownerWire(
        ActionProposalAcceptedSchema,
        Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
          _tag: 'ActionProposalAccepted',
          expiresAt: pricedQuotationValidUntil,
          proposalId: '99999999-9999-4999-8999-999999999999',
        }),
        202,
      ),
    });
    const failure = yield* OrderFinalizationPricingCart.pipe(
      Effect.flatMap((service) =>
        service.issueAndVerifyQuotationConfirmation(
          { binding, idempotencyKey: 'proposal-is-not-execution', quotationRef },
          candidateScope,
        ),
      ),
      Effect.provide(testLayer),
      Effect.provide(overHttp(transport)),
      Effect.flip,
    );
    expect(failure.code).toBe('order_commitment_unavailable');
    expect(transport.sentTo(manageCommitmentConfirmationPath)).toHaveLength(1);
    expect(transport.sentTo(commitmentConfirmationVerificationPath)).toHaveLength(0);
  }),
);

describe('Order finalization Quotation issuance time', () => {
  it.effect(
    'accepts an exact binding issued after Pricing operation time while preserving frozen Cart business time',
    () =>
      Effect.gen(function* acceptAfterValidation() {
        const quotation = pricedQuotation('order', { issuedAt: '2026-09-28T12:00:01.000Z', quotationRef });
        const expected = verifiedAnswer(quotation);
        const { transport, verified } = yield* accepted(answer(expected));
        expect(verified).toEqual(expected);
        expect(pricedCandidate.pricing.decision.operationTime).toBe('2026-09-28T11:59:00.000Z');
        const [request, ...others] = transport.sentTo(quotationVerificationPath);
        expect(others).toHaveLength(0);
        expect(request === undefined ? undefined : new URL(request.url).origin).toBe('https://pricing.unit.invalid');
        expect(request?.headers.get('authorization')).toBe('Bearer unit-pricing-assertion');
        expect(request?.headers.get('x-correlation-id')).toBe('order-quotation-verification');
        expect(request?.headers.get('x-ontos-composition-revision')).toBe(composition.revision);
        expect(yield* transport.bodies(quotationVerificationPath, QuotationVerificationRequestSchema)).toEqual([
          { candidateHash: pricedCandidate.candidateHash, candidateRef: pricedCandidate.candidateRef, quotationRef },
        ]);
      }),
  );
  it.effect('refuses issuance before Pricing operation time', () =>
    Effect.gen(function* rejectBeforeEvaluation() {
      const issuedAt = '2026-09-28T12:00:01.500Z';
      const quotation = pricedQuotation('order', { issuedAt, quotationRef });
      // Pricing's published Quotation contract already refuses issuance before its material validation, which
      // is never earlier than its operation time; Order refuses the answer as unverifiable before its own guard.
      const failure = yield* refusal(
        ownerForgery(QuotationVerificationResponseSchema, verifiedAnswer(quotation), (text) =>
          text.replaceAll(issuedAt, '2026-09-28T11:59:59.000Z'),
        ),
      );
      expect(failure.code).toBe('order_commitment_unavailable');
    }),
  );
  it.effect('still rejects a Quotation genuinely issued for another candidate, even after operation time', () =>
    Effect.gen(function* rejectDifferentCandidate() {
      const quotation = pricedQuotation('other', { issuedAt: '2026-09-28T12:00:01.000Z', quotationRef });
      const failure = yield* refusal(answer(verifiedAnswer(quotation)));
      expect(failure.code).toBe('order_commitment_conflict');
    }),
  );
});

describe('Order finalization expired Quotation', () => {
  it.effect("returns Pricing's fresh authenticated expiry of the exact retained Quotation as a terminal outcome", () =>
    Effect.gen(function* acceptOwnerExpiry() {
      const expected = expiredAnswer();
      expect((yield* accepted(answer(expected))).verified).toEqual(expected);
    }),
  );
  it.effect('rejects an expiry naming another Quotation or observed outside the freshness window', () =>
    Effect.gen(function* rejectInconsistentExpiry() {
      for (const inconsistent of [expiredAnswer('fresh', 'quotation:other'), expiredAnswer('future')]) {
        const failure = yield* refusal(answer(inconsistent));
        expect(failure.code).toBe('order_commitment_conflict');
      }
    }),
  );
  it.effect('refuses an expiry observed before the Quotation interval ended', () =>
    Effect.gen(function* rejectExpiryBeforeEnd() {
      // Pricing's published expiry contract already refuses an observation before validUntil, so Order refuses
      // the answer as unverifiable before its own consistency guard.
      const beforeEnd = '2026-09-28T12:00:00.000Z';
      const failure = yield* refusal(
        // The fresh observation instant is both the authenticity time and the evaluation time.
        ownerForgery(QuotationVerificationResponseSchema, expiredAnswer(), (text) =>
          text.replaceAll(verificationTime, beforeEnd),
        ),
      );
      expect(failure.code).toBe('order_commitment_unavailable');
    }),
  );
});

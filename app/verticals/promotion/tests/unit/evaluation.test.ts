import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PromotionEvaluationRequestSchema, PromotionIssuedProofSchema } from '../../shared/apis/preview-promotions.ts';
import type { PromotionEvaluationRequest, PromotionIssuedProof } from '../../shared/apis/preview-promotions.ts';
import { PromotionRecordSchema } from '../../shared/resources/promotion.ts';
import type { PromotionMonetaryEffect } from '../../shared/resources/promotion.ts';
import type { VoucherRecord } from '../../shared/resources/voucher.ts';
import {
  makePromotionEvaluation,
  makePromotionProofPort,
  makePromotionShippingEvaluation,
  PromotionEvaluationFailure,
  promotionSubjectBinding,
} from '../../src/services/evaluation.service.ts';
import type { PromotionEvaluationContext, PromotionExternalFactPort } from '../../src/services/evaluation.service.ts';
import type { PromotionBasisAgreement, PromotionMonetaryBasisMode } from '../../src/services/monetary.service.ts';
import type { PromotionLifecycleRecord } from '../../src/services/lifecycle.service.ts';
import type { PromotionPersistence } from '../../src/services/persistence.service.ts';
import {
  createPromotionCompletenessEvidence,
  nextPromotionProofBoundary,
  verifyPromotionProof,
} from '../../src/services/proof.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const cartId = '33333333-3333-4333-8333-333333333333';
const shippingId = '44444444-4444-4444-8444-444444444444';
const proofId = '55555555-5555-4555-8555-555555555555';
const shippingProofId = '66666666-6666-4666-8666-666666666666';
const at = DateTime.makeUnsafe('2026-11-06T10:00:00Z');
const until = DateTime.makeUnsafe('2026-11-06T12:00:00Z');
const commercialScope = { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: tenantId };
const occurrence = {
  occurrenceId: 'line-A',
  quantity: {
    amount: '1',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: tenantId,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  selection: {
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: tenantId,
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: tenantId,
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
  },
};
const request = Schema.decodeUnknownSync(PromotionEvaluationRequestSchema)({
  purchase: {
    commercialScope,
    currencyCode: 'CZK',
    occurrences: [occurrence],
    purchaseRef: 'purchase-1',
    purchasingContext: {
      accessDecision: { decisionRef: 'access', decisionRevision: '1' },
      actor: { guestEvidenceRef: 'guest-evidence', guestSessionRef: 'guest-session', kind: 'GUEST' },
      commercialSettingsDecision: { decisionRef: 'settings', decisionRevision: '1' },
      contextRef: 'context',
      contextRevision: '1',
      currencyResolution: { currencyCode: 'CZK', resolutionRef: 'currency', resolutionRevision: '1' },
      subject: { guestEvidenceRef: 'guest-evidence', guestSessionRef: 'guest-session', kind: 'GUEST' },
    },
    tenantId,
  },
  voucherChoices: { product: [] },
});
const method = { moduleId: 'delivery.offer', resourceId: 'method-A', resourceType: 'delivery.method', tenantId };
const selectedOffer = { ...method, resourceId: 'chosen-offer', resourceType: 'delivery.offer' };
const common = {
  displayName: 'Owner evaluation offer',
  effectivePeriod: { from: DateTime.formatIso(at), to: DateTime.formatIso(until) },
  eligibility: { commercialScopes: [commercialScope] },
};
const monetary = (
  id: string,
  family: 'PRODUCT_VOUCHER' | 'CART_VOUCHER' | 'AUTOMATIC_CART',
  benefit: PromotionMonetaryEffect,
) =>
  Schema.decodeUnknownEffect(PromotionRecordSchema)({
    createdAt: DateTime.formatIso(at),
    meaning: {
      ...common,
      activation: family === 'AUTOMATIC_CART' ? 'AUTOMATIC' : 'VOUCHER',
      benefit,
      family,
      target: family === 'PRODUCT_VOUCHER' ? 'PURCHASE_DEMAND_OCCURRENCE' : 'MERCHANDISE_CART',
    },
    promotionId: id,
    publishedAt: DateTime.formatIso(at),
    status: 'PUBLISHED',
    technicalVersion: 2,
    updatedAt: DateTime.formatIso(at),
  });
const shipping = (minimum: Option.Option<string>) => {
  const meaning = {
    ...common,
    activation: 'AUTOMATIC',
    allowedMethodRefs: [method],
    benefit: { kind: 'FREE_SHIPPING' },
    family: 'AUTOMATIC_FREE_SHIPPING',
    target: 'SELECTED_DELIVERY_OFFER',
  };
  return Schema.decodeUnknownEffect(PromotionRecordSchema)({
    createdAt: DateTime.formatIso(at),
    meaning: Option.isNone(minimum)
      ? meaning
      : { ...meaning, minimumMerchandise: { amount: minimum.value, currencyCode: 'CZK' } },
    promotionId: shippingId,
    publishedAt: DateTime.formatIso(at),
    status: 'PUBLISHED',
    technicalVersion: 2,
    updatedAt: DateTime.formatIso(at),
  });
};
type Policies = Effect.Success<PromotionPersistence['loadPolicies']>;
interface TestState {
  agreements: PromotionBasisAgreement[];
  deliveryRevision: string;
  generation: number;
  inputAmount: string;
  operationAt: DateTime.Utc;
  policies: Policies;
  promotions: PromotionLifecycleRecord[];
  proofs: PromotionIssuedProof[];
  publication: Option.Option<Readonly<{ amount: string; mode: PromotionMonetaryBasisMode }>>;
  reverseSource: boolean;
  sourceMode: PromotionMonetaryBasisMode;
  sourceRevision: string;
  vouchers: VoucherRecord[];
}
const rankingRow = (kind: 'CART' | 'SHIPPING', ids: readonly string[]): Policies['ranking'][number] => ({
  actionInvocationId: proofId,
  actorPrincipalId: tenantId,
  kind,
  orderedPromotionIds: [...ids],
  reason: 'Owner acceptance ranking',
  recordedAt: DateTime.toDateUtc(at),
  tenantId,
  version: 1,
});

/** Real evaluator/selection/arithmetic/proof; only owner storage and future external producers are component doubles here. */
const fixture = Effect.fn('EvaluationTest.fixture')(function* fixture(input: PromotionEvaluationRequest) {
  const subjectRef = yield* promotionSubjectBinding(input.purchase);
  const state: TestState = {
    agreements: [],
    deliveryRevision: '1',
    generation: 5,
    inputAmount: '1000',
    operationAt: at,
    policies: { basis: Option.getOrUndefined(Option.none<NonNullable<Policies['basis']>>()), ranking: [] },
    promotions: [],
    proofs: [],
    publication: Option.none(),
    reverseSource: false,
    sourceMode: 'GROSS_TAX_INCLUSIVE',
    sourceRevision: '1',
    vouchers: [],
  };
  const external: PromotionExternalFactPort = {
    loadMerchandise: (purchase, operationAt, tenantRules) => {
      const lines = purchase.occurrences.map((line) => ({ inputAmount: state.inputAmount, occurrence: line }));
      return Effect.succeed({
        authority: {
          agreements: state.agreements,
          agreementsComplete: true,
          businessKind: purchase.commercialScope.channelId,
          buyerVatStatus: 'REGISTERED',
          evidenceRef: 'authority:1',
          kind: 'CURRENT',
          observedAt: operationAt,
          purchaseRef: purchase.purchaseRef,
          sellerVatStatus: 'REGISTERED',
          sellingLegalEntityId: purchase.commercialScope.sellingLegalEntityId,
          subjectRef,
          tenantId,
          tenantRules,
          tenantRulesComplete: true,
          validUntil: until,
        },
        source: {
          evidenceRef: 'source:1',
          lines: state.reverseSource ? lines.toReversed() : lines,
          mode: state.sourceMode,
          observedAt: operationAt,
          ownerRevision: state.sourceRevision,
          purchase,
          purchaseRef: purchase.purchaseRef,
          tenantId,
          validUntil: until,
        },
      });
    },
    loadShipping: (purchase, original, offer, operationAt) => {
      const binding = {
        observedAt: operationAt,
        ownerRevision: state.deliveryRevision,
        purchase,
        purchaseRef: purchase.purchaseRef,
        tenantId,
        validUntil: until,
      };
      return Effect.succeed({
        delivery: { ...binding, evidenceRef: 'delivery:1', methodRef: method, offerRef: offer },
        publication: state.publication.pipe(
          Option.map((publication) => ({
            ...binding,
            ...publication,
            currencyCode: 'CZK',
            evidenceRef: 'publication:1',
            merchandiseProofId: original.proofId,
          })),
        ),
      });
    },
    verifyExternalFacts: (facts) =>
      Effect.succeed({
        ...facts,
        merchandiseSource: { ...facts.merchandiseSource, ownerRevision: state.sourceRevision },
        ...Option.match(Option.fromUndefinedOr(facts.delivery), {
          onNone: () => ({}),
          onSome: (delivery) => ({ delivery: { ...delivery, ownerRevision: state.deliveryRevision } }),
        }),
      }),
  };
  const context: PromotionEvaluationContext = {
    external,
    persistence: {
      generation: () => Effect.succeed(state.generation),
      loadIssuedProof: (id) =>
        Effect.succeed(Option.fromUndefinedOr(state.proofs.find((proof) => proof.proofId === id))),
      loadPolicies: Effect.sync(() => state.policies),
      loadPromotions: () => Effect.succeed(state.promotions),
      loadVouchers: () => Effect.succeed(state.vouchers),
      operationAt: Effect.sync(() => state.operationAt),
    },
    scope: { legalEntityId: tenantId, tenantId },
  };
  return {
    context,
    evaluate: makePromotionEvaluation(context).evaluateMerchandise,
    input,
    ship: makePromotionShippingEvaluation(context),
    state,
    subjectRef,
  };
});
type Fixture = Effect.Success<ReturnType<typeof fixture>>;
type Calculation = Effect.Success<ReturnType<Fixture['evaluate']>>;
const retainMonetaryProof = Effect.fn('EvaluationTest.retainProof')(function* retainProof(
  f: Fixture,
  calculation: Calculation,
) {
  const completenessEvidence = yield* createPromotionCompletenessEvidence(
    calculation.request,
    calculation.generation,
    at,
    nextPromotionProofBoundary(calculation.promotions, calculation.externalFacts, at),
  );
  const proof = yield* Schema.decodeUnknownEffect(Schema.toType(PromotionIssuedProofSchema))({
    actorPrincipalId: tenantId,
    completenessEvidence,
    externalFacts: calculation.externalFacts,
    generation: calculation.generation,
    invocationId: cartId,
    issuedAt: at,
    merchandise: calculation.result,
    monetaryRanking: calculation.monetaryRanking,
    proofId,
    request: calculation.request,
    stage: 'MERCHANDISE',
    tenantId,
  });
  f.state.proofs.push(proof);
  return proof;
});

describe('Real Promotion evaluator composition', () => {
  it.effect('completes proven monetary absence before Shipping and normalizes authoritative source order', () =>
    Effect.gen(function* monetaryBeforeShipping() {
      const input = {
        ...request,
        purchase: {
          ...request.purchase,
          occurrences: [
            ...request.purchase.occurrences,
            { ...request.purchase.occurrences[0], occurrenceId: 'line-B' },
          ],
        },
      };
      const f = yield* fixture(yield* Schema.decodeUnknownEffect(PromotionEvaluationRequestSchema)(input));
      f.state.reverseSource = true;
      const calculation = yield* f.evaluate(f.input);
      expect(calculation.result.outcome).toBe('PROVEN_NONE');
      expect(calculation.result.shipping).toBe('UNRESOLVED');
      expect(calculation.externalFacts.merchandiseSource.lines.map((line) => line.occurrence.occurrenceId)).toEqual([
        'line-A',
        'line-B',
      ]);
      yield* retainMonetaryProof(f, calculation);
      expect(
        (yield* verifyPromotionProof(makePromotionProofPort(f.context), {
          at,
          claim: 'CURRENT',
          handle: { proofId, tenantId },
          presented: Option.none(),
          request: f.input,
        })).claim,
      ).toBe('CURRENT');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('runs all four fixed/percentage combinations in product then cart order', () =>
    Effect.gen(function* allEffectPairings() {
      const effects: readonly PromotionMonetaryEffect[] = [
        { amount: '100', currencyCode: 'CZK', kind: 'FIXED_MONETARY_AMOUNT' },
        { kind: 'PERCENTAGE', percentage: '10' },
      ];
      yield* Effect.forEach(
        effects,
        (product) =>
          Effect.forEach(
            effects,
            Effect.fn('EvaluationTest.pairing')(function* pairing(cart) {
              const input = {
                ...request,
                voucherChoices: { product: [{ occurrenceId: 'line-A', voucherId: productId }] },
              };
              const f = yield* fixture(input);
              f.state.promotions = [
                yield* monetary(productId, 'PRODUCT_VOUCHER', product),
                yield* monetary(cartId, 'AUTOMATIC_CART', cart),
              ];
              f.state.vouchers = [
                { disabled: false, normalizedCode: 'product', promotionId: productId, voucherId: productId },
              ];
              f.state.policies.ranking = [rankingRow('CART', [cartId])];
              const calculation = yield* f.evaluate(input);
              expect(calculation.result.applications.map((application) => application.layer)).toEqual([
                'PRODUCT',
                'CART',
              ]);
              expect(calculation.result.applications[0]?.appliedBenefit).toBe('100');
              expect(calculation.result.lines[0]?.exactRemainingAmount).toBe(
                cart.kind === 'PERCENTAGE' ? '810' : '800',
              );
              expect(calculation.result.applications[1]?.allocations).toEqual([
                { amount: cart.kind === 'PERCENTAGE' ? '90' : '100', eligibleBasis: '900', occurrenceId: 'line-A' },
              ]);
            }),
            { concurrency: 1 },
          ),
        { concurrency: 1 },
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    'uses shared cart ranking and distinguishes missing authority or ambiguous ranking from proven absence',
    () =>
      Effect.gen(function* rankingAndUnavailable() {
        const input = { ...request, voucherChoices: { cartVoucherId: productId, product: [] } };
        const f = yield* fixture(input);
        f.state.promotions = [
          yield* monetary(productId, 'CART_VOUCHER', { kind: 'PERCENTAGE', percentage: '10' }),
          yield* monetary(cartId, 'AUTOMATIC_CART', { kind: 'PERCENTAGE', percentage: '50' }),
        ];
        f.state.vouchers = [{ disabled: false, normalizedCode: 'cart', promotionId: productId, voucherId: productId }];
        f.state.policies.ranking = [rankingRow('CART', [productId, cartId])];
        expect(
          (yield* f.evaluate(input)).result.applications.map((application) => application.promotionRef.resourceId),
        ).toEqual([productId]);
        f.state.policies.ranking = [];
        expect((yield* Effect.flip(f.evaluate(input))).code).toBe('CONFIGURATION_CONFLICT');
        const absent = makePromotionEvaluation({
          ...f.context,
          external: {
            ...f.context.external,
            loadMerchandise: () =>
              Effect.fail(new PromotionEvaluationFailure({ code: 'UNAVAILABLE', reason: 'Owner facts unavailable' })),
          },
        });
        expect((yield* Effect.flip(absent.evaluateMerchandise(input))).code).toBe('UNAVAILABLE');
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('resolves a current B2B agreement ahead of persisted general tenant policy', () =>
    Effect.gen(function* agreementBeforeRule() {
      const input = {
        ...request,
        purchase: {
          ...request.purchase,
          commercialScope: { ...request.purchase.commercialScope, channelId: 'B2B' as const },
        },
      };
      const f = yield* fixture(input);
      f.state.sourceMode = 'NET_TAX_EXCLUSIVE';
      f.state.agreements = [
        {
          agreementId: 'agreement-1',
          effectivePeriod: { from: at, to: until },
          mode: 'NET_TAX_EXCLUSIVE',
          revision: '1',
          subjectRef: f.subjectRef,
        },
      ];
      f.state.policies.basis = {
        actionInvocationId: proofId,
        actorPrincipalId: tenantId,
        policy: [
          {
            buyerVatStatus: 'REGISTERED',
            effectivePeriod: { from: DateTime.formatIso(at), to: DateTime.formatIso(until) },
            mode: 'GROSS_TAX_INCLUSIVE',
            revision: '1',
            ruleId: 'tenant-general',
            sellerVatStatus: 'REGISTERED',
          },
        ],
        reason: 'Owner rule',
        recordedAt: DateTime.toDateUtc(at),
        tenantId,
        version: 1,
      };
      const calculation = yield* f.evaluate(input);
      expect(calculation.result.basis.source.kind).toBe('SPECIFIC_AGREEMENT');
      expect(calculation.result.basis.mode).toBe('NET_TAX_EXCLUSIVE');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    'joins a separate Shipping entitlement without reapplying monetary effects and requires the right published basis',
    () =>
      Effect.gen(function* stagedShipping() {
        const f = yield* fixture(request);
        f.state.promotions = [
          yield* monetary(cartId, 'AUTOMATIC_CART', {
            amount: '100',
            currencyCode: 'CZK',
            kind: 'FIXED_MONETARY_AMOUNT',
          }),
          yield* shipping(Option.some('900')),
        ];
        f.state.policies.ranking = [rankingRow('CART', [cartId]), rankingRow('SHIPPING', [shippingId])];
        const calculation = yield* f.evaluate(request);
        const original = yield* retainMonetaryProof(f, calculation);
        expect((yield* Effect.flip(f.ship(request, proofId, selectedOffer))).code).toBe('UNAVAILABLE');
        f.state.publication = Option.some({ amount: '900', mode: 'NET_TAX_EXCLUSIVE' });
        expect((yield* Effect.flip(f.ship(request, proofId, selectedOffer))).code).toBe('UNVERIFIABLE');
        f.state.publication = Option.some({ amount: '900', mode: 'GROSS_TAX_INCLUSIVE' });
        const completed = yield* f.ship(request, proofId, selectedOffer);
        expect(completed.result.outcome).toBe('APPLIED');
        expect(completed.result.application?.minimumOutcome).toBe('MET');
        expect(completed.result.shippingAmount).toBe('OWNED_BY_DELIVERY');
        expect(completed.original.merchandise.applications).toEqual(original.merchandise.applications);
        expect(completed.result.merchandiseApplicationIds).toEqual(
          original.merchandise.applications.map((application) => application.applicationId),
        );
        f.state.publication = Option.some({ amount: '899.99', mode: 'GROSS_TAX_INCLUSIVE' });
        expect((yield* f.ship(request, proofId, selectedOffer)).result.outcome).toBe('PROVEN_NONE');
        f.state.generation += 1;
        expect((yield* Effect.flip(f.ship(request, proofId, selectedOffer))).code).toBe('STALE');
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('does not require a publication when Shipping minimum is absent', () =>
    Effect.gen(function* noShippingMinimum() {
      const f = yield* fixture(request);
      f.state.promotions = [yield* shipping(Option.none())];
      f.state.policies.ranking = [rankingRow('SHIPPING', [shippingId])];
      yield* retainMonetaryProof(f, yield* f.evaluate(request));
      const completed = yield* f.ship(request, proofId, selectedOffer);
      expect(completed.result.application?.minimumOutcome).toBe('NOT_CONFIGURED');
      expect(completed.result.publication).toBeUndefined();
      const completenessEvidence = yield* createPromotionCompletenessEvidence(
        request,
        completed.generation,
        at,
        nextPromotionProofBoundary(completed.promotions, completed.externalFacts, at),
      );
      const proof = yield* Schema.decodeUnknownEffect(Schema.toType(PromotionIssuedProofSchema))({
        ...completed.original,
        completenessEvidence,
        externalFacts: completed.externalFacts,
        proofId: shippingProofId,
        shipping: completed.result,
        stage: 'SHIPPING',
      });
      f.state.proofs.push(proof);
      const verification = {
        at,
        claim: 'CURRENT' as const,
        handle: { proofId: shippingProofId, tenantId },
        presented: Option.none<PromotionIssuedProof>(),
        request,
      };
      expect((yield* verifyPromotionProof(makePromotionProofPort(f.context), verification)).claim).toBe('CURRENT');
      f.state.deliveryRevision = '2';
      expect((yield* Effect.flip(verifyPromotionProof(makePromotionProofPort(f.context), verification))).code).toBe(
        'STALE',
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    'previews an actual unpublished product draft through the real calculator without a fabricated Voucher identity',
    () =>
      Effect.gen(function* productDraftPreview() {
        const f = yield* fixture(request);
        const published = yield* monetary(productId, 'PRODUCT_VOUCHER', { kind: 'PERCENTAGE', percentage: '10' });
        const { publishedAt: _published, ...remaining } = published;
        const draft = yield* Schema.decodeUnknownEffect(Schema.toType(PromotionRecordSchema))({
          ...remaining,
          status: 'DRAFT',
          technicalVersion: 1,
        });
        f.state.promotions = [draft];
        expect((yield* f.evaluate(request)).result.outcome).toBe('PROVEN_NONE');
        const preview = yield* f.evaluate(request, {
          draftPreview: { occurrenceId: 'line-A', promotionId: productId },
        });
        expect(preview.result.lines[0]?.exactRemainingAmount).toBe('900');
        expect(preview.result.applications[0]?.voucherRef).toBeUndefined();
        expect(f.state.promotions[0]?.status).toBe('DRAFT');
        const attemptedIssuance = yield* retainMonetaryProof(f, preview);
        expect(
          (yield* Effect.flip(
            verifyPromotionProof(makePromotionProofPort(f.context), {
              at,
              claim: 'CURRENT',
              handle: { proofId: attemptedIssuance.proofId, tenantId },
              presented: Option.none(),
              request,
            }),
          )).code,
        ).toBe('INCOMPLETE');
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('rejects concurrent owner changes and a scheduled offer crossing its applicability boundary', () =>
    Effect.gen(function* generationRaceAndFutureStart() {
      const f = yield* fixture(request);
      const future = yield* monetary(cartId, 'AUTOMATIC_CART', { kind: 'PERCENTAGE', percentage: '10' });
      f.state.promotions = [
        {
          ...future,
          meaning: { ...future.meaning, effectivePeriod: { from: DateTime.makeUnsafe('2026-11-06T10:30:00Z') } },
        },
      ];
      f.state.policies.ranking = [rankingRow('CART', [cartId])];
      yield* retainMonetaryProof(f, yield* f.evaluate(request));
      f.state.operationAt = DateTime.makeUnsafe('2026-11-06T10:30:00Z');
      expect((yield* Effect.flip(f.ship(request, proofId, selectedOffer))).code).toBe('STALE');
      f.state.operationAt = at;
      const raced = makePromotionEvaluation({
        ...f.context,
        external: {
          ...f.context.external,
          loadMerchandise: (purchase, operationAt, rules) =>
            f.context.external.loadMerchandise(purchase, operationAt, rules).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  f.state.generation += 1;
                }),
              ),
            ),
        },
      });
      expect((yield* Effect.flip(raced.evaluateMerchandise(request))).code).toBe('UNVERIFIABLE');
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('resolves the shipping Voucher independently alongside the selected monetary cart application', () =>
    Effect.gen(function* separateShippingVoucher() {
      const input = { ...request, voucherChoices: { product: [], shippingVoucherId: productId } };
      const f = yield* fixture(input);
      const automaticShipping = yield* shipping(Option.none());
      const voucherShipping = yield* Schema.decodeUnknownEffect(Schema.toType(PromotionRecordSchema))({
        ...automaticShipping,
        meaning: { ...automaticShipping.meaning, activation: 'VOUCHER', family: 'SHIPPING_VOUCHER' },
      });
      f.state.promotions = [
        yield* monetary(cartId, 'AUTOMATIC_CART', { kind: 'PERCENTAGE', percentage: '10' }),
        voucherShipping,
      ];
      f.state.vouchers = [
        { disabled: false, normalizedCode: 'doprava', promotionId: shippingId, voucherId: productId },
      ];
      f.state.policies.ranking = [rankingRow('CART', [cartId]), rankingRow('SHIPPING', [shippingId])];
      const calculation = yield* f.evaluate(input);
      yield* retainMonetaryProof(f, calculation);
      const completed = yield* f.ship(input, proofId, selectedOffer);
      expect(completed.original.merchandise.applications.map((application) => application.layer)).toEqual(['CART']);
      expect(completed.result.application?.activation).toBe('VOUCHER');
      expect(completed.result.application?.voucherRef?.resourceId).toBe(productId);
      expect(completed.result.application?.promotionRef.resourceId).toBe(shippingId);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
  it.effect(
    'expires basis evidence at owned rule ends and future authoritative agreement starts without a generation change',
    () =>
      Effect.gen(function* basisTemporalBoundaries() {
        yield* Effect.forEach(
          ['RULE_END', 'AGREEMENT_START'] as const,
          Effect.fn('EvaluationTest.basisBoundary')(function* basisBoundary(kind) {
            const input = {
              ...request,
              purchase: {
                ...request.purchase,
                commercialScope: { ...request.purchase.commercialScope, channelId: 'B2B' as const },
              },
            };
            const f = yield* fixture(input);
            const boundary = DateTime.makeUnsafe('2026-11-06T10:30:00Z');
            f.state.sourceMode = 'NET_TAX_EXCLUSIVE';
            f.state.policies.basis = {
              actionInvocationId: proofId,
              actorPrincipalId: tenantId,
              policy: [
                {
                  buyerVatStatus: 'REGISTERED',
                  effectivePeriod: {
                    from: DateTime.formatIso(at),
                    to: DateTime.formatIso(kind === 'RULE_END' ? boundary : until),
                  },
                  mode: 'NET_TAX_EXCLUSIVE',
                  revision: '1',
                  ruleId: 'current-net',
                  sellerVatStatus: 'REGISTERED',
                },
              ],
              reason: 'Temporal basis acceptance',
              recordedAt: DateTime.toDateUtc(at),
              tenantId,
              version: 1,
            };
            if (kind === 'AGREEMENT_START') {
              f.state.agreements = [
                {
                  agreementId: 'future-agreement',
                  effectivePeriod: { from: boundary, to: until },
                  mode: 'GROSS_TAX_INCLUSIVE',
                  revision: '1',
                  subjectRef: f.subjectRef,
                },
              ];
            }
            const calculation = yield* f.evaluate(input);
            const proof = yield* retainMonetaryProof(f, calculation);
            expect(proof.externalFacts.basisDecision.nextApplicabilityBoundary).toEqual(boundary);
            const fingerprint = proof.externalFacts.basisDecision.authorityFingerprint;
            expect(
              (yield* verifyPromotionProof(makePromotionProofPort(f.context), {
                at,
                claim: 'CURRENT',
                handle: { proofId, tenantId },
                presented: Option.none(),
                request: input,
              })).claim,
            ).toBe('CURRENT');
            expect(
              (yield* Effect.flip(
                verifyPromotionProof(makePromotionProofPort(f.context), {
                  at: boundary,
                  claim: 'CURRENT',
                  handle: { proofId, tenantId },
                  presented: Option.none(),
                  request: input,
                }),
              )).code,
            ).toBe('STALE');
            expect(f.state.generation).toBe(5);
            expect(proof.externalFacts.basisDecision.authorityFingerprint).toBe(fingerprint);
            const history = yield* verifyPromotionProof(makePromotionProofPort(f.context), {
              at: boundary,
              claim: 'HISTORICAL',
              handle: { proofId, tenantId },
              presented: Option.none(),
              request: input,
            });
            expect(history.claim).toBe('AUTHENTIC_HISTORICAL');
            expect(history.proof.merchandise.basis.mode).toBe('NET_TAX_EXCLUSIVE');
          }),
          { concurrency: 1 },
        );
      }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect('preserves the zero-capacity explanation through owner proof replay without an application', () =>
    Effect.gen(function* explicitNonBenefitEvidence() {
      const f = yield* fixture(request);
      f.state.inputAmount = '0';
      f.state.promotions = [yield* monetary(cartId, 'AUTOMATIC_CART', { kind: 'PERCENTAGE', percentage: '10' })];
      const calculation = yield* f.evaluate(request);
      expect(calculation.result.notApplicable).toEqual([
        {
          layer: 'CART',
          promotionRef: {
            moduleId: 'commerce.promotion',
            resourceId: cartId,
            resourceType: 'commerce.promotion.promotion',
            tenantId,
          },
          reason: 'NO_POSITIVE_ELIGIBLE_BASIS',
        },
      ]);
      expect(calculation.result.applications).toEqual([]);
      const proof = yield* retainMonetaryProof(f, calculation);
      const replay = yield* verifyPromotionProof(makePromotionProofPort(f.context), {
        at,
        claim: 'CURRENT',
        handle: { proofId, tenantId },
        presented: Option.some(proof),
        request,
      });
      expect(replay.proof.merchandise.notApplicable).toEqual(calculation.result.notApplicable);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

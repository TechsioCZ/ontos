import type { PricingCommercialScope } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PromotionOccurrenceSchema } from '../../shared/resources/promotion.ts';
import type { PromotionMonetaryEffect } from '../../shared/resources/promotion.ts';
import { validatePromotionMeaning } from '../../src/services/definition.service.ts';
import { createPromotionDraft } from '../../src/services/lifecycle.service.ts';
import type { PromotionLifecycleRecord } from '../../src/services/lifecycle.service.ts';
import {
  chooseRankedPromotion,
  PromotionSelectionFailure,
  selectMerchandisePromotions,
  selectShippingPromotion,
} from '../../src/services/selection.service.ts';
import type {
  PromotionCandidate,
  PromotionMerchandiseSelectionRequest,
  PromotionSelectionLine,
  PromotionShippingSelectionRequest,
} from '../../src/services/selection.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const a = '22222222-2222-4222-8222-222222222222';
const b = '33333333-3333-4333-8333-333333333333';
const c = '44444444-4444-4444-8444-444444444444';
const voucherId = '55555555-5555-4555-8555-555555555555';
const at = DateTime.makeUnsafe('2026-11-06T10:00:00Z');
const publishedAt = DateTime.makeUnsafe('2026-11-06T09:00:00Z');
const commercialScope: PricingCommercialScope = { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: tenantId };
const method = { moduleId: 'delivery.offer', resourceId: 'method-A', resourceType: 'delivery.method', tenantId };
const common = {
  displayName: 'Offer',
  effectivePeriod: { from: '2026-11-06T09:00:00Z', to: '2026-11-07T10:00:00Z' },
  eligibility: { commercialScopes: [commercialScope] },
};
const fixed = (amount: string): PromotionMonetaryEffect => ({
  amount,
  currencyCode: 'CZK',
  kind: 'FIXED_MONETARY_AMOUNT',
});
const percentage = (value: string): PromotionMonetaryEffect => ({ kind: 'PERCENTAGE', percentage: value });
const productSelection = {
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
};
const makeLine = (occurrenceId: string, amount = '1000', selection = productSelection) =>
  Schema.decodeUnknownEffect(PromotionOccurrenceSchema)({
    occurrenceId,
    quantity: {
      amount: '1',
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: tenantId,
        resourceType: 'commerce.catalog.product-unit',
        tenantId,
      },
    },
    selection,
  }).pipe(Effect.map((occurrence): PromotionSelectionLine => ({ inputAmount: amount, occurrence })));
const makePromotion = Effect.fn('SelectionTest.promotion')(function* makePromotion(
  family: 'PRODUCT_VOUCHER' | 'CART_VOUCHER' | 'AUTOMATIC_CART' | 'AUTOMATIC_FREE_SHIPPING' | 'SHIPPING_VOUCHER',
  promotionId: string,
  effect: PromotionMonetaryEffect = fixed('100'),
  minimum?: string,
) {
  const shipping = family === 'AUTOMATIC_FREE_SHIPPING' || family === 'SHIPPING_VOUCHER';
  const definition = shipping
    ? {
        ...common,
        activation: family === 'SHIPPING_VOUCHER' ? 'VOUCHER' : 'AUTOMATIC',
        allowedMethodRefs: [method],
        benefit: { kind: 'FREE_SHIPPING' },
        family,
        target: 'SELECTED_DELIVERY_OFFER',
      }
    : {
        ...common,
        activation: family === 'AUTOMATIC_CART' ? 'AUTOMATIC' : 'VOUCHER',
        benefit: effect,
        family,
        target: family === 'PRODUCT_VOUCHER' ? 'PURCHASE_DEMAND_OCCURRENCE' : 'MERCHANDISE_CART',
      };
  const meaning = yield* validatePromotionMeaning(
    minimum === undefined
      ? definition
      : {
          ...definition,
          minimumMerchandise: { amount: minimum, currencyCode: 'CZK' },
        },
  );
  const record: PromotionLifecycleRecord = {
    createdAt: publishedAt,
    meaning,
    promotionId,
    publishedAt,
    status: 'PUBLISHED',
    technicalVersion: 2,
    updatedAt: publishedAt,
  };
  return record;
});
const purchase = (
  lines: readonly PromotionSelectionLine[],
  overrides: Partial<PromotionMerchandiseSelectionRequest> = {},
): PromotionMerchandiseSelectionRequest => ({
  at,
  cartCandidates: [],
  cartRanking: [],
  commercialScope,
  lines,
  productVouchers: [],
  tenantId,
  ...overrides,
});
const shippingRequest = (
  candidates: readonly PromotionCandidate[],
  overrides: Partial<PromotionShippingSelectionRequest> = {},
): PromotionShippingSelectionRequest => ({
  at,
  candidates,
  commercialScope,
  mode: 'GROSS_TAX_INCLUSIVE',
  publishedMerchandise: Option.some({
    amount: '1500',
    currencyCode: 'CZK',
    evidenceRef: 'published-merchandise',
    mode: 'GROSS_TAX_INCLUSIVE',
    observedAt: publishedAt,
    purchaseRef: 'purchase-1',
    tenantId,
    validUntil: DateTime.makeUnsafe('2026-11-06T11:00:00Z'),
  }),
  purchaseRef: 'purchase-1',
  selectedDelivery: Option.some({
    evidenceRef: 'delivery-proof',
    methodRef: method,
    observedAt: publishedAt,
    offerRef: { ...method, resourceId: 'chosen-offer', resourceType: 'delivery.offer' },
    purchaseRef: 'purchase-1',
    tenantId,
    validUntil: DateTime.makeUnsafe('2026-11-06T11:00:00Z'),
  }),
  shippingRanking: candidates.map((candidate) => candidate.promotion.promotionId),
  tenantId,
  ...overrides,
});

describe('explicit ranked selection', () => {
  it.effect('selects one winner across automatic and voucher activation by tenant priority alone', () =>
    Effect.gen(function* test() {
      const automatic = { promotion: yield* makePromotion('AUTOMATIC_CART', a, percentage('50')) };
      const voucher = { promotion: yield* makePromotion('CART_VOUCHER', b, fixed('1')), voucherId };
      for (const candidates of [
        [automatic, voucher],
        [voucher, automatic],
      ]) {
        const selected = yield* chooseRankedPromotion(candidates, [b, a]);
        expect(selected.pipe(Option.map((winner) => winner.promotion.promotionId))).toEqual(Option.some(b));
      }
      const reversed = yield* chooseRankedPromotion([automatic, voucher], [a, b]);
      expect(reversed.pipe(Option.map((winner) => winner.promotion.promotionId))).toEqual(Option.some(a));
    }),
  );

  it.effect('refuses missing or ambiguous relevant ranking, including a singleton without explicit rank', () =>
    Effect.gen(function* test() {
      const automatic = { promotion: yield* makePromotion('AUTOMATIC_CART', a) };
      for (const ranking of [[], [b], [a, a]]) {
        const error = yield* Effect.flip(chooseRankedPromotion([automatic], ranking));
        expect(Schema.is(PromotionSelectionFailure)(error)).toBe(true);
        expect(error).toHaveProperty('code', 'CONFIGURATION_CONFLICT');
      }
      const duplicate = yield* Effect.flip(chooseRankedPromotion([automatic, automatic], [a]));
      expect(duplicate).toHaveProperty('code', 'CONFIGURATION_CONFLICT');
      expect(yield* chooseRankedPromotion([], [])).toEqual(Option.none());
      expect(Option.isSome(yield* chooseRankedPromotion([automatic], [b, b, a]))).toBe(true);
    }),
  );
});

describe('product before one merchandise-cart application', () => {
  it.effect('supports all four effect pairings and preserves attribution and layer order', () =>
    Effect.gen(function* test() {
      const examples = [
        { cart: fixed('100'), product: fixed('100'), remaining: '800' },
        { cart: percentage('10'), product: fixed('100'), remaining: '810' },
        { cart: fixed('100'), product: percentage('10'), remaining: '800' },
        { cart: percentage('10'), product: percentage('10'), remaining: '810' },
      ];
      for (const example of examples) {
        const line = yield* makeLine('O1');
        const product = yield* makePromotion('PRODUCT_VOUCHER', a, example.product);
        const cart = yield* makePromotion('AUTOMATIC_CART', b, example.cart);
        const result = yield* selectMerchandisePromotions(
          purchase([line], {
            cartCandidates: [{ promotion: cart }],
            cartRanking: [b],
            productVouchers: [{ occurrenceId: 'O1', promotion: product, voucherId }],
          }),
        );
        expect(result.productApplications).toHaveLength(1);
        expect(result.productApplications[0]?.layer).toBe('PRODUCT');
        expect(result.productApplications[0]?.promotionRef.resourceId).toBe(a);
        expect(result.productApplications[0]?.voucherRef?.resourceId).toBe(voucherId);
        expect(result.cartApplication.pipe(Option.map((application) => application.layer))).toEqual(
          Option.some('CART'),
        );
        expect(result.lines[0]?.exactRemainingAmount).toBe(example.remaining);
      }
    }),
  );

  it.effect('keeps equal Catalog Selections as distinct occurrences with separate product vouchers', () =>
    Effect.gen(function* test() {
      const o1 = yield* makeLine('O1');
      const o2 = yield* makeLine('O2');
      const untouched = yield* makeLine('O3');
      const p1 = yield* makePromotion('PRODUCT_VOUCHER', a);
      const p2 = yield* makePromotion('PRODUCT_VOUCHER', b, percentage('20'));
      const result = yield* selectMerchandisePromotions(
        purchase([o1, o2, untouched], {
          productVouchers: [
            { occurrenceId: 'O1', promotion: p1, voucherId },
            { occurrenceId: 'O2', promotion: p2, voucherId: c },
          ],
        }),
      );
      expect(result.productApplications.map((application) => application.occurrenceId)).toEqual(['O1', 'O2']);
      expect(result.lines.map((line) => line.exactRemainingAmount)).toEqual(['900', '800', '1000']);
      expect(result.lines.map((line) => line.occurrence)).toEqual([o1.occurrence, o2.occurrence, untouched.occurrence]);
    }),
  );

  it.effect('rejects duplicate, foreign or absent occurrence voucher targets at the backend', () =>
    Effect.gen(function* test() {
      const line = yield* makeLine('O1');
      const promotion = yield* makePromotion('PRODUCT_VOUCHER', a);
      const choice = { occurrenceId: 'O1', promotion, voucherId };
      for (const productVouchers of [[choice, choice], [{ ...choice, occurrenceId: 'absent' }]]) {
        expect(yield* Effect.flip(selectMerchandisePromotions(purchase([line], { productVouchers })))).toHaveProperty(
          'code',
          'INVALID_REQUEST',
        );
      }
      expect(yield* Effect.flip(selectMerchandisePromotions(purchase([line, line])))).toHaveProperty(
        'code',
        'INVALID_REQUEST',
      );
      const foreign = {
        ...line,
        occurrence: {
          ...line.occurrence,
          selection: {
            ...line.occurrence.selection,
            productRef: { ...line.occurrence.selection.productRef, tenantId: a },
          },
        },
      };
      expect(yield* Effect.flip(selectMerchandisePromotions(purchase([foreign])))).toHaveProperty(
        'code',
        'INVALID_REQUEST',
      );
    }),
  );

  it.effect('preserves all original recipients while allocating only to positive eligible remaining lines', () =>
    Effect.gen(function* test() {
      const one = yield* makeLine('O1', '1000');
      const two = yield* makeLine('O2', '3000');
      const zero = yield* makeLine('O3', '0');
      const cart = yield* makePromotion('AUTOMATIC_CART', a, fixed('400'));
      const result = yield* selectMerchandisePromotions(
        purchase([one, two, zero], { cartCandidates: [{ promotion: cart }], cartRanking: [a] }),
      );
      expect(result.lines).toHaveLength(3);
      expect(result.lines.map((line) => line.exactRemainingAmount)).toEqual(['900', '2700', '0']);
      expect(
        result.cartApplication.pipe(
          Option.map((application) => application.allocations.map((allocation) => allocation.occurrenceId)),
        ),
      ).toEqual(Option.some(['O1', 'O2']));
    }),
  );

  it.effect('does not let inactive or wrong-scope automatic offers demand ranking or become a winner', () =>
    Effect.gen(function* test() {
      const line = yield* makeLine('O1');
      const cart = yield* makePromotion('AUTOMATIC_CART', a);
      const result = yield* selectMerchandisePromotions(
        purchase([line], { cartCandidates: [{ promotion: { ...cart, disabledAt: at } }], cartRanking: [] }),
      );
      expect(result.cartApplication).toEqual(Option.none());
      const product = yield* makePromotion('PRODUCT_VOUCHER', b);
      const refused = yield* Effect.flip(
        selectMerchandisePromotions(
          purchase([line], {
            productVouchers: [{ occurrenceId: 'O1', promotion: { ...product, disabledAt: at }, voucherId }],
          }),
        ),
      );
      expect(refused).toHaveProperty('code', 'INELIGIBLE_CHOICE');
    }),
  );
});

it.effect('retains ineligible original lines without giving them cart allocations', () =>
  Effect.gen(function* test() {
    const one = yield* makeLine('O1', '1000');
    const other = yield* makeLine('O2', '3000', {
      ...productSelection,
      variantRef: { ...productSelection.variantRef, resourceId: a },
    });
    const cart = yield* makePromotion('AUTOMATIC_CART', a, fixed('400'));
    const scopedCart = {
      ...cart,
      meaning: {
        ...cart.meaning,
        eligibility: { ...cart.meaning.eligibility, eligibleSelections: [one.occurrence.selection] },
      },
    };
    const result = yield* selectMerchandisePromotions(
      purchase([one, other], { cartCandidates: [{ promotion: scopedCart }], cartRanking: [a] }),
    );
    expect(result.lines.map((line) => line.exactRemainingAmount)).toEqual(['600', '3000']);
    expect(
      result.cartApplication.pipe(
        Option.map((application) => application.allocations.map((allocation) => allocation.occurrenceId)),
      ),
    ).toEqual(Option.some(['O1']));
    expect(result.lines[1]?.occurrence).toEqual(other.occurrence);
  }),
);

describe('separate free-shipping entitlement selection', () => {
  it.effect(
    'does not require publication solely for a lower-priority offer when a proven higher-priority offer has no minimum',
    () =>
      Effect.gen(function* test() {
        const conditional = { promotion: yield* makePromotion('AUTOMATIC_FREE_SHIPPING', a, fixed('0'), '1500') };
        const unconditional = { promotion: yield* makePromotion('AUTOMATIC_FREE_SHIPPING', b) };
        const result = yield* selectShippingPromotion(
          shippingRequest([conditional, unconditional], {
            publishedMerchandise: Option.none(),
            shippingRanking: [b, a],
          }),
        );
        expect(result.selected.pipe(Option.map((candidate) => candidate.promotion.promotionId))).toEqual(
          Option.some(b),
        );
        const uncertainWinner = yield* Effect.flip(
          selectShippingPromotion(
            shippingRequest([conditional, unconditional], {
              publishedMerchandise: Option.none(),
              shippingRanking: [a, b],
            }),
          ),
        );
        expect(uncertainWinner).toHaveProperty('code', 'UNAVAILABLE');
      }),
  );

  it.effect('supports independent automatic and voucher priorities without merchandise slots or Shipping amounts', () =>
    Effect.gen(function* test() {
      const automatic = { promotion: yield* makePromotion('AUTOMATIC_FREE_SHIPPING', a) };
      const voucher = { promotion: yield* makePromotion('SHIPPING_VOUCHER', b), voucherId };
      const result = yield* selectShippingPromotion(
        shippingRequest([automatic, voucher], { publishedMerchandise: Option.none(), shippingRanking: [b, a] }),
      );
      expect(result.selected.pipe(Option.map((candidate) => candidate.promotion.promotionId))).toEqual(Option.some(b));
      expect(result).not.toHaveProperty('shippingAmount');
      expect(result.selectedDelivery.offerRef.resourceId).toBe('chosen-offer');
    }),
  );

  it.effect('compares only authoritative published post-discount value, with equality meeting the minimum', () =>
    Effect.gen(function* test() {
      const promotion = yield* makePromotion('AUTOMATIC_FREE_SHIPPING', a, fixed('0'), '1500');
      const base = shippingRequest([{ promotion }]);
      const equal = yield* selectShippingPromotion(base);
      expect(Option.isSome(equal.selected)).toBe(true);
      if (Option.isNone(base.publishedMerchandise)) {
        return;
      }
      const below = yield* selectShippingPromotion({
        ...base,
        publishedMerchandise: Option.some({ ...base.publishedMerchandise.value, amount: '1400' }),
      });
      expect(below.selected).toEqual(Option.none());
      const prepublication = yield* Effect.flip(
        selectShippingPromotion({
          ...base,
          publishedMerchandise: Option.some({ ...base.publishedMerchandise.value, amount: '1499.995' }),
        }),
      );
      expect(prepublication).toHaveProperty('code', 'UNVERIFIABLE');
      const wrongMode = yield* Effect.flip(
        selectShippingPromotion({
          ...base,
          publishedMerchandise: Option.some({ ...base.publishedMerchandise.value, mode: 'NET_TAX_EXCLUSIVE' }),
        }),
      );
      expect(wrongMode).toHaveProperty('code', 'UNVERIFIABLE');
      const missing = yield* Effect.flip(selectShippingPromotion({ ...base, publishedMerchandise: Option.none() }));
      expect(missing).toHaveProperty('code', 'UNAVAILABLE');
    }),
  );

  it.effect('fails closed on missing, foreign or stale Delivery evidence and rejects ambiguous shipping ranking', () =>
    Effect.gen(function* test() {
      const promotion = yield* makePromotion('AUTOMATIC_FREE_SHIPPING', a);
      const base = shippingRequest([{ promotion }]);
      expect(yield* Effect.flip(selectShippingPromotion({ ...base, selectedDelivery: Option.none() }))).toHaveProperty(
        'code',
        'UNAVAILABLE',
      );
      if (Option.isNone(base.selectedDelivery)) {
        return;
      }
      for (const facts of [
        { ...base.selectedDelivery.value, purchaseRef: 'other' },
        { ...base.selectedDelivery.value, validUntil: at },
        { ...base.selectedDelivery.value, methodRef: { ...method, tenantId: a } },
      ]) {
        expect(
          (yield* Effect.flip(selectShippingPromotion({ ...base, selectedDelivery: Option.some(facts) }))).code,
        ).toBe('UNVERIFIABLE');
      }
      expect(yield* Effect.flip(selectShippingPromotion({ ...base, shippingRanking: [a, a] }))).toHaveProperty(
        'code',
        'CONFIGURATION_CONFLICT',
      );
      const wrongMethod = yield* selectShippingPromotion({
        ...base,
        selectedDelivery: Option.some({
          ...base.selectedDelivery.value,
          methodRef: { ...method, resourceId: 'other-method' },
        }),
      });
      expect(wrongMethod.selected).toEqual(Option.none());
    }),
  );
});

describe('private management draft calculation', () => {
  it.effect('uses the same product and cart arithmetic without inventing publication or Voucher identities', () =>
    Effect.gen(function* test() {
      const line = yield* makeLine('O1');
      const productMeaning = (yield* makePromotion('PRODUCT_VOUCHER', a)).meaning;
      const cartMeaning = (yield* makePromotion('CART_VOUCHER', b, percentage('10'))).meaning;
      const product = yield* createPromotionDraft({ meaning: productMeaning, promotionId: a }, publishedAt);
      const cart = yield* createPromotionDraft({ meaning: cartMeaning, promotionId: b }, publishedAt);
      const result = yield* selectMerchandisePromotions(
        purchase([line], {
          cartCandidates: [{ preview: 'EXPLICIT_DRAFT_PREVIEW', promotion: cart }],
          cartRanking: [b],
          evaluationMode: 'MANAGEMENT_PREVIEW',
          productVouchers: [{ occurrenceId: 'O1', preview: 'EXPLICIT_DRAFT_PREVIEW', promotion: product }],
        }),
      );
      expect(result.lines[0]?.exactRemainingAmount).toBe('810');
      expect(result.productApplications).toHaveLength(1);
      expect(result.productApplications[0]).not.toHaveProperty('voucherRef');
      expect(result.cartApplication.pipe(Option.map((application) => application.appliedBenefit))).toEqual(
        Option.some('90'),
      );
      if (Option.isSome(result.cartApplication)) {
        expect(result.cartApplication.value).not.toHaveProperty('voucherRef');
      }
      expect(product.status).toBe('DRAFT');
      expect(product).not.toHaveProperty('publishedAt');
      expect(cart).not.toHaveProperty('publishedAt');
    }),
  );

  it.effect('rejects a draft marker in a real calculation and requires the explicit marker in management mode', () =>
    Effect.gen(function* test() {
      const line = yield* makeLine('O1');
      const { meaning } = yield* makePromotion('PRODUCT_VOUCHER', a);
      const draft = yield* createPromotionDraft({ meaning, promotionId: a }, publishedAt);
      const real = yield* Effect.flip(
        selectMerchandisePromotions(
          purchase([line], {
            productVouchers: [{ occurrenceId: 'O1', preview: 'EXPLICIT_DRAFT_PREVIEW', promotion: draft }],
          }),
        ),
      );
      expect(real).toHaveProperty('code', 'INVALID_REQUEST');
      const unmarked = yield* Effect.flip(
        selectMerchandisePromotions(
          purchase([line], {
            evaluationMode: 'MANAGEMENT_PREVIEW',
            productVouchers: [{ occurrenceId: 'O1', promotion: draft }],
          }),
        ),
      );
      expect(unmarked).toHaveProperty('code', 'INELIGIBLE_CHOICE');
    }),
  );

  it.effect('rejects fabricated publication, Voucher bindings and invalid draft lifecycle facts', () =>
    Effect.gen(function* test() {
      const line = yield* makeLine('O1');
      const published = yield* makePromotion('PRODUCT_VOUCHER', a);
      const draft = yield* createPromotionDraft({ meaning: published.meaning, promotionId: a }, publishedAt);
      for (const candidate of [
        { promotion: published },
        { promotion: draft, voucherId },
        { promotion: { ...draft, publishedAt } },
      ]) {
        const error = yield* Effect.flip(
          selectMerchandisePromotions(
            purchase([line], {
              evaluationMode: 'MANAGEMENT_PREVIEW',
              productVouchers: [{ ...candidate, occurrenceId: 'O1', preview: 'EXPLICIT_DRAFT_PREVIEW' }],
            }),
          ),
        );
        expect(error).toHaveProperty('code', 'INVALID_REQUEST');
      }
      const unboundPublished = yield* Effect.flip(
        selectMerchandisePromotions(
          purchase([line], {
            productVouchers: [{ occurrenceId: 'O1', promotion: published }],
          }),
        ),
      );
      expect(unboundPublished).toHaveProperty('code', 'INELIGIBLE_CHOICE');
    }),
  );

  it.effect('previews Shipping drafts through the same verified owner facts and independent ranking', () =>
    Effect.gen(function* test() {
      const published = yield* makePromotion('SHIPPING_VOUCHER', a);
      const draft = yield* createPromotionDraft({ meaning: published.meaning, promotionId: a }, publishedAt);
      const candidate: PromotionCandidate = { preview: 'EXPLICIT_DRAFT_PREVIEW', promotion: draft };
      const result = yield* selectShippingPromotion(
        shippingRequest([candidate], { evaluationMode: 'MANAGEMENT_PREVIEW' }),
      );
      expect(result.selected.pipe(Option.map((choice) => choice.promotion.promotionId))).toEqual(Option.some(a));
      if (Option.isSome(result.selected)) {
        expect(result.selected.value).not.toHaveProperty('voucherId');
      }
      const real = yield* Effect.flip(selectShippingPromotion(shippingRequest([candidate])));
      expect(real).toHaveProperty('code', 'INVALID_REQUEST');
      const missingDelivery = yield* Effect.flip(
        selectShippingPromotion(
          shippingRequest([candidate], {
            evaluationMode: 'MANAGEMENT_PREVIEW',
            selectedDelivery: Option.none(),
          }),
        ),
      );
      expect(missingDelivery).toHaveProperty('code', 'UNAVAILABLE');
    }),
  );
  it.effect('retains actual zero-capacity reasons without ranking them ahead of positive recipients', () =>
    Effect.gen(function* zeroCapacityReasons() {
      const zero = yield* makeLine('O-zero', '0');
      const positive = yield* makeLine('O-positive', '1000', {
        ...productSelection,
        variantRef: { ...productSelection.variantRef, resourceId: c },
      });
      const product = yield* makePromotion('PRODUCT_VOUCHER', b);
      const zeroCart = yield* makePromotion('AUTOMATIC_CART', a);
      const limited = {
        ...zeroCart,
        meaning: {
          ...zeroCart.meaning,
          eligibility: { ...zeroCart.meaning.eligibility, eligibleSelections: [zero.occurrence.selection] },
        },
      };
      const positiveCart = yield* makePromotion('AUTOMATIC_CART', c);
      const result = yield* selectMerchandisePromotions(
        purchase([zero, positive], {
          cartCandidates: [{ promotion: limited }, { promotion: positiveCart }],
          cartRanking: [c],
          productVouchers: [{ occurrenceId: 'O-zero', promotion: product, voucherId }],
        }),
      );
      expect(result.notApplicable.map((entry) => ({ layer: entry.layer, reason: entry.reason }))).toEqual([
        { layer: 'PRODUCT', reason: 'NO_POSITIVE_ELIGIBLE_BASIS' },
        { layer: 'CART', reason: 'NO_POSITIVE_ELIGIBLE_BASIS' },
      ]);
      expect(result.cartApplication.pipe(Option.map((application) => application.promotionRef.resourceId))).toEqual(
        Option.some(c),
      );
      const alone = yield* selectMerchandisePromotions(
        purchase([zero], { cartCandidates: [{ promotion: zeroCart }], cartRanking: [] }),
      );
      expect(alone.cartApplication).toEqual(Option.none());
      expect(alone.notApplicable[0]?.reason).toBe('NO_POSITIVE_ELIGIBLE_BASIS');
    }),
  );

  it.effect(
    'ranks applicable cart benefits after retaining zero-effect outcomes and still requires positive-offer priority',
    () =>
      Effect.gen(function* zeroBenefitCompetition() {
        const line = yield* makeLine('O1');
        for (const effect of [fixed('0'), percentage('0')]) {
          const zero = yield* makePromotion('AUTOMATIC_CART', a, effect);
          const positive = yield* makePromotion('AUTOMATIC_CART', b, fixed('100'));
          const candidates = [{ promotion: zero }, { promotion: positive }];
          const result = yield* selectMerchandisePromotions(
            purchase([line], { cartCandidates: candidates, cartRanking: [a, b] }),
          );
          expect(result.cartApplication.pipe(Option.map((application) => application.promotionRef.resourceId))).toEqual(
            Option.some(b),
          );
          expect(result.lines[0]?.exactRemainingAmount).toBe('900');
          expect(result.notApplicable).toMatchObject([
            { layer: 'CART', promotionRef: { resourceId: a }, reason: 'ZERO_BENEFIT' },
          ]);
          const missingPriority = yield* Effect.flip(
            selectMerchandisePromotions(purchase([line], { cartCandidates: candidates, cartRanking: [a] })),
          );
          expect(Schema.is(PromotionSelectionFailure)(missingPriority)).toBe(true);
          expect(missingPriority).toHaveProperty('code', 'CONFIGURATION_CONFLICT');
        }
      }),
  );

  it.effect('retains configured zero-benefit outcomes without creating applications or credits', () =>
    Effect.gen(function* zeroBenefitReasons() {
      const line = yield* makeLine('O1');
      const product = yield* makePromotion('PRODUCT_VOUCHER', b, fixed('0'));
      const cart = yield* makePromotion('AUTOMATIC_CART', a, percentage('0'));
      const result = yield* selectMerchandisePromotions(
        purchase([line], {
          cartCandidates: [{ promotion: cart }],
          cartRanking: [a],
          productVouchers: [{ occurrenceId: 'O1', promotion: product, voucherId }],
        }),
      );
      expect(result.productApplications).toEqual([]);
      expect(result.cartApplication).toEqual(Option.none());
      expect(result.notApplicable.map((entry) => entry.reason)).toEqual(['ZERO_BENEFIT', 'ZERO_BENEFIT']);
      expect(result.lines[0]?.exactRemainingAmount).toBe('1000');
    }),
  );
});

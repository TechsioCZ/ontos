import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  AutomaticFreeShippingMeaningSchema,
  CreatePromotionDraftPayloadSchema,
  PromotionInstantSchema,
  PromotionOccurrenceSchema,
  ShippingVoucherMeaningSchema,
} from '../../shared/resources/promotion.ts';
import {
  isMonetaryPromotion,
  isPromotionEffectiveAt,
  isPromotionOccurrenceEligible,
  isShippingPromotion,
  validatePromotionMeaning,
  validatePromotionMeaningValue,
} from '../../src/services/definition.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const from = '2026-11-06T10:00:00Z';
const to = '2026-11-07T10:00:00Z';
const selection = {
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
const method = { moduleId: 'delivery.offer', resourceId: 'method-A', resourceType: 'delivery.method', tenantId };
const common = {
  displayName: 'Autumn offer',
  effectivePeriod: { from, to },
  eligibility: {
    commercialScopes: [{ channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: tenantId }],
  },
};
const cart = {
  ...common,
  activation: 'AUTOMATIC',
  benefit: { kind: 'PERCENTAGE', percentage: '10' },
  family: 'AUTOMATIC_CART',
  target: 'MERCHANDISE_CART',
};
const shipping = {
  ...common,
  activation: 'AUTOMATIC',
  allowedMethodRefs: [method],
  benefit: { kind: 'FREE_SHIPPING' },
  family: 'AUTOMATIC_FREE_SHIPPING',
  target: 'SELECTED_DELIVERY_OFFER',
};
const occurrence = {
  occurrenceId: 'purchase-line-A',
  quantity: {
    amount: '2.0',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: tenantId,
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  selection,
};

describe('Promotion Launch family definitions', () => {
  it.effect('accepts exactly the supported activation, target and benefit combinations', () =>
    Effect.gen(function* acceptFamilies() {
      const product = yield* validatePromotionMeaning({
        ...cart,
        activation: 'VOUCHER',
        family: 'PRODUCT_VOUCHER',
        target: 'PURCHASE_DEMAND_OCCURRENCE',
      });
      const voucher = yield* validatePromotionMeaning({ ...cart, activation: 'VOUCHER', family: 'CART_VOUCHER' });
      const automatic = yield* validatePromotionMeaning(cart);
      const free = yield* validatePromotionMeaning(shipping);
      const shippingVoucher = yield* validatePromotionMeaning({
        ...shipping,
        activation: 'VOUCHER',
        family: 'SHIPPING_VOUCHER',
      });
      expect([product, voucher, automatic].every(isMonetaryPromotion)).toBe(true);
      expect([free, shippingVoucher].every(isShippingPromotion)).toBe(true);
      expect(free).not.toHaveProperty('minimumMerchandise');
      expect(free).not.toHaveProperty('shippingAmount');
      expect(free.target).toBe('SELECTED_DELIVERY_OFFER');
    }),
  );

  it.effect('preserves exact fixed reductions and optional published CZK shipping minimum', () =>
    Effect.gen(function* exactMoney() {
      const fixed = yield* validatePromotionMeaning({
        ...cart,
        benefit: { amount: '0.000001', currencyCode: 'CZK', kind: 'FIXED_MONETARY_AMOUNT' },
      });
      const free = yield* validatePromotionMeaning({
        ...shipping,
        minimumMerchandise: { amount: '1500', currencyCode: 'CZK' },
      });
      expect(fixed.benefit).toEqual({ amount: '0.000001', currencyCode: 'CZK', kind: 'FIXED_MONETARY_AMOUNT' });
      expect(free).toHaveProperty('minimumMerchandise', { amount: '1500', currencyCode: 'CZK' });
    }),
  );

  it.effect('rejects unsupported families, target combinations and privately invented Shipping amounts', () =>
    Effect.gen(function* rejectFamilies() {
      const invalid = [
        { ...cart, target: 'PURCHASE_DEMAND_OCCURRENCE' },
        { ...cart, family: 'AUTOMATIC_PRODUCT' },
        { ...cart, family: 'PRODUCT_VOUCHER' },
        { ...cart, benefit: { amount: '10', kind: 'FIXED_SELLING_PRICE' } },
        { ...cart, benefit: { kind: 'LOYALTY_POINTS', points: '10' } },
        { ...cart, benefit: { kind: 'FREE_SHIPPING' } },
        { ...cart, predicate: 'customer.isPreferred' },
        { ...cart, basisMode: 'NET_TAX_EXCLUSIVE' },
        { ...shipping, activation: 'VOUCHER' },
        { ...shipping, shippingAmount: { amount: '0', currencyCode: 'CZK' } },
        { ...shipping, benefit: { amount: '0', kind: 'FREE_SHIPPING' } },
        { ...shipping, allowedMethodRefs: [] },
        { ...shipping, allowedMethodRefs: [method, method] },
      ];
      for (const candidate of invalid) {
        const error = yield* Effect.flip(validatePromotionMeaning(candidate));
        expect(error.code).toBe('promotion_definition_invalid');
      }
    }),
  );

  it.effect(
    'rejects Catalog targeting for both Shipping families while retaining merchandise selection whitelists',
    () =>
      Effect.gen(function* shippingTargetBoundary() {
        const eligibility = { ...common.eligibility, eligibleSelections: [selection] };
        for (const family of [
          { activation: 'AUTOMATIC', schema: AutomaticFreeShippingMeaningSchema, value: 'AUTOMATIC_FREE_SHIPPING' },
          { activation: 'VOUCHER', schema: ShippingVoucherMeaningSchema, value: 'SHIPPING_VOUCHER' },
        ]) {
          const candidate = { ...shipping, activation: family.activation, eligibility, family: family.value };
          const invalidSchema = yield* Effect.flip(Schema.decodeUnknownEffect(family.schema)(candidate));
          expect(Schema.isSchemaError(invalidSchema)).toBe(true);
          const invalidDefinition = yield* Effect.flip(validatePromotionMeaning(candidate));
          expect(invalidDefinition.code).toBe('promotion_definition_invalid');
          const valid = yield* validatePromotionMeaning({
            ...shipping,
            activation: family.activation,
            family: family.value,
          });
          const invalidNative = yield* Effect.flip(validatePromotionMeaningValue({ ...valid, eligibility }));
          expect(invalidNative.code).toBe('promotion_definition_invalid');
          const invalidManagement = yield* Effect.flip(
            Schema.decodeUnknownEffect(CreatePromotionDraftPayloadSchema)({
              meaning: candidate,
              promotionId: tenantId,
              reason: 'Validate supported Shipping targeting',
            }),
          );
          expect(Schema.isSchemaError(invalidManagement)).toBe(true);
        }
        const monetary = yield* validatePromotionMeaning({ ...cart, eligibility });
        expect(monetary.eligibility.eligibleSelections).toEqual([selection]);
      }),
  );

  it.effect('rejects imprecise or out-of-range monetary definitions', () =>
    Effect.gen(function* rejectMoney() {
      const invalid = [
        { ...cart, benefit: { kind: 'PERCENTAGE', percentage: '100.000001' } },
        { ...cart, benefit: { kind: 'PERCENTAGE', percentage: 10 } },
        { ...cart, benefit: { kind: 'PERCENTAGE', percentage: '-1' } },
        { ...cart, benefit: { amount: '10', currencyCode: 'EUR', kind: 'FIXED_MONETARY_AMOUNT' } },
        { ...shipping, minimumMerchandise: { amount: '1499.995', currencyCode: 'CZK' } },
        { ...shipping, minimumMerchandise: { amount: '-1', currencyCode: 'CZK' } },
      ];
      for (const candidate of invalid) {
        const error = yield* Effect.flip(validatePromotionMeaning(candidate));
        expect(error.code).toBe('promotion_definition_invalid');
      }
    }),
  );

  it.effect('uses a valid UTC half-open period without requiring fractional seconds', () =>
    Effect.gen(function* effectivePeriod() {
      const meaning = yield* validatePromotionMeaning(cart);
      expect(isPromotionEffectiveAt(meaning, DateTime.makeUnsafe(from))).toBe(true);
      expect(isPromotionEffectiveAt(meaning, DateTime.makeUnsafe('2026-11-07T09:59:59.9Z'))).toBe(true);
      expect(isPromotionEffectiveAt(meaning, DateTime.makeUnsafe(to))).toBe(false);
      expect(isPromotionEffectiveAt(meaning, DateTime.makeUnsafe('2026-11-06T09:59:59.999Z'))).toBe(false);
      const invalidInstant = yield* Effect.flip(Schema.decodeUnknownEffect(PromotionInstantSchema)('invalid'));
      expect(invalidInstant).toBeDefined();
      const instant = yield* Schema.decodeUnknownEffect(PromotionInstantSchema)('2026-11-06T11:00:00+01:00');
      const encoded = yield* Schema.encodeEffect(PromotionInstantSchema)(instant);
      expect(encoded).toBe('2026-11-06T10:00:00.000Z');
      for (const period of [
        { from: to, to: from },
        { from, to: from },
      ]) {
        const error = yield* Effect.flip(validatePromotionMeaning({ ...cart, effectivePeriod: period }));
        expect(error.code).toBe('promotion_definition_invalid');
      }
    }),
  );

  it.effect('whitelists exact selections while preserving separate occurrences and original quantities', () =>
    Effect.gen(function* exactOccurrences() {
      const meaning = yield* validatePromotionMeaning({
        ...cart,
        eligibility: { ...common.eligibility, eligibleSelections: [selection] },
      });
      const first = yield* Schema.decodeUnknownEffect(PromotionOccurrenceSchema)(occurrence);
      const second = yield* Schema.decodeUnknownEffect(PromotionOccurrenceSchema)({
        ...occurrence,
        occurrenceId: 'purchase-line-B',
      });
      const other = yield* Schema.decodeUnknownEffect(PromotionOccurrenceSchema)({
        ...occurrence,
        selection: {
          ...selection,
          variantRef: { ...selection.variantRef, resourceId: '22222222-2222-4222-8222-222222222222' },
        },
      });
      const purchase = [first, second, other];
      expect(purchase.map((line) => isPromotionOccurrenceEligible(meaning, line))).toEqual([true, true, false]);
      expect(purchase.map((line) => line.occurrenceId)).toEqual([
        'purchase-line-A',
        'purchase-line-B',
        'purchase-line-A',
      ]);
      expect(first.quantity.amount).toBe('2.0');
      expect(
        Schema.is(PromotionOccurrenceSchema)({
          ...occurrence,
          quantity: {
            ...occurrence.quantity,
            unitRef: { ...occurrence.quantity.unitRef, tenantId: '22222222-2222-4222-8222-222222222222' },
          },
        }),
      ).toBe(false);
      const error = yield* Effect.flip(
        validatePromotionMeaning({
          ...cart,
          eligibility: { ...common.eligibility, eligibleSelections: [selection, selection] },
        }),
      );
      expect(error.code).toBe('promotion_definition_invalid');
    }),
  );
});

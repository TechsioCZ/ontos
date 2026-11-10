import { Schema, Effect } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { AutomaticFreeShippingMeaningSchema, AutomaticCartMeaningSchema } from '../../shared/resources/promotion.ts';
import {
  promotionMeaningFingerprint,
  validatePromotionMeaningTenant,
} from '../../src/services/administration.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const common = {
  displayName: 'Audit offer',
  effectivePeriod: { from: '2026-11-06T10:00:00Z' },
  eligibility: {
    commercialScopes: [{ channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: tenantId }],
  },
};
const cart = Schema.decodeUnknownSync(AutomaticCartMeaningSchema)({
  ...common,
  activation: 'AUTOMATIC',
  benefit: { kind: 'PERCENTAGE', percentage: '10' },
  family: 'AUTOMATIC_CART',
  target: 'MERCHANDISE_CART',
});

describe('Promotion management scope and audit', () => {
  it.effect('fingerprints encoded immutable meaning and changes when monetary meaning changes', () =>
    Effect.gen(function* auditFingerprint() {
      const initial = yield* promotionMeaningFingerprint(cart);
      const unchanged = yield* promotionMeaningFingerprint({ ...cart });
      const changed = yield* promotionMeaningFingerprint({
        ...cart,
        benefit: { kind: 'PERCENTAGE', percentage: '15' },
      });
      expect(initial).toMatch(/^[0-9a-f]{64}$/u);
      expect(unchanged).toBe(initial);
      expect(changed).not.toBe(initial);
    }),
  );

  it.effect('rejects cross-Tenant allowed methods and exact selection references', () =>
    Effect.gen(function* tenantReferenceGuard() {
      const shipping = Schema.decodeUnknownSync(AutomaticFreeShippingMeaningSchema)({
        ...common,
        activation: 'AUTOMATIC',
        allowedMethodRefs: [
          { moduleId: 'delivery.offer', resourceId: 'method-A', resourceType: 'delivery.method', tenantId },
        ],
        benefit: { kind: 'FREE_SHIPPING' },
        family: 'AUTOMATIC_FREE_SHIPPING',
        target: 'SELECTED_DELIVERY_OFFER',
      });
      yield* validatePromotionMeaningTenant(shipping, tenantId);
      const methodError = yield* Effect.flip(validatePromotionMeaningTenant(shipping, foreignTenantId));
      expect(methodError.code).toBe('INVALID_REFERENCE');
      const productRef = {
        moduleId: 'commerce.catalog',
        resourceId: tenantId,
        resourceType: 'commerce.catalog.product',
        tenantId,
      };
      const variantRef = {
        moduleId: 'commerce.catalog',
        resourceId: tenantId,
        resourceType: 'commerce.catalog.variant',
        tenantId,
      };
      const selected = Schema.decodeUnknownSync(AutomaticCartMeaningSchema)({
        ...common,
        activation: 'AUTOMATIC',
        benefit: { kind: 'PERCENTAGE', percentage: '10' },
        eligibility: { ...common.eligibility, eligibleSelections: [{ productRef, variantRef }] },
        family: 'AUTOMATIC_CART',
        target: 'MERCHANDISE_CART',
      });
      yield* validatePromotionMeaningTenant(selected, tenantId);
      expect((yield* Effect.flip(validatePromotionMeaningTenant(selected, foreignTenantId))).code).toBe(
        'INVALID_REFERENCE',
      );
    }),
  );
});

import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { PromotionRecordSchema } from '../../shared/resources/promotion.ts';
import { resolveVoucherChoice } from '../../src/services/voucher.service.ts';
import type { VoucherOwnerPort, VoucherResolutionContext } from '../../src/services/voucher.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const commercialScope = { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: tenantId } as const;
const at = DateTime.makeUnsafe('2026-11-06T10:00:00Z');
const end = '2026-11-07T10:00:00Z';
const base = {
  createdAt: '2026-11-06T09:00:00Z',
  promotionId: tenantId,
  publishedAt: '2026-11-06T09:00:00Z',
  status: 'PUBLISHED',
  technicalVersion: 2,
  updatedAt: '2026-11-06T09:00:00Z',
};
const common = {
  activation: 'VOUCHER',
  displayName: 'Reusable offer',
  effectivePeriod: { from: '2026-11-06T09:00:00Z', to: end },
  eligibility: { commercialScopes: [commercialScope] },
};
const cartMeaning = {
  ...common,
  benefit: { kind: 'PERCENTAGE', percentage: '10' },
  family: 'CART_VOUCHER',
  target: 'MERCHANDISE_CART',
};
const shippingMeaning = {
  ...common,
  allowedMethodRefs: [
    { moduleId: 'delivery.offer', resourceId: 'method-A', resourceType: 'delivery.method', tenantId },
  ],
  benefit: { kind: 'FREE_SHIPPING' },
  family: 'SHIPPING_VOUCHER',
  target: 'SELECTED_DELIVERY_OFFER',
};
const voucher = { disabled: false, normalizedCode: 'reusable', promotionId: tenantId, voucherId: tenantId };

describe('Reusable B2C Voucher activation', () => {
  it.effect('resolves sequential and concurrent purchases for the same and different customers without mutation', () =>
    Effect.gen(function* repeatedMonetaryActivation() {
      const promotion = yield* Schema.decodeUnknownEffect(PromotionRecordSchema)({ ...base, meaning: cartMeaning });
      const before = yield* Schema.encodeEffect(PromotionRecordSchema)(promotion);
      const port: VoucherOwnerPort = {
        findPromotion: () => Effect.succeed(Option.some({ promotion, tenantId })),
        findVoucher: () => Effect.succeed(Option.some({ tenantId, voucher })),
      };
      const context: VoucherResolutionContext = { at, commercialScope, target: { kind: 'CART' }, tenantId };
      // Customer/purchase labels are caller context; they never become usage-policy inputs or write commands.
      const purchases = [
        { customer: 'customer-A', purchase: 'purchase-1' },
        { customer: 'customer-A', purchase: 'purchase-2' },
        { customer: 'customer-B', purchase: 'purchase-3' },
      ];
      for (const purchase of purchases) {
        const result = yield* resolveVoucherChoice(port, context, ' reusable ');
        expect({ purchase: purchase.purchase, voucherId: result.voucher.voucherId }).toEqual({
          purchase: purchase.purchase,
          voucherId: tenantId,
        });
      }
      const concurrent = yield* Effect.all(
        purchases.map(() => resolveVoucherChoice(port, context, 'REUSABLE')),
        { concurrency: 'unbounded' },
      );
      expect(concurrent.map((result) => result.voucher.voucherId)).toEqual([tenantId, tenantId, tenantId]);
      expect(yield* Schema.encodeEffect(PromotionRecordSchema)(promotion)).toEqual(before);
      expect(voucher).toEqual({
        disabled: false,
        normalizedCode: 'reusable',
        promotionId: tenantId,
        voucherId: tenantId,
      });
      expect(
        (yield* Effect.flip(resolveVoucherChoice(port, { ...context, at: DateTime.makeUnsafe(end) }, 'REUSABLE'))).code,
      ).toBe('INACTIVE_PROMOTION');
    }),
  );

  it.effect('keeps shipping voucher activation reusable and rejects later deactivation without consumption', () =>
    Effect.gen(function* repeatedShippingActivation() {
      const promotion = yield* Schema.decodeUnknownEffect(PromotionRecordSchema)({ ...base, meaning: shippingMeaning });
      const port: VoucherOwnerPort = {
        findPromotion: () => Effect.succeed(Option.some({ promotion, tenantId })),
        findVoucher: () => Effect.succeed(Option.some({ tenantId, voucher })),
      };
      const context: VoucherResolutionContext = { at, commercialScope, target: { kind: 'SHIPPING' }, tenantId };
      const results = yield* Effect.all(
        [resolveVoucherChoice(port, context, 'REUSABLE'), resolveVoucherChoice(port, context, 'reusable')],
        { concurrency: 'unbounded' },
      );
      expect(results.map((result) => result.promotion.meaning.family)).toEqual([
        'SHIPPING_VOUCHER',
        'SHIPPING_VOUCHER',
      ]);
      expect(results.every((result) => result.voucher === voucher)).toBe(true);
      const disabledOwner: VoucherOwnerPort = {
        ...port,
        findPromotion: () => Effect.succeed(Option.some({ promotion: { ...promotion, disabledAt: at }, tenantId })),
      };
      expect((yield* Effect.flip(resolveVoucherChoice(disabledOwner, context, 'REUSABLE'))).code).toBe(
        'INACTIVE_PROMOTION',
      );
      expect(voucher.disabled).toBe(false);
      expect(promotion.disabledAt).toBeUndefined();
    }),
  );
});

import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PromotionOccurrenceSchema,
  PromotionRecordSchema,
  SetCartRankingPayloadSchema,
} from '../../shared/resources/promotion.ts';
import {
  ProvisionVoucherPayloadSchema,
  VoucherChoicesSchema,
  VoucherRecordSchema,
} from '../../shared/resources/voucher.ts';
import {
  normalizeVoucherCode,
  resolveVoucherChoice,
  transitionVoucherChoice,
  validateVoucherChoices,
  VoucherResolutionFailure,
} from '../../src/services/voucher.service.ts';
import type { VoucherOwnerPort, VoucherResolutionContext } from '../../src/services/voucher.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const at = DateTime.makeUnsafe('2026-11-06T10:00:00Z');
const commercialScope = { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: tenantId } as const;
const encodedPromotion = {
  createdAt: '2026-11-06T09:00:00Z',
  meaning: {
    activation: 'VOUCHER',
    benefit: { kind: 'PERCENTAGE', percentage: '10' },
    displayName: 'Cart voucher',
    effectivePeriod: { from: '2026-11-06T09:00:00Z', to: '2026-11-07T10:00:00Z' },
    eligibility: { commercialScopes: [commercialScope] },
    family: 'CART_VOUCHER',
    target: 'MERCHANDISE_CART',
  },
  promotionId: tenantId,
  publishedAt: '2026-11-06T09:00:00Z',
  status: 'PUBLISHED',
  technicalVersion: 2,
  updatedAt: '2026-11-06T09:00:00Z',
};
const voucher = { disabled: false, normalizedCode: 'leto10', promotionId: tenantId, voucherId: tenantId };
const context: VoucherResolutionContext = { at, commercialScope, target: { kind: 'CART' }, tenantId };

describe('Canonical Voucher activation', () => {
  it.effect('rejects case variants before owner IDs enter provisioning, ranking or customer choices', () =>
    Effect.gen(function* canonicalIds() {
      const canonicalId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
      const provision = {
        code: 'CODE-IDENTITY',
        promotionId: canonicalId,
        reason: 'Canonical owner identity',
        voucherId: canonicalId,
      };
      for (const id of [canonicalId.toUpperCase(), canonicalId.replace('a', 'A')]) {
        expect(Schema.is(Schema.toType(ProvisionVoucherPayloadSchema))({ ...provision, voucherId: id })).toBe(false);
        expect(Schema.is(Schema.toType(ProvisionVoucherPayloadSchema))({ ...provision, promotionId: id })).toBe(false);
        expect(
          Schema.is(SetCartRankingPayloadSchema)({
            expectedVersion: 0,
            orderedPromotionIds: [id],
            reason: provision.reason,
          }),
        ).toBe(false);
        const rejected = yield* Effect.flip(
          Schema.decodeUnknownEffect(ProvisionVoucherPayloadSchema)({ ...provision, voucherId: id }),
        );
        expect(Schema.isSchemaError(rejected)).toBe(true);
        for (const choices of [
          { cartVoucherId: id, product: [] },
          { product: [{ occurrenceId: 'line-a', voucherId: id }] },
          { product: [], shippingVoucherId: id },
        ]) {
          const invalidChoice = yield* Effect.flip(Schema.decodeUnknownEffect(VoucherChoicesSchema)(choices));
          expect(Schema.isSchemaError(invalidChoice)).toBe(true);
          expect(Schema.is(Schema.toType(VoucherChoicesSchema))(choices)).toBe(false);
        }
      }
    }),
  );

  it.effect(
    'round-trips canonical alphabetic UUIDs unchanged from provisioning into the chosen voucher reference',
    () =>
      Effect.gen(function* canonicalRoundTrip() {
        const canonicalId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
        const payload = {
          code: 'CODE-IDENTITY',
          promotionId: canonicalId,
          reason: 'Canonical owner identity',
          voucherId: canonicalId,
        };
        const decoded = yield* Schema.decodeUnknownEffect(ProvisionVoucherPayloadSchema)(payload);
        expect(yield* Schema.encodeEffect(ProvisionVoucherPayloadSchema)(decoded)).toEqual(payload);
        const choices = yield* Schema.decodeUnknownEffect(VoucherChoicesSchema)({
          cartVoucherId: decoded.voucherId,
          product: [],
        });
        expect(choices.cartVoucherId).toBe(canonicalId);
      }),
  );

  it.effect('normalizes publication and lookup identically while preserving canonical identity', () =>
    Effect.gen(function* normalization() {
      const promotion = yield* Schema.decodeUnknownEffect(PromotionRecordSchema)(encodedPromotion);
      const record = yield* Schema.decodeUnknownEffect(VoucherRecordSchema)(voucher);
      const port: VoucherOwnerPort = {
        findPromotion: (tenant, id) =>
          Effect.succeed(
            tenant === tenantId && id === promotion.promotionId ? Option.some({ promotion, tenantId }) : Option.none(),
          ),
        findVoucher: (tenant, code) =>
          Effect.succeed(
            tenant === tenantId && code === record.normalizedCode
              ? Option.some({ tenantId, voucher: record })
              : Option.none(),
          ),
      };
      for (const code of ['LETO10', 'leto10', ' LETO10 ']) {
        expect(yield* normalizeVoucherCode(code)).toBe('leto10');
        const result = yield* resolveVoucherChoice(port, context, code);
        expect(result.voucher.voucherId).toBe(tenantId);
        expect(result.promotion.promotionId).toBe(tenantId);
      }
      const absent = yield* Effect.flip(resolveVoucherChoice(port, context, 'missing'));
      expect(absent.code).toBe('UNKNOWN_CODE');
      const malformed = yield* Effect.flip(normalizeVoucherCode('   '));
      expect(malformed.code).toBe('MALFORMED_CHOICE');
    }),
  );

  it.effect('does not disclose foreign Tenant records or accept misattributed owner results', () =>
    Effect.gen(function* tenantAttribution() {
      const promotion = yield* Schema.decodeUnknownEffect(PromotionRecordSchema)(encodedPromotion);
      const port: VoucherOwnerPort = {
        findPromotion: () => Effect.succeed(Option.some({ promotion, tenantId })),
        findVoucher: () => Effect.succeed(Option.some({ tenantId: otherId, voucher })),
      };
      expect((yield* Effect.flip(resolveVoucherChoice(port, context, 'LETO10'))).code).toBe('UNKNOWN_CODE');
      const wrongBinding: VoucherOwnerPort = {
        ...port,
        findPromotion: () =>
          Effect.succeed(Option.some({ promotion: { ...promotion, promotionId: otherId }, tenantId })),
        findVoucher: () => Effect.succeed(Option.some({ tenantId, voucher })),
      };
      expect((yield* Effect.flip(resolveVoucherChoice(wrongBinding, context, 'LETO10'))).code).toBe(
        'OWNER_UNVERIFIABLE',
      );
    }),
  );

  it.effect('distinguishes inactive, ineligible, unavailable and unverifiable owner outcomes', () =>
    Effect.gen(function* outcomes() {
      const promotion = yield* Schema.decodeUnknownEffect(PromotionRecordSchema)(encodedPromotion);
      const port: VoucherOwnerPort = {
        findPromotion: () => Effect.succeed(Option.some({ promotion, tenantId })),
        findVoucher: () => Effect.succeed(Option.some({ tenantId, voucher })),
      };
      expect(
        (yield* Effect.flip(
          resolveVoucherChoice(port, { ...context, at: DateTime.makeUnsafe('2026-11-07T10:00:00Z') }, 'LETO10'),
        )).code,
      ).toBe('INACTIVE_PROMOTION');
      expect(
        (yield* Effect.flip(resolveVoucherChoice(port, { ...context, target: { kind: 'SHIPPING' } }, 'LETO10'))).code,
      ).toBe('INELIGIBLE_CONTEXT');
      expect(
        (yield* Effect.flip(
          resolveVoucherChoice(port, { ...context, commercialScope: { ...commercialScope, marketId: 'sk' } }, 'LETO10'),
        )).code,
      ).toBe('INELIGIBLE_CONTEXT');
      const unavailable: VoucherOwnerPort = {
        ...port,
        findVoucher: () =>
          Effect.fail(new VoucherResolutionFailure({ code: 'OWNER_UNAVAILABLE', reason: 'Owner unavailable' })),
      };
      expect((yield* Effect.flip(resolveVoucherChoice(unavailable, context, 'LETO10'))).code).toBe('OWNER_UNAVAILABLE');
      const unverifiable: VoucherOwnerPort = { ...port, findPromotion: () => Effect.succeed(Option.none()) };
      expect((yield* Effect.flip(resolveVoucherChoice(unverifiable, context, 'LETO10'))).code).toBe(
        'OWNER_UNVERIFIABLE',
      );
    }),
  );

  it.effect('requires explicit product removal before replacement and preserves independent shipping/cart slots', () =>
    Effect.gen(function* choiceTransitions() {
      const initial = yield* validateVoucherChoices({ product: [] });
      const selected = yield* transitionVoucherChoice(initial, {
        kind: 'SELECT_PRODUCT',
        occurrenceId: 'line-A',
        voucherId: tenantId,
      });
      expect(
        (yield* Effect.flip(
          transitionVoucherChoice(selected, { kind: 'SELECT_PRODUCT', occurrenceId: 'line-A', voucherId: otherId }),
        )).code,
      ).toBe('MALFORMED_CHOICE');
      const removed = yield* transitionVoucherChoice(selected, { kind: 'REMOVE_PRODUCT', occurrenceId: 'line-A' });
      const replaced = yield* transitionVoucherChoice(removed, {
        kind: 'SELECT_PRODUCT',
        occurrenceId: 'line-A',
        voucherId: otherId,
      });
      const withCart = yield* transitionVoucherChoice(replaced, { kind: 'SELECT_CART', voucherId: tenantId });
      const withShipping = yield* transitionVoucherChoice(withCart, { kind: 'SELECT_SHIPPING', voucherId: otherId });
      expect(withShipping).toEqual({
        cartVoucherId: tenantId,
        product: [{ occurrenceId: 'line-A', voucherId: otherId }],
        shippingVoucherId: otherId,
      });
      expect(selected).toEqual({ product: [{ occurrenceId: 'line-A', voucherId: tenantId }] });
      expect(
        (yield* Effect.flip(
          validateVoucherChoices({
            product: [
              { occurrenceId: 'line-A', voucherId: tenantId },
              { occurrenceId: 'line-A', voucherId: otherId },
            ],
          }),
        )).code,
      ).toBe('MALFORMED_CHOICE');
    }),
  );

  it.effect('resolves a product voucher for the exact eligible original occurrence only', () =>
    Effect.gen(function* exactProductTarget() {
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
      const promotion = yield* Schema.decodeUnknownEffect(PromotionRecordSchema)({
        ...encodedPromotion,
        meaning: {
          ...encodedPromotion.meaning,
          eligibility: { commercialScopes: [commercialScope], eligibleSelections: [selection] },
          family: 'PRODUCT_VOUCHER',
          target: 'PURCHASE_DEMAND_OCCURRENCE',
        },
      });
      const occurrence = yield* Schema.decodeUnknownEffect(PromotionOccurrenceSchema)({
        occurrenceId: 'original-line-A',
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
      });
      const port: VoucherOwnerPort = {
        findPromotion: () => Effect.succeed(Option.some({ promotion, tenantId })),
        findVoucher: () => Effect.succeed(Option.some({ tenantId, voucher })),
      };
      const result = yield* resolveVoucherChoice(
        port,
        { ...context, target: { kind: 'PRODUCT', occurrence } },
        'LETO10',
      );
      expect(result.promotion.meaning.family).toBe('PRODUCT_VOUCHER');
      expect(occurrence.occurrenceId).toBe('original-line-A');
      expect(occurrence.quantity.amount).toBe('2.0');
      const different = {
        ...occurrence,
        selection: { ...occurrence.selection, variantRef: { ...occurrence.selection.variantRef, resourceId: otherId } },
      };
      expect(
        (yield* Effect.flip(
          resolveVoucherChoice(port, { ...context, target: { kind: 'PRODUCT', occurrence: different } }, 'LETO10'),
        )).code,
      ).toBe('INELIGIBLE_CONTEXT');
    }),
  );
});

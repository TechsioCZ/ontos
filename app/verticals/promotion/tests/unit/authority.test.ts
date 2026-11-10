import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { validatePromotionMeaning } from '../../src/services/definition.service.ts';
import {
  createPromotionDraft,
  editPromotionDraft,
  isPromotionProspectivelyUsable,
  publishPromotion,
} from '../../src/services/lifecycle.service.ts';
import { PromotionIdSchema } from '../../shared/resources/promotion.ts';
import { VoucherIdSchema } from '../../shared/resources/voucher.ts';

const promotionId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const at = DateTime.makeUnsafe('2026-11-06T10:00:00Z');
const definition = {
  activation: 'AUTOMATIC',
  benefit: { kind: 'PERCENTAGE', percentage: '10' },
  displayName: 'Native owner offer',
  effectivePeriod: { from: DateTime.formatIso(at) },
  eligibility: { commercialScopes: [{ channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: tenantId }] },
  family: 'AUTOMATIC_CART',
  target: 'MERCHANDISE_CART',
};

describe('OntOS Promotion source authority', () => {
  it.effect('a new owner draft remains unusable until the owner publishes its immutable identity', () =>
    Effect.gen(function* canonicalPublication() {
      const meaning = yield* validatePromotionMeaning(definition);
      const draft = yield* createPromotionDraft({ meaning, promotionId }, at);
      expect(isPromotionProspectivelyUsable(draft, at)).toBe(false);
      const published = yield* publishPromotion(draft, { expectedVersion: 1, operationAt: at });
      expect(published.promotionId).toBe(promotionId);
      expect(isPromotionProspectivelyUsable(published, at)).toBe(true);
      const foreignChange = yield* validatePromotionMeaning({
        ...definition,
        benefit: { kind: 'PERCENTAGE', percentage: '50' },
      });
      const refusal = yield* Effect.flip(
        editPromotionDraft(published, foreignChange, { expectedVersion: 2, operationAt: at }),
      );
      expect(refusal).toHaveProperty('code', 'IMMUTABLE_MEANING');
      expect(published.meaning.benefit).toEqual({ kind: 'PERCENTAGE', percentage: '10' });
    }),
  );

  it.effect(
    'rejects legacy source authority fields and unsupported discount families at the owner meaning boundary',
    () =>
      Effect.gen(function* unsupportedForeignAuthority() {
        for (const candidate of [
          { ...definition, externalPromotionId: 'legacy-42' },
          { ...definition, importSource: { namespace: 'legacy', sourceRevision: 2 } },
          { ...definition, family: 'LOYALTY_POINTS' },
        ]) {
          const failure = yield* Effect.flip(validatePromotionMeaning(candidate));
          expect(failure).toHaveProperty('code', 'promotion_definition_invalid');
        }
      }),
  );

  it('does not interpret an external source identifier as a canonical Promotion or Voucher identity', () => {
    for (const identity of [PromotionIdSchema, VoucherIdSchema]) {
      expect(Schema.is(identity)('legacy:campaign:42')).toBe(false);
      expect(Schema.is(identity)(promotionId)).toBe(true);
    }
  });
});

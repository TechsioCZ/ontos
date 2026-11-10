import { DateTime, Effect, Schema } from 'effect';
import { AutomaticCartMeaningSchema } from '../../shared/resources/promotion.ts';
import { describe, expect, it } from 'effect-rstest';
import {
  createPromotionDraft,
  createSuccessorDraft,
  disablePromotion,
  editPromotionDraft,
  endPromotion,
  isPromotionProspectivelyUsable,
  publishPromotion,
  PromotionLifecycleRecordSchema,
  retirePromotion,
} from '../../src/services/lifecycle.service.ts';

const firstId = '11111111-1111-4111-8111-111111111111';
const successorId = '22222222-2222-4222-8222-222222222222';
const at = DateTime.makeUnsafe('2026-11-06T10:00:00Z');
const later = DateTime.makeUnsafe('2026-11-06T11:00:00Z');
const boundary = DateTime.makeUnsafe('2026-11-07T10:00:00Z');
const meaning = Schema.decodeSync(AutomaticCartMeaningSchema)({
  activation: 'AUTOMATIC',
  benefit: { kind: 'PERCENTAGE', percentage: '10' },
  displayName: 'Autumn cart offer',
  effectivePeriod: { from: DateTime.formatIso(at), to: DateTime.formatIso(boundary) },
  eligibility: {
    commercialScopes: [
      { channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: '33333333-3333-4333-8333-333333333333' },
    ],
  },
  family: 'AUTOMATIC_CART',
  target: 'MERCHANDISE_CART',
});

const draft = () => createPromotionDraft({ meaning, promotionId: firstId }, at);
const published = () =>
  draft().pipe(Effect.flatMap((record) => publishPromotion(record, { expectedVersion: 1, operationAt: at })));

describe('Promotion immutable lifecycle', () => {
  it.effect('edits an unpublished draft under the same identity and advances only its technical token', () =>
    Effect.gen(function* lifecycleCase1() {
      const initial = yield* draft();
      const changed = yield* editPromotionDraft(
        initial,
        { ...meaning, benefit: { kind: 'PERCENTAGE', percentage: '15' } },
        { expectedVersion: 1, operationAt: later },
      );
      expect(changed.promotionId).toBe(firstId);
      expect(changed.technicalVersion).toBe(2);
      expect(changed.meaning.benefit).toEqual({ kind: 'PERCENTAGE', percentage: '15' });
      expect(initial.meaning.benefit).toEqual({ kind: 'PERCENTAGE', percentage: '10' });
      expect(isPromotionProspectivelyUsable(changed, later)).toBe(false);
    }),
  );

  it.effect('rejects every attempted edit of published meaning', () =>
    Effect.gen(function* lifecycleCase2() {
      const original = yield* published();
      const error = yield* Effect.flip(
        editPromotionDraft(
          original,
          { ...meaning, displayName: 'Changed name' },
          { expectedVersion: 2, operationAt: later },
        ),
      );
      expect(error.code).toBe('IMMUTABLE_MEANING');
      expect(original.meaning).toEqual(meaning);
      const republish = yield* Effect.flip(publishPromotion(original, { expectedVersion: 2, operationAt: later }));
      expect(republish.code).toBe('IMMUTABLE_MEANING');
    }),
  );

  it.effect('publishes an active or scheduled offer with half-open applicability', () =>
    Effect.gen(function* lifecycleCase3() {
      const original = yield* published();
      expect(isPromotionProspectivelyUsable(original, at)).toBe(true);
      expect(isPromotionProspectivelyUsable(original, DateTime.makeUnsafe('2026-11-07T09:59:59.999Z'))).toBe(true);
      expect(isPromotionProspectivelyUsable(original, boundary)).toBe(false);
      expect(isPromotionProspectivelyUsable(original, DateTime.makeUnsafe('2026-11-06T09:59:59.999Z'))).toBe(false);
      const scheduled = yield* createPromotionDraft(
        { meaning: { ...meaning, effectivePeriod: { from: boundary } }, promotionId: successorId },
        at,
      );
      const future = yield* publishPromotion(scheduled, { expectedVersion: 1, operationAt: later });
      expect(isPromotionProspectivelyUsable(future, later)).toBe(false);
      expect(isPromotionProspectivelyUsable(future, boundary)).toBe(true);
    }),
  );

  it.effect('creates changed terms as a new successor and preserves predecessor identity and meaning', () =>
    Effect.gen(function* lifecycleCase4() {
      const original = yield* published();
      const replacement = yield* createSuccessorDraft(
        original,
        {
          meaning: {
            ...meaning,
            benefit: { kind: 'PERCENTAGE', percentage: '15' },
            effectivePeriod: { from: boundary },
          },
          promotionId: successorId,
        },
        { expectedVersion: 2, operationAt: later },
      );
      const successor = yield* publishPromotion(replacement, { expectedVersion: 1, operationAt: later }, original);
      expect(successor.promotionId).not.toBe(original.promotionId);
      expect(successor.predecessorPromotionId).toBe(original.promotionId);
      expect(successor.technicalVersion).toBe(2);
      expect(original.meaning).toEqual(meaning);
      expect(original.technicalVersion).toBe(2);
      expect(isPromotionProspectivelyUsable(original, boundary)).toBe(false);
      expect(isPromotionProspectivelyUsable(successor, boundary)).toBe(true);
    }),
  );

  it.effect(
    'preserves overlapping successor identities for explicit selection and rejects self-identity or missing predecessor',
    () =>
      Effect.gen(function* lifecycleCase5() {
        const original = yield* published();
        const self = yield* Effect.flip(
          createSuccessorDraft(original, { meaning, promotionId: firstId }, { expectedVersion: 2, operationAt: later }),
        );
        expect(self.code).toBe('IDENTITY_CONFLICT');
        const replacement = yield* createSuccessorDraft(
          original,
          { meaning, promotionId: successorId },
          { expectedVersion: 2, operationAt: later },
        );
        const missing = yield* Effect.flip(publishPromotion(replacement, { expectedVersion: 1, operationAt: later }));
        expect(missing.code).toBe('IDENTITY_CONFLICT');
        const overlapping = yield* publishPromotion(replacement, { expectedVersion: 1, operationAt: later }, original);
        expect(isPromotionProspectivelyUsable(original, later)).toBe(true);
        expect(isPromotionProspectivelyUsable(overlapping, later)).toBe(true);
        expect(overlapping.promotionId).not.toBe(original.promotionId);
      }),
  );

  it.effect('allows a scheduled successor exactly at an explicit predecessor End boundary', () =>
    Effect.gen(function* lifecycleCase6() {
      const original = yield* published();
      const ended = yield* endPromotion(original, later, { expectedVersion: 2, operationAt: later });
      const replacement = yield* createSuccessorDraft(
        ended,
        { meaning: { ...meaning, effectivePeriod: { from: later } }, promotionId: successorId },
        { expectedVersion: 3, operationAt: later },
      );
      const successor = yield* publishPromotion(replacement, { expectedVersion: 1, operationAt: later }, ended);
      expect(isPromotionProspectivelyUsable(ended, later)).toBe(false);
      expect(isPromotionProspectivelyUsable(successor, later)).toBe(true);
      expect(ended.meaning.effectivePeriod).toEqual(meaning.effectivePeriod);
    }),
  );

  it.effect('disable, End and retirement preserve published terms and historical applicability', () =>
    Effect.gen(function* lifecycleCase7() {
      const original = yield* published();
      const disabled = yield* disablePromotion(original, { expectedVersion: 2, operationAt: later });
      const ended = yield* endPromotion(original, later, { expectedVersion: 2, operationAt: later });
      const retired = yield* retirePromotion(original, { expectedVersion: 2, operationAt: later });
      for (const closed of [disabled, ended, retired]) {
        expect(closed.promotionId).toBe(firstId);
        expect(closed.meaning).toEqual(meaning);
        expect(isPromotionProspectivelyUsable(closed, at)).toBe(true);
        expect(isPromotionProspectivelyUsable(closed, later)).toBe(false);
        expect(closed.technicalVersion).toBe(3);
      }
      expect(original.disabledAt).toBeUndefined();
      expect(original.endedAt).toBeUndefined();
      expect(original.retiredAt).toBeUndefined();
    }),
  );

  it.effect('fails stale competing transitions without changing the winner', () =>
    Effect.gen(function* lifecycleCase8() {
      const original = yield* published();
      const winner = yield* disablePromotion(original, { expectedVersion: 2, operationAt: later });
      const stale = yield* Effect.flip(retirePromotion(winner, { expectedVersion: 2, operationAt: later }));
      expect(stale.code).toBe('STALE_VERSION');
      expect(winner.retiredAt).toBeUndefined();
      expect(winner.technicalVersion).toBe(3);
    }),
  );

  it.effect('rejects retroactive transitions, End extensions, invalid times and already expired publication', () =>
    Effect.gen(function* lifecycleCase9() {
      const original = yield* published();
      const retroactive = yield* Effect.flip(endPromotion(original, at, { expectedVersion: 2, operationAt: later }));
      expect(retroactive.code).toBe('INVALID_TIME');
      const extended = yield* Effect.flip(
        endPromotion(original, DateTime.makeUnsafe('2026-11-08T10:00:00Z'), { expectedVersion: 2, operationAt: later }),
      );
      expect(extended.code).toBe('INVALID_TIME');
      const disabled = yield* disablePromotion(original, { expectedVersion: 2, operationAt: later });
      const badTime = yield* Effect.flip(retirePromotion(disabled, { expectedVersion: 3, operationAt: at }));
      expect(badTime.code).toBe('INVALID_TIME');
      const expired = yield* draft();
      const cannotPublish = yield* Effect.flip(
        publishPromotion(expired, { expectedVersion: 1, operationAt: boundary }),
      );
      expect(cannotPublish.code).toBe('INVALID_TIME');
    }),
  );

  it.effect('rejects malformed persisted lifecycle state instead of treating it as publication', () =>
    Effect.gen(function* lifecycleCase10() {
      const initial = yield* draft();
      expect(Schema.is(PromotionLifecycleRecordSchema)({ ...initial, status: 'PUBLISHED' })).toBe(false);
      expect(Schema.is(PromotionLifecycleRecordSchema)({ ...initial, disabledAt: later })).toBe(false);
      expect(Schema.is(PromotionLifecycleRecordSchema)({ ...initial, predecessorPromotionId: firstId })).toBe(false);
      expect(Schema.is(PromotionLifecycleRecordSchema)({ ...initial, technicalVersion: 0 })).toBe(false);
    }),
  );

  it.effect('rejects draft lifecycle closure and repeated terminal transitions', () =>
    Effect.gen(function* lifecycleCase11() {
      const initial = yield* draft();
      const disableError = yield* Effect.flip(disablePromotion(initial, { expectedVersion: 1, operationAt: later }));
      const endError = yield* Effect.flip(endPromotion(initial, later, { expectedVersion: 1, operationAt: later }));
      const retireError = yield* Effect.flip(retirePromotion(initial, { expectedVersion: 1, operationAt: later }));
      expect(disableError.code).toBe('INVALID_STATE');
      expect(endError.code).toBe('INVALID_STATE');
      expect(retireError.code).toBe('INVALID_STATE');
      const original = yield* published();
      const disabled = yield* disablePromotion(original, { expectedVersion: 2, operationAt: later });
      expect((yield* Effect.flip(disablePromotion(disabled, { expectedVersion: 3, operationAt: later }))).code).toBe(
        'INVALID_STATE',
      );
      const retired = yield* retirePromotion(disabled, { expectedVersion: 3, operationAt: later });
      expect(retired.meaning).toEqual(original.meaning);
      expect((yield* Effect.flip(retirePromotion(retired, { expectedVersion: 4, operationAt: later }))).code).toBe(
        'INVALID_STATE',
      );
    }),
  );
});

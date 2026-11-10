import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Layer, Schema } from 'effect';
import { CartVoucherMeaningSchema } from '../../shared/resources/promotion.ts';
import { createPromotionDraft, publishPromotion } from '../../src/services/lifecycle.service.ts';
import { promotionPersistenceFactory } from '../../src/services/persistence.service.ts';

export const nativeServices = Layer.mergeAll(NodeCrypto.layer, NodeServices.layer);
export const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
export const makePersistenceFixture = Effect.fn('PromotionTest.persistenceFixture')(function* persistenceFixture() {
  const fixture = yield* makeNativeReadTestContext({
    contextPermissions: [],
    moduleId: 'commerce.promotion',
    ownerFixtureRetention: 'retain-complete-context',
  });
  const prepareOwner = <Value, Failure, Requirements>(
    producer: (
      transaction: ScopedTransactionExecutor,
      scope: OperationalScope,
    ) => Effect.Effect<Value, Failure, Requirements>,
  ) => fixture.prepareOwner(producer).pipe(Effect.provide(fixture.layer));
  return { ...fixture, prepareOwner };
});
export type PersistenceFixture = Effect.Success<ReturnType<typeof makePersistenceFixture>>;

/** Repository preparation only; management acceptance separately executes genuine Core Actions. */
export const seedPublishedPromotion = Effect.fn('PromotionTest.seedPublished')(function* seedPublished(
  fixture: PersistenceFixture,
) {
  const promotionId = yield* nextId;
  const actionInvocationId = yield* nextId;
  return yield* fixture.prepareOwner((transaction, scope) =>
    Effect.gen(function* seedOwner() {
      const service = yield* promotionPersistenceFactory(transaction, scope);
      const generation = yield* service.lockForWrite;
      const at = yield* service.operationAt;
      const meaning = yield* Schema.decodeUnknownEffect(CartVoucherMeaningSchema)({
        activation: 'VOUCHER',
        benefit: { kind: 'PERCENTAGE', percentage: '10' },
        displayName: 'Native persistence offer',
        effectivePeriod: { from: DateTime.formatIso(at) },
        eligibility: {
          commercialScopes: [{ channelId: 'B2C', marketId: 'cz', sellingLegalEntityId: scope.legalEntityId }],
        },
        family: 'CART_VOUCHER',
        target: 'MERCHANDISE_CART',
      });
      const draft = yield* createPromotionDraft({ meaning, promotionId }, at);
      const attribution = { actionInvocationId, reason: 'Native owner persistence fixture' };
      yield* service.saveDraft(draft, undefined, attribution);
      const published = yield* publishPromotion(draft, { expectedVersion: 1, operationAt: at });
      yield* service.savePublication(published, attribution);
      yield* service.bump(generation);
      return published;
    }),
  );
});

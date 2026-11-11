import { findPostgresFailure, loadDatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { DateTime, Effect, Exit, Layer, Option, Redacted, Result, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { describe, expect, it } from 'effect-rstest';
import { promotionPersistenceFactory, PromotionStateConflict } from '../../src/services/persistence.service.ts';
import { promotionRelations, publishedPromotions, vouchers } from '../../src/services/persistence-schema.service.ts';
import { normalizeVoucherCode } from '../../src/services/voucher.service.ts';
import {
  makePersistenceFixture,
  nativeServices,
  nextId,
  seedPublishedPromotion,
} from '../support/persistence.fixture.ts';

const retained = { reason: 'Native owner storage acceptance' };

describe('Promotion native PostgreSQL persistence', () => {
  it.live('reads do not initialize generation and transaction time stays authoritative and stable', () =>
    Effect.gen(function* stableOwnerTime() {
      const fixture = yield* makePersistenceFixture();
      yield* fixture.prepareOwner((transaction, scope) =>
        Effect.gen(function* emptyOwnerRead() {
          const service = yield* promotionPersistenceFactory(transaction, scope);
          expect(yield* service.generation()).toBe(0);
          expect(yield* service.loadPromotions()).toEqual([]);
          const first = yield* service.operationAt;
          const second = yield* service.operationAt;
          expect(DateTime.toEpochMillis(first)).toBe(DateTime.toEpochMillis(second));
          expect(yield* service.generation()).toBe(0);
        }),
      );
      const published = yield* seedPublishedPromotion(fixture);
      yield* fixture.prepareOwner((transaction, scope) =>
        Effect.gen(function* persistedIdentity() {
          const service = yield* promotionPersistenceFactory(transaction, scope);
          expect(yield* service.generation()).toBe(2);
          const loaded = yield* service.loadPromotion(published.promotionId);
          expect(loaded.technicalVersion).toBe(2);
          expect(loaded.meaning).toEqual(published.meaning);
          expect(loaded.status).toBe('PUBLISHED');
        }),
      );
    }).pipe(Effect.provide(nativeServices)),
  );

  it.live(
    'serializes trim/case code collisions, retains attribution after disable and permits another Tenant code',
    () =>
      Effect.gen(function* permanentVoucherAttribution() {
        const first = yield* makePersistenceFixture();
        const second = yield* makePersistenceFixture();
        const offer = yield* seedPublishedPromotion(first);
        const successor = yield* seedPublishedPromotion(first);
        const otherOffer = yield* seedPublishedPromotion(second);
        const initialId = yield* nextId;
        const competingId = yield* nextId;
        const firstInvocation = yield* nextId;
        const otherInvocation = yield* nextId;
        const codes = yield* Effect.all([normalizeVoucherCode(' SAVE10 '), normalizeVoucherCode('save10')], {
          concurrency: 2,
        });
        const attempts = yield* Effect.all(
          [
            first
              .prepareOwner((transaction, scope) =>
                Effect.gen(function* firstCode() {
                  const service = yield* promotionPersistenceFactory(transaction, scope);
                  const at = yield* service.operationAt;
                  yield* service.provisionVoucher(
                    {
                      ...retained,
                      actionInvocationId: firstInvocation,
                      normalizedCode: codes[0],
                      promotionId: offer.promotionId,
                      voucherId: initialId,
                    },
                    at,
                  );
                }),
              )
              .pipe(Effect.result),
            first
              .prepareOwner((transaction, scope) =>
                Effect.gen(function* competingCode() {
                  const service = yield* promotionPersistenceFactory(transaction, scope);
                  const at = yield* service.operationAt;
                  yield* service.provisionVoucher(
                    {
                      ...retained,
                      actionInvocationId: otherInvocation,
                      normalizedCode: codes[1],
                      promotionId: offer.promotionId,
                      voucherId: competingId,
                    },
                    at,
                  );
                }),
              )
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        expect(attempts.filter(Result.isSuccess)).toHaveLength(1);
        expect(attempts.filter(Result.isFailure)).toHaveLength(1);
        for (const attempt of attempts) {
          if (Result.isFailure(attempt)) {
            expect(Schema.is(PromotionStateConflict)(attempt.failure)).toBe(true);
            if (Schema.is(PromotionStateConflict)(attempt.failure)) {
              expect(attempt.failure.code).toBe('CODE_ALREADY_BOUND');
            }
          }
        }
        const winner = yield* first.prepareOwner((transaction, scope) =>
          promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.loadVouchers())),
        );
        expect(winner).toHaveLength(1);
        const selected = yield* Effect.fromOption(Option.fromUndefinedOr(winner[0]));
        const disableInvocation = yield* nextId;
        yield* first.prepareOwner((transaction, scope) =>
          Effect.gen(function* disableStoredCode() {
            const service = yield* promotionPersistenceFactory(transaction, scope);
            yield* service.disableVoucher(
              selected.voucherId,
              { ...retained, actionInvocationId: disableInvocation },
              yield* service.operationAt,
            );
          }),
        );
        const rebindId = yield* nextId;
        const rebindInvocation = yield* nextId;
        const rebind = yield* Effect.flip(
          first.prepareOwner((transaction, scope) =>
            Effect.gen(function* refuseRebind() {
              const service = yield* promotionPersistenceFactory(transaction, scope);
              yield* service.provisionVoucher(
                {
                  ...retained,
                  actionInvocationId: rebindInvocation,
                  normalizedCode: 'save10',
                  promotionId: successor.promotionId,
                  voucherId: rebindId,
                },
                yield* service.operationAt,
              );
            }),
          ),
        );
        expect(Schema.is(PromotionStateConflict)(rebind)).toBe(true);
        if (Schema.is(PromotionStateConflict)(rebind)) {
          expect(rebind.code).toBe('CODE_ALREADY_BOUND');
        }
        const permanent = yield* first.prepareOwner((transaction, scope) =>
          promotionPersistenceFactory(transaction, scope).pipe(Effect.andThen((service) => service.loadVouchers())),
        );
        expect(permanent).toEqual([{ ...selected, disabled: true }]);
        const otherId = yield* nextId;
        const otherActorInvocation = yield* nextId;
        yield* second.prepareOwner((transaction, scope) =>
          Effect.gen(function* ownTenantCode() {
            const service = yield* promotionPersistenceFactory(transaction, scope);
            yield* service.provisionVoucher(
              {
                ...retained,
                actionInvocationId: otherActorInvocation,
                normalizedCode: 'save10',
                promotionId: otherOffer.promotionId,
                voucherId: otherId,
              },
              yield* service.operationAt,
            );
            expect(yield* service.loadVouchers()).toHaveLength(1);
          }),
        );
      }).pipe(Effect.provide(nativeServices)),
  );

  it.live(
    'enforces immutable runtime grants, forced tenant isolation and same-tenant Voucher publication references',
    () =>
      Effect.gen(function* immutableScopeGuards() {
        const first = yield* makePersistenceFixture();
        const second = yield* makePersistenceFixture();
        const published = yield* seedPublishedPromotion(first);
        const illegalUpdate = yield* Effect.exit(
          first.prepareOwner((transaction) =>
            transaction
              .update(publishedPromotions)
              .set({ version: 99 })
              .where(eq(publishedPromotions.promotionId, published.promotionId)),
          ),
        );
        expect(Exit.isFailure(illegalUpdate)).toBe(true);
        if (Exit.isFailure(illegalUpdate)) {
          expect(findPostgresFailure(illegalUpdate.cause)).toEqual(Option.some({ code: '42501' }));
        }
        yield* second.prepareOwner((transaction) =>
          Effect.gen(function* foreignTenantRead() {
            const rows = yield* transaction
              .select()
              .from(publishedPromotions)
              .where(eq(publishedPromotions.promotionId, published.promotionId));
            expect(rows).toEqual([]);
          }),
        );
        const foreignVoucherId = yield* nextId;
        const foreignInvocationId = yield* nextId;
        const crossTenant = yield* Effect.exit(
          second.prepareOwner((transaction, scope) =>
            transaction.insert(vouchers).values({
              actionInvocationId: foreignInvocationId,
              actorPrincipalId: scope.principalId,
              normalizedCode: 'foreign-bound',
              promotionId: published.promotionId,
              reason: retained.reason,
              recordedAt: DateTime.toDateUtc(published.createdAt),
              tenantId: scope.tenantId,
              voucherId: foreignVoucherId,
            }),
          ),
        );
        expect(Exit.isFailure(crossTenant)).toBe(true);
        if (Exit.isFailure(crossTenant)) {
          expect(findPostgresFailure(crossTenant.cause)).toEqual(
            Option.some({ code: '23503', constraint: 'promotion_voucher_published_fk' }),
          );
        }
        const connections = yield* loadDatabaseConnectionPair();
        const withoutScope = Effect.gen(function* unscopedRuntimeRead() {
          const database = yield* makeWithDefaults({ relations: promotionRelations });
          return yield* database
            .select()
            .from(publishedPromotions)
            .where(eq(publishedPromotions.promotionId, published.promotionId));
        }).pipe(
          Effect.provide(
            PgClient.layer({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
              Layer.provideMerge(Reactivity.layer),
            ),
          ),
        );
        expect(yield* withoutScope).toEqual([]);
        const stillPublished = yield* first.prepareOwner((transaction, scope) =>
          promotionPersistenceFactory(transaction, scope).pipe(
            Effect.andThen((service) => service.loadPromotion(published.promotionId)),
          ),
        );
        expect(stillPublished.technicalVersion).toBe(2);
        expect(stillPublished.meaning).toEqual(published.meaning);
      }).pipe(Effect.provide(nativeServices)),
  );
});

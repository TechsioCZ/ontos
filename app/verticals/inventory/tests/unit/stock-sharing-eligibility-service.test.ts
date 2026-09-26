import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  EstablishStockSharingEligibilityInputSchema,
  StockSharingEligibilitySchema,
  TrustedCurrentCommercePurchasingContextSchema,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import type {
  StockSharingEligibility,
  StockSharingEligibilityPersistence,
} from '../../shared/domain/stock-sharing-eligibility.ts';
import { makeStockSharingEligibilityService } from '../../src/services/stock-sharing-eligibility-service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const ownerConfigurationRef = {
  moduleId: 'commerce.inventory',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
} as const;
const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: 'market-cz',
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const storefrontRef = { appId: 'shop-cz', tenantId } as const;
const effectiveFrom = '2026-09-24T10:00:00.000Z';
const establishInput = Schema.decodeUnknownSync(EstablishStockSharingEligibilityInputSchema)({
  effectiveFrom,
  scope: {
    customerConfigurationId: 'customer-configuration:primary',
    ownerConfigurationRef,
    positionRef,
  },
  subject: { channel: 'B2C', sellingLegalEntityRef },
});
const trustedContext = Schema.decodeUnknownSync(TrustedCurrentCommercePurchasingContextSchema)({
  channel: 'B2C',
  commerceMarketRef: marketRef,
  customerConfigurationId: 'customer-configuration:primary',
  evidenceRef: 'commerce-purchasing-context:1',
  observedAt: '2026-09-24T10:01:00.000Z',
  sellingLegalEntityRef,
  status: 'CURRENT_OWNER_VERIFIED',
  storefrontRef,
  tenantId,
});

const makePersistence = Effect.gen(function* makePersistence() {
  const state = yield* Ref.make<ReadonlyMap<string, StockSharingEligibility>>(new Map());
  const history = yield* Ref.make<
    readonly {
      readonly relation: StockSharingEligibility;
      readonly transitionAt: StockSharingEligibility['effectivePeriod']['from'];
    }[]
  >([]);
  const persistence: StockSharingEligibilityPersistence = {
    findByRef: (ref) => Ref.get(state).pipe(Effect.map((rows) => Option.fromNullishOr(rows.get(ref.resourceId)))),
    insertCurrent: (relation) =>
      Effect.gen(function* insertCurrent() {
        yield* Ref.update(history, (events) => [...events, { relation, transitionAt: relation.effectivePeriod.from }]);
        return yield* Ref.modify(
          state,
          (rows) => [relation, new Map(rows).set(relation.ref.resourceId, relation)] as const,
        );
      }),
    listCurrent: (scope) =>
      Ref.get(state).pipe(
        Effect.map((rows) =>
          [...rows.values()].filter(
            (relation) =>
              relation.lifecycle === 'CURRENT' &&
              relation.scope.positionRef.resourceId === scope.positionRef.resourceId &&
              relation.scope.customerConfigurationId === scope.customerConfigurationId &&
              relation.scope.ownerConfigurationRef.resourceId === scope.ownerConfigurationRef.resourceId,
          ),
        ),
      ),
    readHistory: () =>
      Ref.get(history).pipe(
        Effect.map((events) =>
          events.map(({ relation }, index) => {
            const successor = events[index + 1];
            return successor === undefined || relation.effectivePeriod.to !== null
              ? relation
              : Schema.decodeSync(StockSharingEligibilitySchema)({
                  ...relation,
                  effectivePeriod: { from: relation.effectivePeriod.from, to: successor.transitionAt },
                  lifecycle: 'ENDED',
                });
          }),
        ),
      ),
    saveRevision: ({ next }) =>
      Effect.gen(function* saveRevision() {
        yield* Ref.update(history, (events) => [
          ...events,
          { relation: next, transitionAt: next.effectivePeriod.to ?? next.effectivePeriod.from },
        ]);
        return yield* Ref.modify(state, (rows) => [next, new Map(rows).set(next.ref.resourceId, next)] as const);
      }),
  };
  return persistence;
});
const validator = {
  validateCurrent: () =>
    Effect.succeed({
      evidenceRef: 'commerce-validation:1',
      observedAt: effectiveFrom,
      verification: 'OWNER_VERIFIED_CURRENT' as const,
    }),
};

describe('Inventory Stock Sharing Eligibility owner service', () => {
  it.effect('unions positive Current relations without specificity precedence', () =>
    Effect.gen(function* unionPositiveRelations() {
      const persistence = yield* makePersistence;
      let sequence = 0;
      const service = makeStockSharingEligibilityService({
        commerceValidator: validator,
        makeEligibilityId: () => {
          sequence += 1;
          return `55555555-5555-4555-8555-55555555555${sequence}`;
        },
        persistence,
      });
      const broad = yield* service.establish(establishInput);
      const narrow = yield* service.establish({
        ...establishInput,
        subject: { ...establishInput.subject, commerceMarketRef: trustedContext.commerceMarketRef },
      });
      const outcome = yield* service.evaluate({ context: trustedContext, scope: establishInput.scope });

      expect(outcome.outcome).toBe('ELIGIBLE');
      expect(outcome.applicableRelationRefs).toEqual([broad.ref, narrow.ref]);
    }),
  );

  it.effect('fails closed for a different Channel and for unverifiable Current context evidence', () =>
    Effect.gen(function* failClosed() {
      const persistence = yield* makePersistence;
      const service = makeStockSharingEligibilityService({
        commerceValidator: validator,
        makeEligibilityId: () => '55555555-5555-4555-8555-555555555555',
        persistence,
      });
      yield* service.establish(establishInput);
      const channelFailure = yield* service
        .evaluate({ context: { ...trustedContext, channel: 'B2B' }, scope: establishInput.scope })
        .pipe(Effect.flip);
      const evidenceFailure = yield* service
        .evaluate({
          context: {
            _tag: 'UNVERIFIABLE',
            customerConfigurationId: establishInput.scope.customerConfigurationId,
            reason: 'OWNER_EVIDENCE_INDETERMINATE',
            tenantId,
          },
          scope: establishInput.scope,
        })
        .pipe(Effect.flip);

      expect(channelFailure).toMatchObject({ reason: 'NO_APPLICABLE_CURRENT_RELATION' });
      expect(evidenceFailure).toMatchObject({ reason: 'COMMERCE_CONTEXT_UNVERIFIABLE' });
    }),
  );

  it.effect('retains established, changed, and ended revisions with closed historical intervals', () =>
    Effect.gen(function* endWithoutReservationMutation() {
      const persistence = yield* makePersistence;
      const service = makeStockSharingEligibilityService({
        commerceValidator: validator,
        makeEligibilityId: () => '55555555-5555-4555-8555-555555555555',
        persistence,
      });
      const established = yield* service.establish(establishInput);
      const changed = yield* service.change({
        changedAt: '2026-09-24T10:30:00.000Z',
        relationRef: established.ref,
        subject: { ...established.subject, storefrontRef: trustedContext.storefrontRef },
      });
      const ended = yield* service.end({ endedAt: '2026-09-24T11:00:00.000Z', relationRef: changed.ref });
      const failure = yield* service
        .evaluate({ context: trustedContext, scope: establishInput.scope })
        .pipe(Effect.flip);
      const history = yield* persistence.readHistory(established.ref);

      expect(ended.lifecycle).toBe('ENDED');
      expect(failure).toMatchObject({ reason: 'NO_APPLICABLE_CURRENT_RELATION' });
      expect(history.map(({ revision }) => revision)).toEqual([1, 2, 3]);
      expect(history.map(({ lifecycle }) => lifecycle)).toEqual(['ENDED', 'ENDED', 'ENDED']);
      expect(history[0]?.effectivePeriod).toEqual({
        from: '2026-09-24T10:00:00.000Z',
        to: '2026-09-24T10:30:00.000Z',
      });
      expect(history[1]?.effectivePeriod).toEqual({
        from: '2026-09-24T10:30:00.000Z',
        to: '2026-09-24T11:00:00.000Z',
      });
      expect(history[2]).toEqual(ended);
      expect(service).not.toHaveProperty('reservationPersistence');
    }),
  );

  it.effect('ending one narrower relation does not negate a remaining broad relation', () =>
    Effect.gen(function* positiveUnionAfterEnd() {
      const persistence = yield* makePersistence;
      let sequence = 0;
      const service = makeStockSharingEligibilityService({
        commerceValidator: validator,
        makeEligibilityId: () => {
          sequence += 1;
          return `55555555-5555-4555-8555-55555555555${sequence}`;
        },
        persistence,
      });
      const broad = yield* service.establish(establishInput);
      const narrow = yield* service.establish({
        ...establishInput,
        subject: { ...establishInput.subject, commerceMarketRef: trustedContext.commerceMarketRef },
      });
      yield* service.end({ endedAt: '2026-09-24T11:00:00.000Z', relationRef: narrow.ref });
      const outcome = yield* service.evaluate({ context: trustedContext, scope: establishInput.scope });

      expect(outcome.applicableRelationRefs).toEqual([broad.ref]);
    }),
  );
});

/* oxlint-disable sonarjs/no-nested-functions -- The race harness deliberately nests transaction, candidate, and fiber seams so their shared lock lifetime stays explicit; expires: 2027-03-31. */
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Ref, Schema, Semaphore } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { ResolvedCatalogStockDemandSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import { StockAllocationIdSchema } from '../../shared/domain/inventory-obligation.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { TrustedCurrentCommercePurchasingContextSchema } from '../../shared/domain/stock-sharing-eligibility.ts';
import { makeReservationAllocationPlanner } from '../../src/services/reservation-allocation-planner.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const configurationId = '22222222-2222-4222-8222-222222222222';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const authority = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId: 'customer-configuration-primary',
  revision: 1,
  selectedAt: '2026-09-24T10:00:00.000Z',
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-primary',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});
const commerceContext = Schema.decodeUnknownSync(TrustedCurrentCommercePurchasingContextSchema)({
  channel: 'B2C',
  commerceMarketRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: 'market-primary',
    resourceType: 'commerce.market-catalog.market',
    tenantId,
  },
  customerConfigurationId: authority.customerConfigurationId,
  evidenceRef: 'commerce-context:concurrency',
  observedAt: '2026-09-24T10:00:00.000Z',
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  status: 'CURRENT_OWNER_VERIFIED',
  storefrontRef: { appId: 'storefront-primary', tenantId },
  tenantId,
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  packageRef: {
    moduleId: 'commerce.catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.package',
    tenantId,
  },
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const effectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)('concurrent-reservation-effect');

const stockItem = (resourceId: string) =>
  Schema.decodeUnknownSync(StockItemSchema)({
    createdAt: '2026-09-24T10:00:00.000Z',
    exactSelectionMeaning: { id: `meaning:${resourceId}`, kind: 'PACKAGE_OPTION' },
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    unitRef,
  });

const demand = (occurrenceId: string, item: ReturnType<typeof stockItem>) =>
  Schema.decodeUnknownSync(ResolvedCatalogStockDemandSchema)({
    bindingRef: {
      moduleId: 'commerce.inventory',
      resourceId: item.stockItemRef.resourceId,
      resourceType: 'commerce.inventory.catalog-to-stock-binding',
      tenantId,
    },
    catalogSelection: selection,
    exactSelectionMeaning: item.exactSelectionMeaning,
    purchaseDemandOccurrenceId: occurrenceId,
    quantity: '1',
    stockItem: item,
    unitRef,
  });

const position = (resourceId: string, item: ReturnType<typeof stockItem>, onHand = '1') =>
  Schema.decodeUnknownSync(StockPositionSchema)({
    createdAt: '2026-09-24T10:00:00.000Z',
    endedAt: null,
    lifecycle: 'CURRENT',
    onHand: {
      _tag: 'CURRENT',
      evidenceRef: `stock:${resourceId}`,
      meaning: 'ON_HAND',
      observedAt: '2026-09-24T10:00:00.000Z',
      ownerConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: configurationId,
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      quantity: { amount: onHand, unitRef },
    },
    ref: {
      moduleId: 'commerce.inventory',
      resourceId,
      resourceType: 'commerce.inventory.stock-position',
      tenantId,
    },
    revision: 1,
    scope: {
      customerConfigurationId: authority.customerConfigurationId,
      stockItemRef: item.stockItemRef,
      stockLocationRef: {
        moduleId: 'commerce.inventory',
        resourceId,
        resourceType: 'commerce.inventory.stock-location',
        tenantId,
      },
      unitRef,
    },
  });

describe('Inventory concurrent Reservation creation', () => {
  it.effect('locks exact Stock Item scopes in one canonical order regardless of request arrival order', () =>
    Effect.gen(function* canonicalContentionOrder() {
      const itemA = stockItem('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const itemB = stockItem('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      const positions = new Map([
        [itemA.stockItemRef.resourceId, position('cccccccc-cccc-4ccc-8ccc-cccccccccccc', itemA)],
        [itemB.stockItemRef.resourceId, position('dddddddd-dddd-4ddd-8ddd-dddddddddddd', itemB)],
      ]);
      const firstOrder: string[] = [];
      const secondOrder: string[] = [];
      const plan = (order: string[]) =>
        makeReservationAllocationPlanner({
          candidates: {
            lockCurrentForItem: (_effect, _authority, currentDemand) =>
              Effect.sync(() => {
                const itemId = currentDemand.stockItem.stockItemRef.resourceId;
                order.push(itemId);
                const candidate = positions.get(itemId);
                return candidate === undefined ? [] : [{ position: candidate, reservedAmount: '0' }];
              }),
          },
          eligibility: { isEligible: () => Effect.succeed(true) },
          makeAllocationId: ({ effectId: id, positionId, purchaseDemandOccurrenceId }) =>
            Schema.decodeUnknownSync(StockAllocationIdSchema)(`${id}:${purchaseDemandOccurrenceId}:${positionId}`),
        });

      const firstRequirements = yield* plan(firstOrder).plan(
        effectId,
        authority,
        [demand('occurrence-b', itemB), demand('occurrence-a', itemA)],
        commerceContext,
      );
      const secondRequirements = yield* plan(secondOrder).plan(
        effectId,
        authority,
        [demand('occurrence-a', itemA), demand('occurrence-b', itemB)],
        commerceContext,
      );

      expect(firstOrder).toEqual(secondOrder);
      expect(firstOrder).toEqual([itemA.stockItemRef.resourceId, itemB.stockItemRef.resourceId]);
      expect(firstRequirements.map(({ purchaseDemandOccurrenceId }) => purchaseDemandOccurrenceId)).toEqual([
        'occurrence-b',
        'occurrence-a',
      ]);
      expect(secondRequirements.map(({ purchaseDemandOccurrenceId }) => purchaseDemandOccurrenceId)).toEqual([
        'occurrence-a',
        'occurrence-b',
      ]);
    }),
  );

  it.effect('allows at most one complete B2C/B2B Reservation when two Positions hold the final quantity', () =>
    Effect.gen(function* finalQuantityRace() {
      const item = stockItem('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const candidatePositions = [
        position('cccccccc-cccc-4ccc-8ccc-cccccccccccc', item, '0.6'),
        position('dddddddd-dddd-4ddd-8ddd-dddddddddddd', item, '0.4'),
      ];
      const reservedByPosition = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
      const contentionGate = yield* Semaphore.make(1);
      const attempt = (attemptEffectId: string, context: typeof commerceContext) =>
        Semaphore.withPermits(
          contentionGate,
          1,
        )(
          Effect.gen(function* serializedAttempt() {
            const decodedEffectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)(attemptEffectId);
            const planner = makeReservationAllocationPlanner({
              candidates: {
                lockCurrentForItem: () =>
                  Ref.get(reservedByPosition).pipe(
                    Effect.map((reserved) =>
                      candidatePositions.map((candidate) => ({
                        position: candidate,
                        reservedAmount: reserved.get(candidate.ref.resourceId) ?? '0',
                      })),
                    ),
                  ),
              },
              eligibility: { isEligible: () => Effect.succeed(true) },
              makeAllocationId: ({ effectId: id, positionId, purchaseDemandOccurrenceId }) =>
                Schema.decodeUnknownSync(StockAllocationIdSchema)(`${id}:${purchaseDemandOccurrenceId}:${positionId}`),
            });
            const requirements = yield* planner.plan(
              decodedEffectId,
              authority,
              [
                Schema.decodeUnknownSync(ResolvedCatalogStockDemandSchema)({
                  ...demand(`occurrence-${attemptEffectId}`, item),
                  quantity: '1',
                }),
              ],
              context,
            );
            yield* Ref.update(reservedByPosition, (current) => {
              const next = new Map(current);
              for (const allocation of requirements.flatMap(({ allocations }) => allocations)) {
                next.set(allocation.positionRef.resourceId, allocation.quantity.amount);
              }
              return next;
            });
            return requirements;
          }),
        ).pipe(
          Effect.match({
            onFailure: (failure) => ({ failure, ok: false as const }),
            onSuccess: (requirements) => ({ ok: true as const, requirements }),
          }),
        );
      const b2bContext = Schema.decodeUnknownSync(TrustedCurrentCommercePurchasingContextSchema)({
        ...commerceContext,
        channel: 'B2B',
        evidenceRef: 'commerce-context:concurrency:b2b',
      });

      const outcomes = yield* Effect.all(
        [attempt('race-effect-b2c', commerceContext), attempt('race-effect-b2b', b2bContext)],
        { concurrency: 'unbounded' },
      );
      const winners = outcomes.filter((outcome) => outcome.ok);
      const losers = outcomes.filter((outcome) => !outcome.ok);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toMatchObject({ failure: { reason: 'INSUFFICIENT_CONSTRAINED_STOCK' } });
      if (winners[0]?.ok) {
        expect(
          winners[0].requirements.flatMap(({ allocations }) => allocations).map(({ quantity }) => quantity.amount),
        ).toEqual(['0.6', '0.4']);
      }
      expect([...(yield* Ref.get(reservedByPosition)).values()]).toEqual(['0.6', '0.4']);
    }),
  );
});

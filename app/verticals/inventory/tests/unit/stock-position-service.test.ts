import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrentOnHandEvidenceSchema,
  CurrentSuccessfulAllocationQuantitySchema,
  CreateStockPositionInputSchema,
  DerivedReservedQuantitySchema,
  ExactStockQuantityAmountSchema,
  StockPositionRejected,
} from '../../shared/domain/stock-position.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import type { StockPosition } from '../../shared/domain/stock-position.ts';
import { InventoryBackendConfigurationRefSchema } from '../../shared/resources/inventory-backend-configuration.ts';
import type { StockPositionPersistence } from '../../src/persistence/stock-position-repository.ts';
import type { CurrentSuccessfulStockAllocationReader } from '../../src/services/stock-position-service.ts';
import { makeStockPositionService } from '../../src/services/stock-position-service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const itemId = '33333333-3333-4333-8333-333333333333';
const locationId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const backendConfigurationId = '66666666-6666-4666-8666-666666666666';
const timestamp = '2026-09-24T10:00:00.000Z';
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const decodeCreate = Schema.decodeUnknownSync(CreateStockPositionInputSchema, { onExcessProperty: 'error' });
const decodeAllocation = Schema.decodeUnknownSync(CurrentSuccessfulAllocationQuantitySchema, {
  onExcessProperty: 'error',
});
const wrongOwnerConfigurationRef = Schema.decodeUnknownSync(InventoryBackendConfigurationRefSchema, {
  onExcessProperty: 'error',
})({
  moduleId: 'commerce.inventory',
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
});
const currentOnHand = Schema.decodeUnknownSync(CurrentOnHandEvidenceSchema, { onExcessProperty: 'error' })({
  _tag: 'CURRENT',
  evidenceRef: 'wms-snapshot:42',
  meaning: 'ON_HAND',
  observedAt: timestamp,
  ownerConfigurationRef: {
    moduleId: 'commerce.inventory',
    resourceId: backendConfigurationId,
    resourceType: 'commerce.inventory.inventory-backend-configuration',
    tenantId,
  },
  quantity: { amount: '2', unitRef },
});
const input = decodeCreate({
  onHand: currentOnHand,
  scope: {
    customerConfigurationId: 'customer-configuration:primary',
    stockItemRef: {
      moduleId: 'commerce.inventory',
      resourceId: itemId,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
    stockLocationRef: {
      moduleId: 'commerce.inventory',
      resourceId: locationId,
      resourceType: 'commerce.inventory.stock-location',
      tenantId,
    },
    unitRef,
  },
});
const selectedBackendConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema, {
  onExcessProperty: 'error',
})({
  configurationId: backendConfigurationId,
  customerConfigurationId: input.scope.customerConfigurationId,
  revision: 1,
  selectedAt: timestamp,
  selection: {
    backend: 'ontos_wms',
    backendId: 'primary-wms',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});
const selectedBackendReader = {
  findCurrent: () => Effect.succeed(Option.some(selectedBackendConfiguration)),
};

const makePersistence = Effect.gen(function* makePersistence() {
  const positions = yield* Ref.make<ReadonlyMap<string, StockPosition>>(new Map());
  const persistence: StockPositionPersistence = {
    create: (position) =>
      Ref.modify(positions, (stored) => [position, new Map(stored).set(position.ref.resourceId, position)] as const),
    findCurrent: (scope) =>
      Ref.get(positions).pipe(
        Effect.map((stored) =>
          Option.fromNullishOr(
            [...stored.values()].find(
              (position) =>
                position.lifecycle === 'CURRENT' &&
                position.scope.customerConfigurationId === scope.customerConfigurationId &&
                position.scope.stockItemRef.resourceId === scope.stockItemRef.resourceId &&
                position.scope.stockLocationRef.resourceId === scope.stockLocationRef.resourceId,
            ),
          ),
        ),
      ),
    read: (ref) =>
      Ref.get(positions).pipe(
        Effect.map((stored) => {
          const position = stored.get(ref.resourceId);
          return position?.ref.tenantId === ref.tenantId ? Option.some(position) : Option.none();
        }),
      ),
    save: ({ expectedRevision, next }) =>
      Effect.gen(function* savePosition() {
        const stored = yield* Ref.get(positions);
        const current = stored.get(next.ref.resourceId);
        if (current?.revision !== expectedRevision) {
          return yield* new StockPositionRejected({
            code: 'stock_position_rejected',
            positionRef: next.ref,
            reason: 'POSITION_REVISION_CONFLICT',
          });
        }
        yield* Ref.set(positions, new Map(stored).set(next.ref.resourceId, next));
        return next;
      }),
  };
  return persistence;
});

const allocationReader = (amounts: readonly string[]): CurrentSuccessfulStockAllocationReader => ({
  readCurrentSuccessful: (positionRef) =>
    Effect.succeed(
      amounts.map((amount, index) =>
        decodeAllocation({
          allocationId: `allocation:${index + 1}`,
          positionRef,
          quantity: { amount, unitRef },
          status: 'CURRENT_SUCCESSFUL',
        }),
      ),
    ),
});

describe('Inventory Stock Position owner service', () => {
  it.effect('keeps ordinary stock changes on one identity and derives RESERVED at read time', () =>
    Effect.gen(function* updateAndRead() {
      const persistence = yield* makePersistence;
      const service = makeStockPositionService({
        allocationReader: allocationReader(['1.5', '1.25']),
        backendConfigurationReader: selectedBackendReader,
        persistence,
      });
      const established = yield* service.establish(input);
      const updated = yield* service.recordOnHand(established.ref, {
        ...currentOnHand,
        evidenceRef: 'wms-snapshot:43',
        quantity: { amount: Schema.decodeSync(ExactStockQuantityAmountSchema)('3'), unitRef },
      });
      const view = yield* service.read(established.ref);

      expect(updated.ref).toEqual(established.ref);
      expect(updated.revision).toBe(2);
      expect(view.position).toEqual(updated);
      expect(Schema.is(DerivedReservedQuantitySchema)(view.reserved)).toBe(true);
      if (Schema.is(DerivedReservedQuantitySchema)(view.reserved)) {
        expect(view.reserved.quantity.amount).toBe('2.75');
      }
      expect(view).not.toHaveProperty('available');
    }),
  );

  it.effect('ends P1 before establishing distinct P2 for the same exact scope', () =>
    Effect.gen(function* replaceIdentityWithoutRewritingHistory() {
      const persistence = yield* makePersistence;
      const service = makeStockPositionService({
        allocationReader: allocationReader([]),
        backendConfigurationReader: selectedBackendReader,
        persistence,
      });
      const first = yield* service.establish(input);
      const duplicate = yield* service.establish(input).pipe(Effect.flip);
      expect(duplicate).toMatchObject({ reason: 'POSITION_SCOPE_ALREADY_CURRENT' });

      const historical = yield* service.end(first.ref, '2026-09-24T11:00:00.000Z');
      const second = yield* service.establish({
        ...input,
        onHand: {
          ...currentOnHand,
          quantity: { amount: Schema.decodeSync(ExactStockQuantityAmountSchema)('0'), unitRef },
        },
      });
      const historicalService = makeStockPositionService({
        allocationReader: {
          readCurrentSuccessful: () => Effect.die('must not derive Current RESERVED for a historical Position'),
        },
        backendConfigurationReader: selectedBackendReader,
        persistence,
      });
      const retainedFirst = yield* historicalService.read(first.ref);

      expect(historical.ref).toEqual(first.ref);
      expect(second.ref.resourceId).not.toBe(first.ref.resourceId);
      expect(retainedFirst.position).toEqual(historical);
      expect(retainedFirst.reserved).toEqual({
        currentness: 'HISTORICAL',
        derivation: 'CURRENT_SUCCESSFUL_RESERVATION_ALLOCATIONS',
        meaning: 'RESERVED',
        owner: 'INVENTORY',
        reason: 'POSITION_NOT_CURRENT',
      });
      expect(second.scope).toEqual(first.scope);
    }),
  );

  it.effect('fails closed when ON_HAND names a backend configuration other than the selected owner', () =>
    Effect.gen(function* rejectOwnerMismatch() {
      const persistence = yield* makePersistence;
      const service = makeStockPositionService({
        allocationReader: allocationReader([]),
        backendConfigurationReader: selectedBackendReader,
        persistence,
      });
      const failure = yield* service
        .establish(
          decodeCreate({
            ...input,
            onHand: {
              ...currentOnHand,
              ownerConfigurationRef: wrongOwnerConfigurationRef,
            },
          }),
        )
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'OWNER_CONFIGURATION_MISMATCH' });
    }),
  );

  it.effect('fails closed when the Customer Configuration has no selected Inventory Backend', () =>
    Effect.gen(function* rejectMissingOwner() {
      const persistence = yield* makePersistence;
      const service = makeStockPositionService({
        allocationReader: allocationReader([]),
        backendConfigurationReader: {
          findCurrent: () => Effect.succeedNone,
        },
        persistence,
      });
      const failure = yield* service.establish(input).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'OWNER_CONFIGURATION_MISMATCH' });
    }),
  );

  it.effect('does not replace ON_HAND with evidence from an unselected backend configuration', () =>
    Effect.gen(function* rejectReplacementOwner() {
      const persistence = yield* makePersistence;
      const service = makeStockPositionService({
        allocationReader: allocationReader([]),
        backendConfigurationReader: selectedBackendReader,
        persistence,
      });
      const established = yield* service.establish(input);
      const failure = yield* service
        .recordOnHand(established.ref, {
          ...currentOnHand,
          evidenceRef: 'other-backend-snapshot:1',
          ownerConfigurationRef: wrongOwnerConfigurationRef,
        })
        .pipe(Effect.flip);
      const retained = yield* persistence.read(established.ref);

      expect(failure).toMatchObject({ reason: 'OWNER_CONFIGURATION_MISMATCH' });
      expect(Option.getOrThrow(retained)).toEqual(established);
    }),
  );
});

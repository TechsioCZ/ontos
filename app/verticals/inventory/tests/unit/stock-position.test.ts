import { Effect, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrentSuccessfulAllocationQuantitySchema,
  CurrentOnHandEvidenceSchema,
  CreateStockPositionInputSchema,
  ExactStockQuantityAmountSchema,
  IndeterminateOnHandEvidenceSchema,
  MissingOnHandEvidenceSchema,
  StaleOnHandEvidenceSchema,
  StockPositionSchema,
  UnknownOnHandEvidenceSchema,
  addExactStockQuantityAmounts,
  compareExactStockQuantityAmounts,
  deriveReservedQuantity,
  endStockPosition,
  recordOnHandEvidence,
  subtractExactStockQuantityAmounts,
} from '../../shared/domain/stock-position.ts';
import { StockItemRefSchema } from '../../shared/resources/stock-item.ts';
import { StockLocationRefSchema } from '../../shared/resources/stock-location.ts';
import { StockPositionRefSchema } from '../../shared/resources/stock-position.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const locationId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const backendConfigurationId = '77777777-7777-4777-8777-777777777777';
const timestamp = '2026-09-24T10:00:00.000Z';

const decodeRef = Schema.decodeUnknownSync(StockPositionRefSchema);
const decodeItemRef = Schema.decodeUnknownSync(StockItemRefSchema);
const decodeLocationRef = Schema.decodeUnknownSync(StockLocationRefSchema);
const decodePosition = Schema.decodeUnknownSync(StockPositionSchema, { onExcessProperty: 'error' });
const decodeCreate = Schema.decodeUnknownSync(CreateStockPositionInputSchema, { onExcessProperty: 'error' });
const decodeAllocation = Schema.decodeUnknownSync(CurrentSuccessfulAllocationQuantitySchema, {
  onExcessProperty: 'error',
});
const decodeCurrentOnHand = Schema.decodeUnknownSync(CurrentOnHandEvidenceSchema, { onExcessProperty: 'error' });

const positionRef = decodeRef({
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
});
const stockItemRef = decodeItemRef({
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
});
const stockLocationRef = decodeLocationRef({
  moduleId: 'commerce.inventory',
  resourceId: locationId,
  resourceType: 'commerce.inventory.stock-location',
  tenantId,
});
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const ownerConfigurationRef = {
  moduleId: 'commerce.inventory',
  resourceId: backendConfigurationId,
  resourceType: 'commerce.inventory.inventory-backend-configuration',
  tenantId,
} as const;

const currentOnHand = (amount: string) =>
  decodeCurrentOnHand({
    _tag: 'CURRENT',
    evidenceRef: 'wms-snapshot:42',
    meaning: 'ON_HAND',
    observedAt: timestamp,
    ownerConfigurationRef,
    quantity: { amount, unitRef },
  });

const currentPosition = (amount = '2') =>
  decodePosition({
    createdAt: timestamp,
    endedAt: null,
    lifecycle: 'CURRENT',
    onHand: currentOnHand(amount),
    ref: positionRef,
    revision: 1,
    scope: {
      customerConfigurationId: 'customer-configuration:primary',
      stockItemRef,
      stockLocationRef,
      unitRef,
    },
  });

describe('Inventory Stock Position quantity meaning', () => {
  it('accepts only canonical non-negative exact decimals without JavaScript number coercion', () => {
    const decode = Schema.decodeUnknownSync(ExactStockQuantityAmountSchema);

    expect(decode('0')).toBe('0');
    expect(decode('1000')).toBe('1000');
    expect(decode('9007199254740993.000000001')).toBe('9007199254740993.000000001');
    for (const invalid of [-1, 0, 1.5, '-1', '+1', '01', '1.0', '1e3', '0.0000000001']) {
      expect(() => decode(invalid)).toThrow();
    }
  });

  it('adds, compares, and subtracts canonical quantities exactly across scales and safe-integer limits', () => {
    const decode = Schema.decodeUnknownSync(ExactStockQuantityAmountSchema);
    const large = decode('9007199254740993.000000001');
    const fraction = decode('0.999999999');
    const sum = Result.getOrThrow(addExactStockQuantityAmounts(large, fraction));

    expect(sum).toBe('9007199254740994');
    expect(compareExactStockQuantityAmounts(sum, large)).toBe(1);
    expect(Result.getOrThrow(subtractExactStockQuantityAmounts(sum, fraction))).toBe(large);
    expect(compareExactStockQuantityAmounts(large, large)).toBe(0);
    expect(Result.isFailure(subtractExactStockQuantityAmounts(fraction, large))).toBe(true);
  });

  it('keeps piece attributes out of ON_HAND and retains the exact Product Unit reference', () => {
    const position = currentPosition('2');

    expect(Schema.is(CurrentOnHandEvidenceSchema)(position.onHand)).toBe(true);
    if (!Schema.is(CurrentOnHandEvidenceSchema)(position.onHand)) {
      return;
    }
    expect(position.onHand.meaning).toBe('ON_HAND');
    expect(position.onHand.quantity).toEqual({ amount: '2', unitRef });
    expect(position).not.toHaveProperty('attributes');
    expect(position).not.toHaveProperty('packageContents');
  });

  it('distinguishes explicit zero from every typed unavailable evidence state', () => {
    const zero = currentPosition('0');
    expect(Schema.is(CurrentOnHandEvidenceSchema)(zero.onHand)).toBe(true);
    if (Schema.is(CurrentOnHandEvidenceSchema)(zero.onHand)) {
      expect(zero.onHand.quantity.amount).toBe('0');
    }

    const unavailableStates = [
      ['UNKNOWN', UnknownOnHandEvidenceSchema],
      ['MISSING', MissingOnHandEvidenceSchema],
      ['INDETERMINATE', IndeterminateOnHandEvidenceSchema],
    ] as const;
    for (const [state, stateSchema] of unavailableStates) {
      const position = decodePosition({
        ...zero,
        onHand: { _tag: state, meaning: 'ON_HAND', ownerConfigurationRef, unitRef },
      });
      expect(Schema.is(stateSchema)(position.onHand)).toBe(true);
      expect(position.onHand).not.toHaveProperty('quantity');
    }

    const stale = decodePosition({
      ...zero,
      onHand: {
        _tag: 'STALE',
        evidenceRef: 'wms-snapshot:41',
        lastKnownQuantity: { amount: '7', unitRef },
        lastObservedAt: timestamp,
        meaning: 'ON_HAND',
        ownerConfigurationRef,
      },
    });
    expect(Schema.is(StaleOnHandEvidenceSchema)(stale.onHand)).toBe(true);
    if (Schema.is(StaleOnHandEvidenceSchema)(stale.onHand)) {
      expect(stale.onHand.lastKnownQuantity.amount).toBe('7');
    }
    expect(Schema.is(CurrentOnHandEvidenceSchema)(stale.onHand)).toBe(false);
  });

  it.effect('derives RESERVED exactly and preserves RESERVED greater than ON_HAND without AVAILABLE', () =>
    Effect.gen(function* preserveInconsistency() {
      const position = currentPosition('2');
      const allocations = [
        decodeAllocation({
          allocationId: 'allocation:one',
          positionRef,
          quantity: { amount: '1.5', unitRef },
          status: 'CURRENT_SUCCESSFUL',
        }),
        decodeAllocation({
          allocationId: 'allocation:two',
          positionRef,
          quantity: { amount: '1.25', unitRef },
          status: 'CURRENT_SUCCESSFUL',
        }),
      ];

      const reserved = yield* deriveReservedQuantity(position, allocations);

      expect(reserved).toEqual({
        allocationCount: 2,
        currentness: 'CURRENT',
        derivation: 'CURRENT_SUCCESSFUL_RESERVATION_ALLOCATIONS',
        meaning: 'RESERVED',
        owner: 'INVENTORY',
        quantity: { amount: '2.75', unitRef },
      });
      expect(reserved).not.toHaveProperty('available');
      expect(position).not.toHaveProperty('available');
    }),
  );

  it.effect(
    'keeps identity through ordinary ON_HAND change and gives a later scope instance a different identity',
    () =>
      Effect.gen(function* preserveAndReplaceIdentity() {
        const original = currentPosition('2');
        const updated = yield* recordOnHandEvidence(original, currentOnHand('3'));
        const historical = yield* endStockPosition(updated, '2026-09-24T11:00:00.000Z');
        const laterInput = decodeCreate({
          onHand: currentOnHand('0'),
          scope: original.scope,
        });

        expect(updated.ref).toEqual(original.ref);
        expect(updated.revision).toBe(2);
        expect(historical).toMatchObject({ endedAt: '2026-09-24T11:00:00.000Z', lifecycle: 'HISTORICAL' });
        expect(Schema.is(StaleOnHandEvidenceSchema)(historical.onHand)).toBe(true);
        expect(laterInput.scope).toEqual(original.scope);

        const later = decodePosition({
          createdAt: '2026-09-24T11:00:00.000Z',
          endedAt: null,
          lifecycle: 'CURRENT',
          onHand: laterInput.onHand,
          ref: { ...positionRef, resourceId: '66666666-6666-4666-8666-666666666666' },
          revision: 1,
          scope: laterInput.scope,
        });
        expect(later.ref.resourceId).not.toBe(original.ref.resourceId);
        expect(historical.ref).toEqual(original.ref);
      }),
  );
});

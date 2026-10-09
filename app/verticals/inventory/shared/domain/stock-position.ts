import { ProductUnitRefSchema } from '@app/catalog/resources/product-unit';
import { Effect, Match, Schema } from 'effect';
import type { Result } from 'effect';

import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockLocationRefSchema } from '../resources/stock-location.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';
import type { StockPositionRef } from '../resources/stock-position.ts';

const boundedIdentifier = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const stockPositionInstant = Schema.toEncoded(Schema.DateTimeUtcFromString);
const STOCK_QUANTITY_PRECISION = 38;
const STOCK_QUANTITY_SCALE = 9;
const STOCK_QUANTITY_INTEGER_DIGITS = STOCK_QUANTITY_PRECISION - STOCK_QUANTITY_SCALE;
const canonicalDecimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;

export const ExactStockQuantityAmountSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!canonicalDecimalPattern.test(value)) {
      return 'Stock Quantity must be a canonical non-negative decimal without exponent, sign, leading zero, or trailing fractional zero';
    }
    const [integer = '', fraction = ''] = value.split('.');
    return integer.length <= STOCK_QUANTITY_INTEGER_DIGITS && fraction.length <= STOCK_QUANTITY_SCALE
      ? undefined
      : `Stock Quantity must fit numeric(${STOCK_QUANTITY_PRECISION}, ${STOCK_QUANTITY_SCALE})`;
  }),
).pipe(Schema.brand('ExactStockQuantityAmount'));
export type ExactStockQuantityAmount = typeof ExactStockQuantityAmountSchema.Type;

export const StockQuantitySchema = Schema.Struct({
  amount: ExactStockQuantityAmountSchema,
  unitRef: ProductUnitRefSchema,
});
export type StockQuantity = typeof StockQuantitySchema.Type;

export const CurrentOnHandEvidenceSchema = Schema.TaggedStruct('CURRENT', {
  evidenceRef: boundedIdentifier,
  meaning: Schema.Literal('ON_HAND'),
  observedAt: stockPositionInstant,
  ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
  quantity: StockQuantitySchema,
});

const unavailableOnHand = <Tag extends 'UNKNOWN' | 'MISSING' | 'INDETERMINATE'>(tag: Tag) =>
  Schema.TaggedStruct(tag, {
    meaning: Schema.Literal('ON_HAND'),
    ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
    unitRef: ProductUnitRefSchema,
  });

export const StaleOnHandEvidenceSchema = Schema.TaggedStruct('STALE', {
  evidenceRef: boundedIdentifier,
  lastKnownQuantity: StockQuantitySchema,
  lastObservedAt: stockPositionInstant,
  meaning: Schema.Literal('ON_HAND'),
  ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
});

export const UnknownOnHandEvidenceSchema = unavailableOnHand('UNKNOWN');
export const MissingOnHandEvidenceSchema = unavailableOnHand('MISSING');
export const IndeterminateOnHandEvidenceSchema = unavailableOnHand('INDETERMINATE');

export const StockPositionOnHandEvidenceSchema = Schema.Union([
  CurrentOnHandEvidenceSchema,
  UnknownOnHandEvidenceSchema,
  MissingOnHandEvidenceSchema,
  StaleOnHandEvidenceSchema,
  IndeterminateOnHandEvidenceSchema,
]);
export type StockPositionOnHandEvidence = typeof StockPositionOnHandEvidenceSchema.Type;

export const StockPositionScopeSchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  stockItemRef: StockItemRefSchema,
  stockLocationRef: StockLocationRefSchema,
  unitRef: ProductUnitRefSchema,
}).check(
  Schema.makeFilter(({ stockItemRef, stockLocationRef, unitRef }) =>
    stockItemRef.tenantId === stockLocationRef.tenantId && stockItemRef.tenantId === unitRef.tenantId
      ? undefined
      : 'Stock Position scope references must share one Tenant',
  ),
);
export type StockPositionScope = typeof StockPositionScopeSchema.Type;

export const StockPositionRevisionSchema = Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 }));

const sameUnitRef = (left: StockQuantity['unitRef'], right: StockQuantity['unitRef']): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

const evidenceUnitRef = (evidence: StockPositionOnHandEvidence): StockQuantity['unitRef'] =>
  Match.value(evidence).pipe(
    Match.tag('CURRENT', ({ quantity }) => quantity.unitRef),
    Match.tag('STALE', ({ lastKnownQuantity }) => lastKnownQuantity.unitRef),
    Match.tag('UNKNOWN', ({ unitRef }) => unitRef),
    Match.tag('MISSING', ({ unitRef }) => unitRef),
    Match.tag('INDETERMINATE', ({ unitRef }) => unitRef),
    Match.exhaustive,
  );

const evidenceOwnerConfigurationRef = (evidence: StockPositionOnHandEvidence) => evidence.ownerConfigurationRef;

export const StockPositionSchema = Schema.Struct({
  createdAt: stockPositionInstant,
  endedAt: Schema.toEncoded(Schema.OptionFromNullOr(stockPositionInstant)),
  lifecycle: Schema.Literals(['CURRENT', 'HISTORICAL']),
  onHand: StockPositionOnHandEvidenceSchema,
  ref: StockPositionRefSchema,
  revision: StockPositionRevisionSchema,
  scope: StockPositionScopeSchema,
}).check(
  Schema.makeFilter((position) => {
    const { ref, scope } = position;
    if (
      ref.tenantId !== scope.stockItemRef.tenantId ||
      ref.tenantId !== scope.stockLocationRef.tenantId ||
      ref.tenantId !== scope.unitRef.tenantId
    ) {
      return 'Stock Position and all constrained scope references must share one Tenant';
    }
    if (!sameUnitRef(evidenceUnitRef(position.onHand), scope.unitRef)) {
      return 'ON_HAND must use the exact Stock Item Product Unit reference';
    }
    if (evidenceOwnerConfigurationRef(position.onHand).tenantId !== ref.tenantId) {
      return 'ON_HAND owner configuration and Stock Position must share one Tenant';
    }
    if (position.lifecycle === 'HISTORICAL' && Schema.is(CurrentOnHandEvidenceSchema)(position.onHand)) {
      return 'A historical Stock Position cannot expose Current ON_HAND evidence';
    }
    return (position.lifecycle === 'CURRENT' && position.endedAt === null) ||
      (position.lifecycle === 'HISTORICAL' && position.endedAt !== null)
      ? undefined
      : 'Stock Position end timestamp must match its lifecycle';
  }),
);
export type StockPosition = typeof StockPositionSchema.Type;

export const CreateStockPositionInputSchema = Schema.Struct({
  onHand: StockPositionOnHandEvidenceSchema,
  scope: StockPositionScopeSchema,
}).check(
  Schema.makeFilter(({ onHand, scope }) =>
    sameUnitRef(evidenceUnitRef(onHand), scope.unitRef)
      ? undefined
      : 'Initial ON_HAND must use the exact Stock Item Product Unit reference',
  ),
);
export type CreateStockPositionInput = typeof CreateStockPositionInputSchema.Type;

export const CurrentSuccessfulAllocationQuantitySchema = Schema.Struct({
  allocationId: boundedIdentifier.pipe(Schema.brand('InventoryStockAllocationId')),
  positionRef: StockPositionRefSchema,
  quantity: StockQuantitySchema,
  status: Schema.Literal('CURRENT_SUCCESSFUL'),
});
export type CurrentSuccessfulAllocationQuantity = typeof CurrentSuccessfulAllocationQuantitySchema.Type;

export const DerivedReservedQuantitySchema = Schema.Struct({
  allocationCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  currentness: Schema.Literal('CURRENT'),
  derivation: Schema.Literal('CURRENT_SUCCESSFUL_RESERVATION_ALLOCATIONS'),
  meaning: Schema.Literal('RESERVED'),
  owner: Schema.Literal('INVENTORY'),
  quantity: StockQuantitySchema,
});

export const HistoricalReservedQuantitySchema = Schema.Struct({
  currentness: Schema.Literal('HISTORICAL'),
  derivation: Schema.Literal('CURRENT_SUCCESSFUL_RESERVATION_ALLOCATIONS'),
  meaning: Schema.Literal('RESERVED'),
  owner: Schema.Literal('INVENTORY'),
  reason: Schema.Literal('POSITION_NOT_CURRENT'),
});

export const StockPositionReservedEvidenceSchema = Schema.Union([
  DerivedReservedQuantitySchema,
  HistoricalReservedQuantitySchema,
]);
export type StockPositionReservedEvidence = typeof StockPositionReservedEvidenceSchema.Type;

export class StockPositionRejected extends Schema.TaggedError<StockPositionRejected>()('StockPositionRejected', {
  code: Schema.Literal('stock_position_rejected'),
  positionRef: Schema.optionalKey(StockPositionRefSchema),
  reason: Schema.Literals([
    'POSITION_NOT_CURRENT',
    'POSITION_NOT_FOUND',
    'POSITION_SCOPE_ALREADY_CURRENT',
    'POSITION_IDENTITY_CONFLICT',
    'POSITION_REVISION_CONFLICT',
    'TENANT_SCOPE_MISMATCH',
    'ALLOCATION_POSITION_MISMATCH',
    'OWNER_CONFIGURATION_MISMATCH',
    'STOCK_ITEM_NOT_FOUND',
    'STOCK_LOCATION_NOT_FOUND',
    'STOCK_UNIT_MISMATCH',
    'INVALID_POSITION',
  ]),
}) {}

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

const decimalParts = (amount: ExactStockQuantityAmount): DecimalParts => {
  const [integer = '0', fraction = ''] = amount.split('.');
  return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
};

const alignedCoefficients = (left: ExactStockQuantityAmount, right: ExactStockQuantityAmount) => {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  const scale = Math.max(leftParts.scale, rightParts.scale);
  return {
    left: leftParts.coefficient * 10n ** BigInt(scale - leftParts.scale),
    right: rightParts.coefficient * 10n ** BigInt(scale - rightParts.scale),
    scale,
  };
};

const formatDecimal = (coefficient: bigint, scale: number): string => {
  if (scale === 0) {
    return coefficient.toString();
  }
  const padded = coefficient.toString().padStart(scale + 1, '0');
  const integer = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/u, '');
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

export const addExactStockQuantityAmounts = (
  left: ExactStockQuantityAmount,
  right: ExactStockQuantityAmount,
): Result.Result<ExactStockQuantityAmount, Schema.SchemaError> => {
  const aligned = alignedCoefficients(left, right);
  return Schema.decodeResult(ExactStockQuantityAmountSchema)(
    formatDecimal(aligned.left + aligned.right, aligned.scale),
  );
};

export const compareExactStockQuantityAmounts = (
  left: ExactStockQuantityAmount,
  right: ExactStockQuantityAmount,
): -1 | 0 | 1 => {
  const aligned = alignedCoefficients(left, right);
  if (aligned.left < aligned.right) {
    return -1;
  }
  return aligned.left > aligned.right ? 1 : 0;
};

export const subtractExactStockQuantityAmounts = (
  left: ExactStockQuantityAmount,
  right: ExactStockQuantityAmount,
): Result.Result<ExactStockQuantityAmount, Schema.SchemaError> => {
  const aligned = alignedCoefficients(left, right);
  return Schema.decodeResult(ExactStockQuantityAmountSchema)(
    formatDecimal(aligned.left - aligned.right, aligned.scale),
  );
};

const samePositionRef = (left: StockPositionRef, right: StockPositionRef): boolean =>
  left.resourceId === right.resourceId && left.tenantId === right.tenantId;

const invalidFromCause = (positionRef: StockPositionRef, cause: unknown) => {
  const failure = new StockPositionRejected({
    code: 'stock_position_rejected',
    positionRef,
    reason: 'INVALID_POSITION',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

/** RESERVED is a read-time derivation. There is intentionally no writable RESERVED state. */
export const deriveReservedQuantity = Effect.fn('deriveReservedQuantity')(function* deriveCurrentReservedQuantity(
  position: StockPosition,
  allocations: readonly CurrentSuccessfulAllocationQuantity[],
) {
  if (position.lifecycle === 'HISTORICAL') {
    return {
      currentness: 'HISTORICAL' as const,
      derivation: 'CURRENT_SUCCESSFUL_RESERVATION_ALLOCATIONS' as const,
      meaning: 'RESERVED' as const,
      owner: 'INVENTORY' as const,
      reason: 'POSITION_NOT_CURRENT' as const,
    };
  }
  const zero = yield* Schema.decodeEffect(ExactStockQuantityAmountSchema)('0').pipe(
    Effect.mapError((cause) => invalidFromCause(position.ref, cause)),
  );
  const amount = yield* Effect.reduce(
    allocations,
    () => zero,
    (subtotal, allocation) => {
      if (!samePositionRef(position.ref, allocation.positionRef)) {
        return Effect.fail(
          new StockPositionRejected({
            code: 'stock_position_rejected',
            positionRef: position.ref,
            reason: 'ALLOCATION_POSITION_MISMATCH',
          }),
        );
      }
      if (!sameUnitRef(position.scope.unitRef, allocation.quantity.unitRef)) {
        return Effect.fail(
          new StockPositionRejected({
            code: 'stock_position_rejected',
            positionRef: position.ref,
            reason: 'STOCK_UNIT_MISMATCH',
          }),
        );
      }
      return Effect.fromResult(addExactStockQuantityAmounts(subtotal, allocation.quantity.amount)).pipe(
        Effect.mapError((cause) => invalidFromCause(position.ref, cause)),
      );
    },
  );

  return {
    allocationCount: allocations.length,
    currentness: 'CURRENT' as const,
    derivation: 'CURRENT_SUCCESSFUL_RESERVATION_ALLOCATIONS' as const,
    meaning: 'RESERVED' as const,
    owner: 'INVENTORY' as const,
    quantity: { amount, unitRef: position.scope.unitRef },
  };
});

export const recordOnHandEvidence = (
  position: StockPosition,
  onHand: StockPositionOnHandEvidence,
): Effect.Effect<StockPosition, StockPositionRejected> => {
  if (position.lifecycle !== 'CURRENT') {
    return Effect.fail(
      new StockPositionRejected({
        code: 'stock_position_rejected',
        positionRef: position.ref,
        reason: 'POSITION_NOT_CURRENT',
      }),
    );
  }
  if (!sameUnitRef(evidenceUnitRef(onHand), position.scope.unitRef)) {
    return Effect.fail(
      new StockPositionRejected({
        code: 'stock_position_rejected',
        positionRef: position.ref,
        reason: 'STOCK_UNIT_MISMATCH',
      }),
    );
  }
  return Schema.decodeEffect(StockPositionSchema)({
    ...position,
    onHand,
    revision: position.revision + 1,
  }).pipe(
    Effect.mapError((cause) => {
      const failure = new StockPositionRejected({
        code: 'stock_position_rejected',
        positionRef: position.ref,
        reason: 'INVALID_POSITION',
      });
      Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
      return failure;
    }),
  );
};

export const endStockPosition = (
  position: StockPosition,
  endedAt: string,
): Effect.Effect<StockPosition, StockPositionRejected> => {
  if (position.lifecycle !== 'CURRENT') {
    return Effect.fail(
      new StockPositionRejected({
        code: 'stock_position_rejected',
        positionRef: position.ref,
        reason: 'POSITION_NOT_CURRENT',
      }),
    );
  }
  const onHand = Match.value(position.onHand).pipe(
    Match.tag('CURRENT', (current) => ({
      _tag: 'STALE' as const,
      evidenceRef: current.evidenceRef,
      lastKnownQuantity: current.quantity,
      lastObservedAt: current.observedAt,
      meaning: current.meaning,
      ownerConfigurationRef: current.ownerConfigurationRef,
    })),
    Match.tag('STALE', (stale) => stale),
    Match.tag('UNKNOWN', (unknown) => unknown),
    Match.tag('MISSING', (missing) => missing),
    Match.tag('INDETERMINATE', (indeterminate) => indeterminate),
    Match.exhaustive,
  );
  return Schema.decodeEffect(StockPositionSchema)({
    ...position,
    endedAt,
    lifecycle: 'HISTORICAL',
    onHand,
    revision: position.revision + 1,
  }).pipe(
    Effect.mapError((cause) => {
      const failure = new StockPositionRejected({
        code: 'stock_position_rejected',
        positionRef: position.ref,
        reason: 'INVALID_POSITION',
      });
      Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
      return failure;
    }),
  );
};

import { findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import type { Effect as EffectType } from 'effect';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { StockPositionRejected, StockPositionSchema } from '../../shared/domain/stock-position.ts';
import type {
  StockPosition,
  StockPositionOnHandEvidence,
  StockPositionScope,
} from '../../shared/domain/stock-position.ts';
import type { StockPositionRef } from '../../shared/resources/stock-position.ts';
import { inventoryBackendConfigurations } from './inventory-backend-configuration-table.ts';
import { inventoryStockPositions } from './stock-position-table.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type StockPositionRow = typeof inventoryStockPositions.$inferSelect;
const INVENTORY_MODULE_ID = 'commerce.inventory' as const;
const STOCK_POSITION_RESOURCE_TYPE = 'commerce.inventory.stock-position' as const;

export class StockPositionPersistenceUnavailable extends Schema.TaggedError<StockPositionPersistenceUnavailable>()(
  'StockPositionPersistenceUnavailable',
  {
    code: Schema.Literal('stock_position_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

type StockPositionPersistenceError = StockPositionRejected | StockPositionPersistenceUnavailable;

/** Transaction-scoped owner port. It stores ON_HAND only; RESERVED has no write operation. */
export interface StockPositionPersistence {
  readonly create: (position: StockPosition) => EffectType.Effect<StockPosition, StockPositionPersistenceError>;
  readonly findCurrent: (
    scope: StockPositionScope,
  ) => EffectType.Effect<Option.Option<StockPosition>, StockPositionPersistenceError>;
  readonly read: (
    ref: StockPositionRef,
  ) => EffectType.Effect<Option.Option<StockPosition>, StockPositionPersistenceError>;
  readonly save: (input: {
    readonly expectedRevision: number;
    readonly next: StockPosition;
  }) => EffectType.Effect<StockPosition, StockPositionPersistenceError>;
}

const unavailable = (cause: unknown): StockPositionPersistenceUnavailable => {
  const failure = new StockPositionPersistenceUnavailable({
    code: 'stock_position_persistence_unavailable',
    reason: 'Stock Position persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

const reject = (positionRef: StockPositionRef, reason: StockPositionRejected['reason']) =>
  new StockPositionRejected({ code: 'stock_position_rejected', positionRef, reason });

const uniqueViolationSqlState = ['23', '505'].join('');
const checkViolationSqlState = ['23', '514'].join('');
const foreignKeyViolationSqlState = ['23', '503'].join('');

export const mapStockPositionWriteError = (
  positionRef: StockPositionRef,
  cause: unknown,
): StockPositionPersistenceError => {
  const currentScope = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState && constraint === 'inventory_stock_positions_current_scope_uk',
  );
  if (Option.isSome(currentScope)) {
    return reject(positionRef, 'POSITION_SCOPE_ALREADY_CURRENT');
  }
  const exactItemUnit = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === checkViolationSqlState && constraint === 'inventory_stock_positions_exact_item_unit_ck',
  );
  if (Option.isSome(exactItemUnit)) {
    return reject(positionRef, 'STOCK_UNIT_MISMATCH');
  }
  const ownerConfiguration = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === checkViolationSqlState && constraint === 'inventory_stock_positions_owner_configuration_ck',
  );
  if (Option.isSome(ownerConfiguration)) {
    return reject(positionRef, 'OWNER_CONFIGURATION_MISMATCH');
  }
  const constrainedScopeForeignKey = findPostgresFailure(cause, ({ code, constraint }) => {
    if (code !== foreignKeyViolationSqlState) {
      return false;
    }
    return [
      'inventory_stock_positions_backend_configuration_fk',
      'inventory_stock_positions_item_fk',
      'inventory_stock_positions_location_fk',
    ].includes(constraint ?? '');
  });
  if (Option.isSome(constrainedScopeForeignKey)) {
    if (constrainedScopeForeignKey.value.constraint === 'inventory_stock_positions_item_fk') {
      return reject(positionRef, 'STOCK_ITEM_NOT_FOUND');
    }
    if (constrainedScopeForeignKey.value.constraint === 'inventory_stock_positions_location_fk') {
      return reject(positionRef, 'STOCK_LOCATION_NOT_FOUND');
    }
    return reject(positionRef, 'OWNER_CONFIGURATION_MISMATCH');
  }
  const identity = findPostgresFailure(
    cause,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      ['stock_positions_pkey', 'inventory_stock_positions_scope_id_uk'].includes(constraint ?? ''),
  );
  return Option.isSome(identity) ? reject(positionRef, 'POSITION_IDENTITY_CONFLICT') : unavailable(cause);
};

const unitRefFor = (row: StockPositionRow) => ({
  moduleId: row.stockUnitModuleId,
  resourceId: row.stockUnitResourceId,
  resourceType: row.stockUnitResourceType,
  tenantId: row.stockUnitTenantId,
});

const positionRefFor = (row: StockPositionRow) => ({
  moduleId: INVENTORY_MODULE_ID,
  resourceId: row.stockPositionId,
  resourceType: STOCK_POSITION_RESOURCE_TYPE,
  tenantId: row.tenantId,
});

const storedNumericPattern = /^(?<integer>[0-9]+)(?:\.(?<fraction>[0-9]+))?$/u;

/** PostgreSQL numeric(scale) text is exact but padded; domain decimals are exact and canonical. */
const canonicalAmount = (amount: string | null): string => {
  if (amount === null) {
    return '';
  }
  const groups = storedNumericPattern.exec(amount)?.groups;
  if (groups?.['integer'] === undefined) {
    return amount;
  }
  const integer = BigInt(groups['integer']).toString();
  const fraction = (groups['fraction'] ?? '').replace(/0+$/u, '');
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

const ownerConfigurationRefFor = (row: StockPositionRow) => ({
  moduleId: INVENTORY_MODULE_ID,
  resourceId: row.ownerConfigurationId,
  resourceType: 'commerce.inventory.inventory-backend-configuration' as const,
  tenantId: row.tenantId,
});

const onHandFor = (row: StockPositionRow) => {
  const ownerConfigurationRef = ownerConfigurationRefFor(row);
  const unitRef = unitRefFor(row);
  if (row.onHandState === 'CURRENT') {
    return {
      _tag: 'CURRENT',
      evidenceRef: row.onHandEvidenceRef ?? '',
      meaning: 'ON_HAND',
      observedAt: row.onHandObservedAt?.toISOString() ?? '',
      ownerConfigurationRef,
      quantity: { amount: canonicalAmount(row.onHandAmount), unitRef },
    } as const;
  }
  if (row.onHandState === 'STALE') {
    return {
      _tag: 'STALE',
      evidenceRef: row.onHandEvidenceRef ?? '',
      lastKnownQuantity: { amount: canonicalAmount(row.onHandAmount), unitRef },
      lastObservedAt: row.onHandObservedAt?.toISOString() ?? '',
      meaning: 'ON_HAND',
      ownerConfigurationRef,
    } as const;
  }
  return { _tag: row.onHandState, meaning: 'ON_HAND' as const, ownerConfigurationRef, unitRef };
};

const decodeRow = (row: StockPositionRow) =>
  Schema.decodeUnknownEffect(StockPositionSchema)({
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    lifecycle: row.lifecycleState,
    onHand: onHandFor(row),
    ref: positionRefFor(row),
    revision: row.revision,
    scope: {
      customerConfigurationId: row.customerConfigurationId,
      stockItemRef: {
        moduleId: INVENTORY_MODULE_ID,
        resourceId: row.stockItemId,
        resourceType: 'commerce.inventory.stock-item',
        tenantId: row.tenantId,
      },
      stockLocationRef: {
        moduleId: INVENTORY_MODULE_ID,
        resourceId: row.stockLocationId,
        resourceType: 'commerce.inventory.stock-location',
        tenantId: row.tenantId,
      },
      unitRef: unitRefFor(row),
    },
  }).pipe(Effect.mapError(unavailable));

const evidenceColumns = (onHand: StockPositionOnHandEvidence) =>
  Match.value(onHand).pipe(
    Match.tag('CURRENT', (current) => ({
      onHandAmount: current.quantity.amount,
      onHandEvidenceRef: current.evidenceRef,
      onHandObservedAt: DateTime.toDateUtc(DateTime.makeUnsafe(current.observedAt)),
      onHandState: current._tag,
      ownerConfigurationId: current.ownerConfigurationRef.resourceId,
    })),
    Match.tag('STALE', (stale) => ({
      onHandAmount: stale.lastKnownQuantity.amount,
      onHandEvidenceRef: stale.evidenceRef,
      onHandObservedAt: DateTime.toDateUtc(DateTime.makeUnsafe(stale.lastObservedAt)),
      onHandState: stale._tag,
      ownerConfigurationId: stale.ownerConfigurationRef.resourceId,
    })),
    Match.tag('UNKNOWN', 'MISSING', 'INDETERMINATE', (unavailableEvidence) => ({
      onHandAmount: null,
      onHandEvidenceRef: null,
      onHandObservedAt: null,
      onHandState: unavailableEvidence._tag,
      ownerConfigurationId: unavailableEvidence.ownerConfigurationRef.resourceId,
    })),
    Match.exhaustive,
  );

const insertValues = (position: StockPosition) => ({
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe(position.createdAt)),
  customerConfigurationId: position.scope.customerConfigurationId,
  endedAt: position.endedAt === null ? null : DateTime.toDateUtc(DateTime.makeUnsafe(position.endedAt)),
  ...evidenceColumns(position.onHand),
  lifecycleState: position.lifecycle,
  revision: position.revision,
  stockItemId: position.scope.stockItemRef.resourceId,
  stockLocationId: position.scope.stockLocationRef.resourceId,
  stockPositionId: position.ref.resourceId,
  stockUnitModuleId: position.scope.unitRef.moduleId,
  stockUnitResourceId: position.scope.unitRef.resourceId,
  stockUnitResourceType: position.scope.unitRef.resourceType,
  stockUnitTenantId: position.scope.unitRef.tenantId,
  tenantId: position.ref.tenantId,
});

const mutableValues = (position: StockPosition) => ({
  endedAt: position.endedAt === null ? null : DateTime.toDateUtc(DateTime.makeUnsafe(position.endedAt)),
  ...evidenceColumns(position.onHand),
  lifecycleState: position.lifecycle,
  revision: position.revision,
});

export const stockPositionPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): StockPositionPersistence => {
  const requireTenant = (ref: StockPositionRef) =>
    ref.tenantId === scope.tenantId ? Effect.void : Effect.fail(reject(ref, 'TENANT_SCOPE_MISMATCH'));

  const readRows = (ref: StockPositionRef) =>
    transaction
      .select()
      .from(inventoryStockPositions)
      .where(
        and(
          eq(inventoryStockPositions.tenantId, scope.tenantId),
          eq(inventoryStockPositions.stockPositionId, ref.resourceId),
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));

  const requireSelectedOwnerConfiguration = Effect.fn('StockPositionPersistence.requireSelectedOwnerConfiguration')(
    function* requireSelectedOwner(
      positionRef: StockPositionRef,
      customerConfigurationId: string,
      ownerConfigurationId: string,
    ) {
      const [selected] = yield* transaction
        .select()
        .from(inventoryBackendConfigurations)
        .where(
          and(
            eq(inventoryBackendConfigurations.tenantId, scope.tenantId),
            eq(inventoryBackendConfigurations.configurationId, ownerConfigurationId),
            eq(inventoryBackendConfigurations.customerConfigurationId, customerConfigurationId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (selected === undefined) {
        return yield* reject(positionRef, 'OWNER_CONFIGURATION_MISMATCH');
      }
      return yield* Effect.void;
    },
  );

  const decodeOwnedRow = Effect.fn('StockPositionPersistence.decodeOwnedRow')(function* decodeSelectedOwnerRow(
    row: StockPositionRow,
  ) {
    const positionRef = positionRefFor(row);
    yield* requireSelectedOwnerConfiguration(positionRef, row.customerConfigurationId, row.ownerConfigurationId);
    return yield* decodeRow(row);
  });

  const create: StockPositionPersistence['create'] = Effect.fn('StockPositionPersistence.create')(
    function* createStockPosition(position) {
      yield* requireTenant(position.ref);
      if (!Schema.is(StockPositionSchema)(position) || position.lifecycle !== 'CURRENT' || position.revision !== 1) {
        return yield* reject(position.ref, 'INVALID_POSITION');
      }
      yield* requireSelectedOwnerConfiguration(
        position.ref,
        position.scope.customerConfigurationId,
        position.onHand.ownerConfigurationRef.resourceId,
      );
      const [row] = yield* transaction
        .insert(inventoryStockPositions)
        .values(insertValues(position))
        .returning()
        .pipe(Effect.mapError((cause) => mapStockPositionWriteError(position.ref, cause)));
      return row === undefined ? yield* unavailable('Stock Position insert returned no row') : yield* decodeRow(row);
    },
  );

  const read: StockPositionPersistence['read'] = Effect.fn('StockPositionPersistence.read')(
    function* readStockPosition(ref) {
      yield* requireTenant(ref);
      const [row] = yield* readRows(ref);
      return row === undefined ? Option.none<StockPosition>() : Option.some(yield* decodeOwnedRow(row));
    },
  );

  const findCurrent: StockPositionPersistence['findCurrent'] = Effect.fn('StockPositionPersistence.findCurrent')(
    function* findCurrentStockPosition(positionScope) {
      if (
        positionScope.stockItemRef.tenantId !== scope.tenantId ||
        positionScope.stockLocationRef.tenantId !== scope.tenantId ||
        positionScope.unitRef.tenantId !== scope.tenantId
      ) {
        const syntheticRef = {
          moduleId: INVENTORY_MODULE_ID,
          resourceId: '00000000-0000-4000-8000-000000000000',
          resourceType: STOCK_POSITION_RESOURCE_TYPE,
          tenantId: positionScope.stockItemRef.tenantId,
        };
        return yield* reject(syntheticRef, 'TENANT_SCOPE_MISMATCH');
      }
      const [row] = yield* transaction
        .select()
        .from(inventoryStockPositions)
        .where(
          and(
            eq(inventoryStockPositions.tenantId, scope.tenantId),
            eq(inventoryStockPositions.customerConfigurationId, positionScope.customerConfigurationId),
            eq(inventoryStockPositions.stockItemId, positionScope.stockItemRef.resourceId),
            eq(inventoryStockPositions.stockLocationId, positionScope.stockLocationRef.resourceId),
            eq(inventoryStockPositions.lifecycleState, 'CURRENT'),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      return row === undefined ? Option.none<StockPosition>() : Option.some(yield* decodeOwnedRow(row));
    },
  );

  const save: StockPositionPersistence['save'] = Effect.fn('StockPositionPersistence.save')(
    function* saveStockPosition({ expectedRevision, next }) {
      yield* requireTenant(next.ref);
      if (!Schema.is(StockPositionSchema)(next) || next.revision !== expectedRevision + 1) {
        return yield* reject(next.ref, 'INVALID_POSITION');
      }
      yield* requireSelectedOwnerConfiguration(
        next.ref,
        next.scope.customerConfigurationId,
        next.onHand.ownerConfigurationRef.resourceId,
      );
      const [row] = yield* transaction
        .update(inventoryStockPositions)
        .set({ ...mutableValues(next), updatedAt: DateTime.toDateUtc(yield* DateTime.now) })
        .where(
          and(
            eq(inventoryStockPositions.tenantId, scope.tenantId),
            eq(inventoryStockPositions.stockPositionId, next.ref.resourceId),
            eq(inventoryStockPositions.revision, expectedRevision),
          ),
        )
        .returning()
        .pipe(Effect.mapError((cause) => mapStockPositionWriteError(next.ref, cause)));
      if (row === undefined) {
        const [observed] = yield* readRows(next.ref);
        return yield* reject(next.ref, observed === undefined ? 'POSITION_NOT_FOUND' : 'POSITION_REVISION_CONFLICT');
      }
      return yield* decodeRow(row);
    },
  );

  return Object.freeze({ create, findCurrent, read, save });
};

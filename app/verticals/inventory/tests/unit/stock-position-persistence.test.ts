import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Cause, DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { StockPositionRefSchema } from '../../shared/resources/stock-position.ts';
import {
  mapStockPositionWriteError,
  stockPositionPersistenceForScope,
} from '../../src/persistence/stock-position-repository.ts';
import {
  INVENTORY_STOCK_POSITION_TABLES,
  inventoryStockPositionImmutabilityTriggerContract,
  inventoryStockPositionOwnerConfigurationTriggerContract,
  inventoryStockPositionUnitMatchTriggerContract,
  inventoryStockPositions,
} from '../../src/persistence/stock-position-table.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const locationId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const backendConfigurationId = '66666666-6666-4666-8666-666666666666';
const timestamp = '2026-09-24T10:00:00.000Z';
const timestampDate = DateTime.toDateUtc(DateTime.makeUnsafe(timestamp));
const decodePosition = Schema.decodeUnknownSync(StockPositionSchema, { onExcessProperty: 'error' });
const decodeRef = Schema.decodeUnknownSync(StockPositionRefSchema, { onExcessProperty: 'error' });
const positionRef = decodeRef({
  moduleId: 'commerce.inventory',
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
});
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const position = decodePosition({
  createdAt: timestamp,
  endedAt: null,
  lifecycle: 'CURRENT',
  onHand: {
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
    quantity: { amount: '0', unitRef },
  },
  ref: positionRef,
  revision: 1,
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
const row = {
  createdAt: timestampDate,
  customerConfigurationId: position.scope.customerConfigurationId,
  endedAt: null,
  lifecycleState: 'CURRENT',
  onHandAmount: '0.000000000',
  onHandEvidenceRef: 'wms-snapshot:42',
  onHandObservedAt: timestampDate,
  onHandState: 'CURRENT',
  ownerConfigurationId: backendConfigurationId,
  revision: 1,
  stockItemId: itemId,
  stockLocationId: locationId,
  stockPositionId: positionId,
  stockUnitModuleId: 'commerce.catalog',
  stockUnitResourceId: unitId,
  stockUnitResourceType: 'commerce.catalog.product-unit',
  stockUnitTenantId: tenantId,
  tenantId,
  updatedAt: timestampDate,
};
const backendConfigurationRow = {
  backendId: 'primary-wms',
  backendKind: 'ontos_wms',
  configurationId: backendConfigurationId,
  customerConfigurationId: position.scope.customerConfigurationId,
  exactReservationCapability: 'SUPPORTED',
  revision: 1,
  selectedAt: timestampDate,
  stockCorrectionCapability: 'UNSUPPORTED',
  tenantId,
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:stock-position-test:run:1',
    authMethod: 'system',
    principalId: '77777777-7777-4777-8777-777777777777',
    tenantId,
  }),
  correlationId: 'stock-position-test',
};
const selectLimiting = <Row>(rows: readonly Row[]) => ({
  from: () => ({ where: () => ({ limit: () => Effect.succeed(rows) }) }),
});
type PersistenceTestRow = typeof backendConfigurationRow | typeof row;
const queuedSelect = (batches: readonly (readonly PersistenceTestRow[])[]) => {
  let index = 0;
  return () => {
    const batch = batches[index] ?? [];
    index += 1;
    return selectLimiting(batch);
  };
};

describe('Inventory Stock Position persistence', () => {
  it('exports one tenant-RLS owner table with partial Current-scope uniqueness and exact numeric ON_HAND', () => {
    expect(INVENTORY_STOCK_POSITION_TABLES).toEqual([inventoryStockPositions]);
    const config = getTableConfig(inventoryStockPositions);
    const columnNames = config.columns.map(({ name }) => name);
    const currentScopeIndex = config.indexes.find(
      (candidate) => candidate.config.name === 'inventory_stock_positions_current_scope_uk',
    );

    expect(`${config.schema}.${config.name}`).toBe('inventory.stock_positions');
    expect(config.enableRLS).toBe(true);
    expect(config.columns.find(({ name }) => name === 'on_hand_amount')?.getSQLType()).toBe('numeric(38, 9)');
    expect(columnNames).not.toContain('reserved_amount');
    expect(columnNames).not.toContain('available_amount');
    expect(columnNames).not.toContain('owner_backend_id');
    expect(columnNames).not.toContain('owner_kind');
    expect(columnNames).toContain('owner_configuration_id');
    expect(currentScopeIndex?.config.unique).toBe(true);
    expect(currentScopeIndex?.config.where).toBeDefined();
    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_stock_positions_backend_configuration_fk',
        'inventory_stock_positions_item_fk',
        'inventory_stock_positions_location_fk',
      ]),
    );
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
  });

  it.effect('creates and reads the exact Current Position without converting its numeric value', () =>
    Effect.gen(function* createAndRead() {
      const transaction = {
        insert: (_table: typeof inventoryStockPositions) => ({
          values: () => ({ returning: () => Effect.succeed([row]) }),
        }),
        select: queuedSelect([[backendConfigurationRow], [row], [backendConfigurationRow]]),
      };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockPositionPersistenceForScope(transaction, scope);

      const created = yield* persistence.create(position);
      const read = yield* persistence.read(position.ref);

      expect(created).toEqual(position);
      expect(Option.getOrThrow(read)).toEqual(position);
      expect(Option.getOrThrow(read).onHand).toMatchObject({ quantity: { amount: '0' } });
    }),
  );

  it.effect('canonicalizes PostgreSQL numeric scale padding without losing fractional precision', () =>
    Effect.gen(function* readPaddedFraction() {
      const transaction = {
        select: queuedSelect([[{ ...row, onHandAmount: '1.230000000' }], [backendConfigurationRow]]),
      };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockPositionPersistenceForScope(transaction, scope);

      const read = yield* persistence.read(position.ref);

      expect(Option.getOrThrow(read).onHand).toMatchObject({ quantity: { amount: '1.23' } });
    }),
  );

  it.effect('fails closed when the ON_HAND owner configuration is not selected for the Position scope', () =>
    Effect.gen(function* rejectUnselectedOwner() {
      const transaction = {
        insert: () => {
          throw new Error('must not insert a Position for an unselected owner');
        },
        select: () => selectLimiting([]),
      };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockPositionPersistenceForScope(transaction, scope);

      const failure = yield* persistence.create(position).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'OWNER_CONFIGURATION_MISMATCH' });
    }),
  );

  it.effect('rejects another Tenant before touching the owner transaction', () =>
    Effect.gen(function* rejectForeignTenant() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('must not touch transaction');
          },
        },
      );
      // @ts-expect-error Mock deliberately exposes no transaction operations.
      const persistence = stockPositionPersistenceForScope(transaction, scope);
      const foreignRef = decodeRef({ ...positionRef, tenantId: '99999999-9999-4999-8999-999999999999' });

      const failure = yield* persistence.read(foreignRef).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'TENANT_SCOPE_MISMATCH' });
    }),
  );

  it('publishes the immutable identity fields required for migration hardening', () => {
    expect(inventoryStockPositionImmutabilityTriggerContract).toEqual({
      columns: [
        'stock_position_id',
        'tenant_id',
        'customer_configuration_id',
        'stock_item_id',
        'stock_location_id',
        'stock_unit_module_id',
        'stock_unit_resource_id',
        'stock_unit_resource_type',
        'stock_unit_tenant_id',
      ],
      comparison: 'IS DISTINCT FROM',
      errorCondition: 'check_violation',
      event: 'UPDATE OR DELETE',
      functionName: 'inventory.reject_stock_position_scope_mutation',
      table: 'inventory.stock_positions',
      timing: 'BEFORE',
      triggerName: 'inventory_stock_positions_immutable_scope_trg',
    });
    expect(inventoryStockPositionUnitMatchTriggerContract).toEqual({
      constraintName: 'inventory_stock_positions_exact_item_unit_ck',
      errorCondition: 'check_violation',
      event: 'INSERT OR UPDATE',
      functionName: 'inventory.enforce_stock_position_stock_item_unit',
      lookupColumns: [
        'tenant_id',
        'stock_item_id',
        'stock_unit_module_id',
        'stock_unit_resource_id',
        'stock_unit_resource_type',
        'stock_unit_tenant_id',
      ],
      lookupTable: 'inventory.stock_items',
      table: 'inventory.stock_positions',
      timing: 'BEFORE',
      triggerName: 'inventory_stock_positions_exact_item_unit_trg',
    });
    expect(inventoryStockPositionOwnerConfigurationTriggerContract).toEqual({
      constraintName: 'inventory_stock_positions_owner_configuration_ck',
      event: 'INSERT OR UPDATE',
      foreignKeyName: 'inventory_stock_positions_backend_configuration_fk',
      functionName: 'inventory.enforce_stock_position_owner_configuration',
      lookupColumns: ['tenant_id', 'configuration_id', 'customer_configuration_id'],
      lookupTable: 'inventory.backend_configurations',
      table: 'inventory.stock_positions',
      timing: 'BEFORE',
      triggerName: 'inventory_stock_positions_owner_configuration_trg',
    });
  });

  it('maps Cause-wrapped constrained-scope database violations to typed domain reasons', () => {
    const foreignKeyViolation = ['23', '503'].join('');
    const checkViolation = ['23', '514'].join('');

    expect(
      mapStockPositionWriteError(
        positionRef,
        Cause.fail({ code: foreignKeyViolation, constraint: 'inventory_stock_positions_item_fk' }),
      ),
    ).toMatchObject({ reason: 'STOCK_ITEM_NOT_FOUND' });
    expect(
      mapStockPositionWriteError(
        positionRef,
        Cause.die({ code: foreignKeyViolation, constraint: 'inventory_stock_positions_location_fk' }),
      ),
    ).toMatchObject({ reason: 'STOCK_LOCATION_NOT_FOUND' });
    expect(
      mapStockPositionWriteError(
        positionRef,
        Cause.fail({ code: foreignKeyViolation, constraint: 'inventory_stock_positions_backend_configuration_fk' }),
      ),
    ).toMatchObject({ reason: 'OWNER_CONFIGURATION_MISMATCH' });
    expect(
      mapStockPositionWriteError(
        positionRef,
        Cause.fail({ code: checkViolation, constraint: 'inventory_stock_positions_owner_configuration_ck' }),
      ),
    ).toMatchObject({ reason: 'OWNER_CONFIGURATION_MISMATCH' });
  });
});

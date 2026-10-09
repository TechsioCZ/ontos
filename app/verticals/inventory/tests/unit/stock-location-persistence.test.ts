import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { StockLocationSchema, transitionStockLocation } from '../../shared/domain/stock-location.ts';
import { StockLocationRefSchema } from '../../shared/resources/stock-location.ts';
import { StockLocationPersistenceRejected } from '../../src/persistence/stock-location-persistence-rejected.ts';
import { stockLocationPersistenceForScope } from '../../src/persistence/stock-location-repository.ts';
import {
  INVENTORY_STOCK_LOCATION_TABLES,
  inventoryStockLocationRevisions,
  inventoryStockLocations,
} from '../../src/persistence/stock-location-table.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const locationId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-09-24T10:00:00.000Z';
const timestampDate = DateTime.toDateUtc(DateTime.makeUnsafe(timestamp));
const decodeLocation = Schema.decodeUnknownSync(StockLocationSchema, { onExcessProperty: 'error' });
const decodeRef = Schema.decodeUnknownSync(StockLocationRefSchema, { onExcessProperty: 'error' });
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:stock-location-test:run:1',
    authMethod: 'system',
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'stock-location-test',
};
const locationRef = (resourceId: string, owningTenantId = tenantId) =>
  decodeRef({
    moduleId: 'commerce.inventory',
    resourceId,
    resourceType: 'commerce.inventory.stock-location',
    tenantId: owningTenantId,
  });
const active = decodeLocation({
  addressEvidence: { countryCode: 'CZ', lines: ['Průmyslová 12'], locality: 'Praha', postalCode: '10200' },
  displayName: 'Prague stock pool',
  lifecycle: { _tag: 'ACTIVE' },
  operationalScope: { _tag: 'LOGICAL_AGGREGATE', physicalSiteKeys: ['prague-a', 'prague-b'] },
  ref: locationRef(locationId),
  revision: 1,
});
const activeRow = {
  addressEvidence: active.addressEvidence ?? null,
  createdAt: timestampDate,
  currentRevision: 1,
  displayName: active.displayName,
  lifecycleState: 'ACTIVE',
  physicalSiteKeys: [...active.operationalScope.physicalSiteKeys],
  scopeKind: active.operationalScope._tag,
  stockLocationId: locationId,
  successorStockLocationId: null,
  tenantId,
  transitionedAt: null,
  transitionReason: null,
  updatedAt: timestampDate,
};

const updateReturning = <Row>(rows: readonly Row[]) => ({
  set: () => ({ where: () => ({ returning: () => Effect.succeed(rows) }) }),
});
const updateFromValues = <Row>(
  makeRows: (value: Partial<typeof inventoryStockLocations.$inferInsert>) => readonly Row[],
) => ({
  set: (value: Partial<typeof inventoryStockLocations.$inferInsert>) => ({
    where: () => ({ returning: () => Effect.succeed(makeRows(value)) }),
  }),
});
const selectLimiting = <Row>(rows: readonly Row[]) => ({
  from: () => ({ where: () => ({ limit: () => Effect.succeed(rows) }) }),
});
const selectOrdering = <Row>(rows: readonly Row[]) => ({
  from: () => ({ where: () => ({ orderBy: () => Effect.succeed(rows) }) }),
});

describe('Inventory Stock Location persistence', () => {
  it('exports tenant-RLS current and append-only revision tables for aggregate DB integration', () => {
    expect(INVENTORY_STOCK_LOCATION_TABLES).toEqual([inventoryStockLocationRevisions, inventoryStockLocations]);
    for (const table of INVENTORY_STOCK_LOCATION_TABLES) {
      const config = getTableConfig(table);
      expect(config.enableRLS).toBe(true);
      expect(config.columns.some(({ name, notNull }) => name === 'tenant_id' && notNull)).toBe(true);
    }
    expect(getTableConfig(inventoryStockLocationRevisions).uniqueConstraints.map(({ name }) => name)).toContain(
      'inventory_stock_location_revisions_number_uk',
    );
  });

  it.effect('creates a durable current row and its first append-only revision snapshot', () =>
    Effect.gen(function* createWithHistory() {
      const writes: unknown[] = [];
      const transaction = {
        insert: (table: typeof inventoryStockLocations | typeof inventoryStockLocationRevisions) => ({
          values: (
            value: typeof inventoryStockLocations.$inferInsert | typeof inventoryStockLocationRevisions.$inferInsert,
          ) => {
            writes.push([table, value]);
            return table === inventoryStockLocations ? { returning: () => Effect.succeed([activeRow]) } : Effect.void;
          },
        }),
      };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockLocationPersistenceForScope(transaction, scope);

      const created = yield* persistence.create(active);

      expect(created).toEqual(active);
      expect(writes).toEqual([
        [
          inventoryStockLocations,
          expect.objectContaining({ currentRevision: 1, stockLocationId: locationId, tenantId }),
        ],
        [
          inventoryStockLocationRevisions,
          expect.objectContaining({ revision: 1, snapshot: active, stockLocationId: locationId, tenantId }),
        ],
      ]);
    }),
  );

  it.effect('optimistically persists a terminal transition and appends rather than rewrites history', () =>
    Effect.gen(function* persistTransitionHistory() {
      const retired = yield* transitionStockLocation(active, {
        _tag: 'RETIRE',
        reason: 'Owner retired the operational scope.',
        transitionedAt: timestamp,
      });
      const writes: unknown[] = [];
      const transaction = {
        insert: (table: typeof inventoryStockLocationRevisions) => ({
          values: (value: typeof inventoryStockLocationRevisions.$inferInsert) => {
            writes.push([table, value]);
            return Effect.void;
          },
        }),
        update: (_table: typeof inventoryStockLocations) =>
          updateFromValues((value) => [
            {
              ...activeRow,
              ...value,
              lifecycleState: 'RETIRED',
              transitionedAt: timestampDate,
              transitionReason: 'Owner retired the operational scope.',
            },
          ]),
      };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockLocationPersistenceForScope(transaction, scope);

      const saved = yield* persistence.saveTransition({ expectedRevision: 1, next: retired });

      expect(saved).toEqual(retired);
      expect(writes).toEqual([
        [
          inventoryStockLocationRevisions,
          expect.objectContaining({ revision: 2, snapshot: retired, stockLocationId: locationId, tenantId }),
        ],
      ]);
    }),
  );

  it.effect('returns the observed revision on an optimistic conflict without appending history', () =>
    Effect.gen(function* rejectStaleTransition() {
      const retired = yield* transitionStockLocation(active, {
        _tag: 'RETIRE',
        reason: 'Owner retired the operational scope.',
        transitionedAt: timestamp,
      });
      const transaction = {
        insert: () => {
          throw new Error('must not append history');
        },
        select: () => selectLimiting([{ ...activeRow, currentRevision: 2 }]),
        update: () => updateReturning([]),
      };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockLocationPersistenceForScope(transaction, scope);

      const failure = yield* persistence.saveTransition({ expectedRevision: 1, next: retired }).pipe(Effect.flip);

      expect(Schema.is(StockLocationPersistenceRejected)(failure)).toBe(true);
      expect(failure).toMatchObject({ actualRevision: 2, reason: 'REVISION_CONFLICT' });
    }),
  );

  it.effect('rejects a foreign-Tenant identity before touching the scoped transaction', () =>
    Effect.gen(function* enforceTenantScope() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('must not touch transaction');
          },
        },
      );
      // @ts-expect-error Mock deliberately exposes no transaction operations.
      const persistence = stockLocationPersistenceForScope(transaction, scope);
      const foreignRef = locationRef(locationId, otherTenantId);

      const failure = yield* persistence.read(foreignRef).pipe(Effect.flip);

      expect(Schema.is(StockLocationPersistenceRejected)(failure)).toBe(true);
      expect(failure.reason).toBe('TENANT_SCOPE_MISMATCH');
    }),
  );

  it.effect('reads append-only snapshots in revision order without substituting the current row', () =>
    Effect.gen(function* readHistory() {
      const retired = yield* transitionStockLocation(active, {
        _tag: 'RETIRE',
        reason: 'Owner retired the operational scope.',
        transitionedAt: timestamp,
      });
      const transaction = {
        select: () => selectOrdering([{ snapshot: active }, { snapshot: retired }]),
      };
      // @ts-expect-error Mock implements only the exercised revision-read chain.
      const persistence = stockLocationPersistenceForScope(transaction, scope);

      const history = yield* persistence.readHistory(active.ref);

      expect(history).toEqual([active, retired]);
      expect(Option.some(history[0])).toEqual(Option.some(active));
    }),
  );
});

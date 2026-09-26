import { getTableConfig } from 'drizzle-orm/pg-core';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { InventorySourceAssertionSchema } from '../../shared/domain/inventory-source-assertion.ts';
import {
  inventorySourceAssertionCoverage,
  inventorySourceAssertionCoverageCompletenessContract,
  inventorySourceAssertionImmutabilityContract,
  inventorySourceAssertions,
} from '../../src/persistence/inventory-source-assertion-table.ts';
import { inventorySourceAssertionPersistenceForScope } from '../../src/persistence/inventory-source-assertion-repository.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const assertionId = '22222222-2222-4222-8222-222222222222';
const observedAt = '2026-09-24T10:00:00.000Z';
const assertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
  assertionId,
  authorityConfiguration: {
    configurationId: '77777777-7777-4777-8777-777777777777',
    customerConfigurationId: 'customer-configuration:primary',
    revision: 1,
    selectedAt: observedAt,
    selection: {
      backend: 'external_business_system',
      backendId: 'erp-a',
      exactReservationCapability: 'SUPPORTED',
      stockCorrectionCapability: 'UNSUPPORTED',
    },
    tenantId,
  },
  businessObservedAt: observedAt,
  coverage: [
    {
      assertionId,
      effectId: '88888888-8888-4888-8888-888888888888',
      ownerEvidenceRef: 'erp-a:coverage:issue-42',
      relation: 'INCLUDES',
    },
  ],
  customerConfigurationId: 'customer-configuration:primary',
  factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
  issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
  issuerAuthority: 'SELECTED_BACKEND',
  itemCorrelationRef: {
    moduleId: 'commerce.inventory',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.inventory.external-stock-correlation',
    tenantId,
  },
  itemExternalKey: {
    customerConfigurationId: 'customer-configuration:primary',
    externalScope: 'warehouse:prague',
    externalValue: 'ITEM-123',
    identifierKind: 'ITEM',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  },
  locationCorrelationRef: {
    moduleId: 'commerce.inventory',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.inventory.external-stock-correlation',
    tenantId,
  },
  locationExternalKey: {
    customerConfigurationId: 'customer-configuration:primary',
    externalScope: 'warehouse:prague',
    externalValue: 'LOC-123',
    identifierKind: 'LOCATION',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  },
  orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '000042' },
  ownerEvidenceRef: 'erp-a:snapshot:42',
  positionRef: {
    moduleId: 'commerce.inventory',
    resourceId: '33333333-3333-4333-8333-333333333333',
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
  quantity: {
    amount: '10',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  receivedAt: '2026-09-24T12:00:00.000Z',
  sourceReference: 'erp-a:warehouse:prague:snapshot:42',
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
  stockLocationRef: {
    moduleId: 'commerce.inventory',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.inventory.stock-location',
    tenantId,
  },
});

const scope = { tenantId } as const;

const selectRows = (rows: readonly unknown[]) => ({
  from: () => ({
    where: () => {
      const result = Effect.succeed(rows);
      return Object.assign(result, { limit: () => result });
    },
  }),
});

describe('Inventory Source Assertion persistence', () => {
  it('declares exact tenant, Position, Item, Location, correlation, effect, RLS, and append-only contracts', () => {
    const assertions = getTableConfig(inventorySourceAssertions);
    const coverage = getTableConfig(inventorySourceAssertionCoverage);

    expect(assertions.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_source_assertions_position_fk',
        'inventory_source_assertions_authority_configuration_fk',
        'inventory_source_assertions_item_fk',
        'inventory_source_assertions_location_fk',
        'inventory_source_assertions_item_correlation_fk',
        'inventory_source_assertions_location_correlation_fk',
      ]),
    );
    expect(coverage.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_source_assertion_coverage_assertion_fk',
        'inventory_source_assertion_coverage_effect_fk',
      ]),
    );
    expect(assertions.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(coverage.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventorySourceAssertionImmutabilityContract.tables).toEqual([
      'inventory.source_assertions',
      'inventory.source_assertion_coverage',
    ]);
    expect(inventorySourceAssertionCoverageCompletenessContract).toMatchObject({
      effectRequiredState: 'APPLIED',
      mode: 'DEFERRABLE INITIALLY DEFERRED',
      relation: 'BIJECTION',
    });
  });

  it.effect('appends the exact assertion and its coverage without mutating prior history', () =>
    Effect.gen(function* appendAssertion() {
      const insertedTables: (typeof inventorySourceAssertions | typeof inventorySourceAssertionCoverage)[] = [];
      const transaction = {
        insert: (table: typeof inventorySourceAssertions | typeof inventorySourceAssertionCoverage) => {
          insertedTables.push(table);
          return {
            values: () =>
              table === inventorySourceAssertions
                ? { returning: () => Effect.succeed([{ assertionJson: assertion }]) }
                : Effect.succeed([]),
          };
        },
      };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = inventorySourceAssertionPersistenceForScope(transaction, scope);

      const stored = yield* persistence.append(assertion);

      expect(stored).toEqual(assertion);
      expect(insertedTables).toEqual([inventorySourceAssertions, inventorySourceAssertionCoverage]);
    }),
  );

  it.effect('reads immutable evidence and rebuilds coverage from the relational rows', () =>
    Effect.gen(function* readAssertion() {
      const assertionRow = { assertionJson: assertion };
      const coverageRow = {
        assertionId,
        effectId: assertion.coverage[0]?.effectId,
        ownerEvidenceRef: assertion.coverage[0]?.ownerEvidenceRef,
        relation: assertion.coverage[0]?.relation,
      };
      const queuedRows = [[assertionRow], [coverageRow]];
      const transaction = { select: () => selectRows(queuedRows.shift() ?? []) };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = inventorySourceAssertionPersistenceForScope(transaction, scope);

      const found = yield* persistence.findById(assertion.assertionId);

      expect(Option.getOrThrow(found)).toEqual(assertion);
    }),
  );

  it.effect('fails closed when relational coverage is incomplete instead of erasing JSON evidence', () =>
    Effect.gen(function* rejectIncompleteCoverage() {
      const queuedRows = [[{ assertionJson: assertion }], []];
      const transaction = { select: () => selectRows(queuedRows.shift() ?? []) };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = inventorySourceAssertionPersistenceForScope(transaction, scope);

      const failure = yield* persistence.findById(assertion.assertionId).pipe(Effect.flip);

      expect(failure).toMatchObject({ code: 'inventory_source_assertion_unavailable', retryable: true });
    }),
  );

  it.effect('rejects a cross-tenant append before touching the transaction', () =>
    Effect.gen(function* rejectCrossTenant() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('must not touch transaction');
          },
        },
      );
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = inventorySourceAssertionPersistenceForScope(transaction, {
        tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });

      const failure = yield* persistence.append(assertion).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'INVALID_ASSERTION' });
    }),
  );
});

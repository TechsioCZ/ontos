import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Cause, DateTime, Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ExternalStockCorrelationSchema } from '../../shared/domain/external-stock-correlation.ts';
import { ExternalStockCorrelationRejected } from '../../shared/domain/external-stock-correlation-rejected.ts';
import { ExternalStockCorrelationRefSchema } from '../../shared/resources/external-stock-correlation.ts';
import {
  externalStockCorrelationPersistenceForScope,
  mapExternalStockCorrelationWriteError,
} from '../../src/persistence/external-stock-correlation-repository.ts';
import {
  INVENTORY_EXTERNAL_STOCK_CORRELATION_TABLES,
  inventoryExternalStockCorrelationImmutabilityContract,
  inventoryExternalStockCorrelationNonoverlapContract,
  inventoryExternalStockCorrelations,
} from '../../src/persistence/external-stock-correlation-table.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const correlationId = '22222222-2222-4222-8222-222222222222';
const stockItemId = '33333333-3333-4333-8333-333333333333';
const instant = '2026-09-24T10:00:00.000Z';
const instantDate = DateTime.toDateUtc(DateTime.makeUnsafe(instant));
const decodeCorrelation = Schema.decodeUnknownSync(ExternalStockCorrelationSchema, { onExcessProperty: 'error' });

const correlation = decodeCorrelation({
  confirmedAt: instant,
  correlationRef: {
    moduleId: 'commerce.inventory',
    resourceId: correlationId,
    resourceType: 'commerce.inventory.external-stock-correlation',
    tenantId,
  },
  effectivePeriod: { from: instant, to: null },
  externalKey: {
    customerConfigurationId: 'customer-configuration:primary',
    externalScope: 'warehouse:prague',
    externalValue: 'ABC123',
    identifierKind: 'ITEM',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    namespace: 'inventory',
    tenantId,
  },
  lifecycle: 'CURRENT',
  ownerEvidenceRef: 'erp-a:proof:1',
  revision: 1,
  target: {
    _tag: 'STOCK_ITEM',
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: stockItemId,
      resourceType: 'commerce.inventory.stock-item',
      tenantId,
    },
  },
});

const row = {
  confirmedAt: instantDate,
  correlationId,
  customerConfigurationId: correlation.externalKey.customerConfigurationId,
  effectiveFrom: instantDate,
  effectiveTo: null,
  externalScope: correlation.externalKey.externalScope,
  externalValue: correlation.externalKey.externalValue,
  identifierKind: correlation.externalKey.identifierKind,
  issuerBackendId: correlation.externalKey.issuer.backendId,
  issuerBackendKind: correlation.externalKey.issuer.backendKind,
  lifecycleState: correlation.lifecycle,
  namespace: correlation.externalKey.namespace,
  ownerEvidenceRef: correlation.ownerEvidenceRef,
  revision: correlation.revision,
  stockItemId,
  stockLocationId: null,
  tenantId,
};

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:external-stock-correlation-test:run:1',
    authMethod: 'system',
    principalId: '44444444-4444-4444-8444-444444444444',
    tenantId,
  }),
  correlationId: 'external-stock-correlation-test',
};

describe('Inventory External Stock Correlation persistence', () => {
  it('owns one tenant-RLS table with exact qualified-key Current uniqueness and target foreign keys', () => {
    expect(INVENTORY_EXTERNAL_STOCK_CORRELATION_TABLES).toEqual([inventoryExternalStockCorrelations]);
    const config = getTableConfig(inventoryExternalStockCorrelations);
    const currentKey = config.indexes.find(
      (candidate) => candidate.config.name === 'inventory_external_stock_correlations_current_key_uk',
    );

    expect(`${config.schema}.${config.name}`).toBe('inventory.external_stock_correlations');
    expect(config.enableRLS).toBe(true);
    expect(currentKey?.config.unique).toBe(true);
    expect(currentKey?.config.where).toBeDefined();
    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_external_stock_correlations_item_fk',
        'inventory_external_stock_correlations_location_fk',
      ]),
    );
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
  });

  it('publishes migration contracts that preserve identity and reject overlapping Effective Periods', () => {
    expect(inventoryExternalStockCorrelationImmutabilityContract).toMatchObject({
      comparison: 'IS DISTINCT FROM',
      deleteTriggerName: 'inventory_external_stock_correlations_no_delete_trg',
      functionName: 'inventory.reject_external_stock_correlation_identity_mutation',
      table: 'inventory.external_stock_correlations',
      updateTriggerName: 'inventory_external_stock_correlations_immutable_identity_trg',
    });
    expect(inventoryExternalStockCorrelationNonoverlapContract).toEqual({
      errorCondition: 'exclusion_violation',
      event: 'INSERT OR UPDATE',
      functionName: 'inventory.enforce_external_stock_correlation_nonoverlap',
      period: '[effective_from, effective_to)',
      table: 'inventory.external_stock_correlations',
      triggerName: 'inventory_external_stock_correlations_nonoverlap_trg',
    });
  });

  it('maps a Cause-wrapped missing Stock Item target to a typed domain rejection', () => {
    const failure = mapExternalStockCorrelationWriteError(
      Cause.fail({
        code: '23503',
        constraint: 'inventory_external_stock_correlations_item_fk',
      }),
    );

    expect(Schema.is(ExternalStockCorrelationRejected)(failure)).toBe(true);
    expect(failure).toMatchObject({ reason: 'TARGET_NOT_FOUND' });
  });

  it('maps a Cause-wrapped missing Stock Location target to a typed domain rejection', () => {
    const failure = mapExternalStockCorrelationWriteError(
      Cause.die({
        code: '23503',
        constraint: 'inventory_external_stock_correlations_location_fk',
      }),
    );

    expect(Schema.is(ExternalStockCorrelationRejected)(failure)).toBe(true);
    expect(failure).toMatchObject({ reason: 'TARGET_NOT_FOUND' });
  });

  /* oxlint-disable sonarjs/no-nested-functions -- The typed transaction mock mirrors the Drizzle read chain; expires: 2027-03-31. */
  it.effect('decodes the exact target and historical period from the owner repository', () =>
    Effect.gen(function* readExactCorrelation() {
      const transaction = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Effect.succeed([row]) }),
          }),
        }),
      };
      // @ts-expect-error Mock implements only the exercised typed read chain.
      const persistence = externalStockCorrelationPersistenceForScope(transaction, scope);

      const observed = yield* persistence.findByRef(correlation.correlationRef);

      expect(Option.getOrThrow(observed)).toEqual(correlation);
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
      const persistence = externalStockCorrelationPersistenceForScope(transaction, scope);
      const foreignRef = Schema.decodeUnknownSync(ExternalStockCorrelationRefSchema)({
        ...correlation.correlationRef,
        tenantId: '99999999-9999-4999-8999-999999999999',
      });

      const failure = yield* persistence.findByRef(foreignRef).pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'TENANT_SCOPE_MISMATCH' });
    }),
  );
});

import { Cause, DateTime, Effect, Schema } from 'effect';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'effect-rstest';

import { StockSharingEligibilitySchema } from '../../shared/domain/stock-sharing-eligibility.ts';
import type { StockSharingEligibility } from '../../shared/domain/stock-sharing-eligibility.ts';
import {
  decodeStockSharingEligibilityHistoryRows,
  mapStockSharingEligibilityWriteError,
} from '../../src/persistence/stock-sharing-eligibility-repository.ts';
import {
  INVENTORY_STOCK_SHARING_ELIGIBILITY_TABLES,
  inventoryStockSharingEligibilities,
  inventoryStockSharingEligibilityHistory,
  inventoryStockSharingEligibilityHistoryImmutabilityContract,
  inventoryStockSharingEligibilityIdentityImmutabilityContract,
  inventoryStockSharingEligibilityScopeTriggerContract,
} from '../../src/persistence/stock-sharing-eligibility-table.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const establishedAt = '2026-09-24T10:00:00.000Z';
const changedAt = '2026-09-24T10:30:00.000Z';
const endedAt = '2026-09-24T11:00:00.000Z';
const established = Schema.decodeUnknownSync(StockSharingEligibilitySchema)({
  commerceValidation: {
    evidenceRef: 'commerce-validation:1',
    observedAt: establishedAt,
    verification: 'OWNER_VERIFIED_CURRENT',
  },
  effectivePeriod: { from: establishedAt, to: null },
  lifecycle: 'CURRENT',
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.inventory.stock-sharing-eligibility',
    tenantId,
  },
  revision: 1,
  scope: {
    customerConfigurationId: 'customer-configuration:primary',
    ownerConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: '44444444-4444-4444-8444-444444444444',
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    positionRef: {
      moduleId: 'commerce.inventory',
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.inventory.stock-position',
      tenantId,
    },
  },
  subject: {
    channel: 'B2C',
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
  },
});
const changed = Schema.decodeSync(StockSharingEligibilitySchema)({
  ...established,
  effectivePeriod: { from: changedAt, to: null },
  revision: 2,
  subject: { ...established.subject, storefrontRef: { appId: 'shop-cz', tenantId } },
});
const ended = Schema.decodeSync(StockSharingEligibilitySchema)({
  ...changed,
  effectivePeriod: { from: changedAt, to: endedAt },
  lifecycle: 'ENDED',
  revision: 3,
});
const asDate = (instant: StockSharingEligibility['effectivePeriod']['from']) =>
  DateTime.toDateUtc(DateTime.makeUnsafe(instant));

describe('Inventory Stock Sharing Eligibility persistence contract', () => {
  it('owns tenant-RLS Current and append-only history tables with exact Position/backend scope', () => {
    expect(INVENTORY_STOCK_SHARING_ELIGIBILITY_TABLES).toEqual([
      inventoryStockSharingEligibilityHistory,
      inventoryStockSharingEligibilities,
    ]);
    const current = getTableConfig(inventoryStockSharingEligibilities);
    const history = getTableConfig(inventoryStockSharingEligibilityHistory);

    expect(`${current.schema}.${current.name}`).toBe('inventory.stock_sharing_eligibilities');
    expect(`${history.schema}.${history.name}`).toBe('inventory.stock_sharing_eligibility_history');
    expect(current.enableRLS).toBe(true);
    expect(history.enableRLS).toBe(true);
    expect(current.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'customer_configuration_id',
        'owner_configuration_id',
        'stock_position_id',
        'selling_legal_entity_id',
        'channel',
        'commerce_market_id',
        'storefront_app_id',
      ]),
    );
    expect(current.columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(['principal_id', 'purchasing_subject_id', 'price_group_id', 'reservation_id']),
    );
    expect(current.foreignKeys.map((foreignKey) => foreignKey.getName())).toEqual(
      expect.arrayContaining([
        'inventory_stock_sharing_eligibilities_backend_configuration_fk',
        'inventory_stock_sharing_eligibilities_position_fk',
      ]),
    );
  });

  it('publishes migration hardening for exact scope, immutable identity, and append-only history', () => {
    expect(inventoryStockSharingEligibilityScopeTriggerContract).toMatchObject({
      event: 'INSERT OR UPDATE',
      positionRequiredLifecycle: 'CURRENT',
      table: 'inventory.stock_sharing_eligibilities',
    });
    expect(inventoryStockSharingEligibilityIdentityImmutabilityContract.columns).toEqual([
      'eligibility_id',
      'tenant_id',
      'customer_configuration_id',
      'owner_configuration_id',
      'stock_position_id',
    ]);
    expect(inventoryStockSharingEligibilityHistoryImmutabilityContract).toEqual({
      deleteTriggerName: 'inventory_stock_sharing_eligibility_history_no_delete_trg',
      functionName: 'inventory.reject_stock_sharing_eligibility_history_mutation',
      table: 'inventory.stock_sharing_eligibility_history',
      updateTriggerName: 'inventory_stock_sharing_eligibility_history_no_update_trg',
    });
  });

  it.effect('decodes every appended revision and closes superseded effective intervals in order', () =>
    Effect.gen(function* decodeCompleteHistory() {
      const rows: readonly (typeof inventoryStockSharingEligibilityHistory.$inferSelect)[] = [
        {
          eligibilityId: established.ref.resourceId,
          historyId: '66666666-6666-4666-8666-666666666661',
          recordedAt: asDate(establishedAt),
          revision: 1,
          snapshot: established,
          tenantId,
          transitionAt: asDate(establishedAt),
        },
        {
          eligibilityId: changed.ref.resourceId,
          historyId: '66666666-6666-4666-8666-666666666662',
          recordedAt: asDate(changedAt),
          revision: 2,
          snapshot: changed,
          tenantId,
          transitionAt: asDate(changedAt),
        },
        {
          eligibilityId: ended.ref.resourceId,
          historyId: '66666666-6666-4666-8666-666666666663',
          recordedAt: asDate(endedAt),
          revision: 3,
          snapshot: ended,
          tenantId,
          transitionAt: asDate(endedAt),
        },
      ];

      const history = yield* decodeStockSharingEligibilityHistoryRows(rows);

      expect(history.map(({ revision }) => revision)).toEqual([1, 2, 3]);
      expect(history[0]?.effectivePeriod.to).toBe(changedAt);
      expect(history[1]?.effectivePeriod.to).toBe(endedAt);
      expect(history[2]).toEqual(ended);
    }),
  );

  it('maps exact identity, revision, and scope database failures to typed reasons', () => {
    const uniqueViolation = ['23', '505'].join('');
    const checkViolation = ['23', '514'].join('');

    expect(
      mapStockSharingEligibilityWriteError(
        Cause.fail({ code: uniqueViolation, constraint: 'inventory_stock_sharing_eligibilities_scope_id_uk' }),
      ),
    ).toMatchObject({ reason: 'RELATION_IDENTITY_CONFLICT' });
    expect(
      mapStockSharingEligibilityWriteError(
        Cause.fail({ code: uniqueViolation, constraint: 'inventory_stock_sharing_eligibility_history_revision_uk' }),
      ),
    ).toMatchObject({ reason: 'REVISION_CONFLICT' });
    expect(
      mapStockSharingEligibilityWriteError(
        Cause.die({ code: checkViolation, constraint: 'inventory_stock_sharing_eligibilities_position_scope_ck' }),
      ),
    ).toMatchObject({ reason: 'POSITION_SCOPE_MISMATCH' });
  });
});

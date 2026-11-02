import { getTableConfig } from 'drizzle-orm/pg-core';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  InventorySourceImportLedgerEntrySchema,
  InventorySourceImportUnavailable,
} from '../../shared/domain/inventory-source-import-outcome.ts';
import {
  InventorySourceAssertionProposalSchema,
  InventorySourceAssertionSchema,
} from '../../shared/domain/inventory-source-assertion.ts';
import { inventorySourceImportLedgerPersistenceForScope } from '../../src/persistence/inventory-source-import-ledger-repository.ts';
import {
  inventorySourceImportLedger,
  inventorySourceImportLedgerVerifierContract,
} from '../../src/persistence/inventory-source-import-ledger-table.ts';
import { inventoryStockPositions } from '../../src/persistence/stock-position-table.ts';
import {
  inventorySourceAssertions,
  inventorySourceAssertionCoverage,
} from '../../src/persistence/inventory-source-assertion-table.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actionInvocationId = '22222222-2222-4222-8222-222222222222';
const assertionId = '33333333-3333-4333-8333-333333333333';
const proposal = Schema.decodeUnknownSync(InventorySourceAssertionProposalSchema)({
  assertionId,
  businessObservedAt: '2026-09-24T10:00:00.000Z',
  coverage: [],
  customerConfigurationId: 'customer-configuration:primary',
  factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
  issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
  itemExternalKey: {
    customerConfigurationId: 'customer-configuration:primary',
    externalScope: 'warehouse:prague',
    externalValue: 'ITEM-123',
    identifierKind: 'ITEM',
    issuer: { backendId: 'erp-a', backendKind: 'external_business_system' },
    namespace: 'inventory',
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
  orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '42' },
  ownerEvidenceRef: 'erp-a:snapshot:42',
  positionRef: {
    moduleId: 'commerce.inventory',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
  quantity: {
    amount: '8',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '55555555-5555-4555-8555-555555555555',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  receivedAt: '2026-09-24T12:00:00.000Z',
  sourceReference: 'erp-a:warehouse:prague:snapshot:42',
});
const outcome = { assertionId, postEffectOnHand: proposal.quantity, status: 'ACCEPTED' as const };
const entry = Schema.decodeUnknownSync(InventorySourceImportLedgerEntrySchema)({
  actionInvocationId,
  itemIndex: 0,
  outcome,
  proposal,
});
const row = {
  actionInvocationId,
  assertionId,
  customerConfigurationId: proposal.customerConfigurationId,
  factMeaning: proposal.factMeaning,
  issuerBackendId: proposal.issuer.backendId,
  issuerBackendKind: proposal.issuer.backendKind,
  itemIndex: 0,
  orderingEvidenceKind: proposal.orderingEvidence._tag,
  orderingEvidenceValue: '42',
  outcomeJson: outcome,
  positionId: proposal.positionRef.resourceId,
  proposalJson: proposal,
  recordedAt: new Date('2026-09-24T12:00:00.000Z'),
  sourceReference: proposal.sourceReference,
  status: outcome.status,
  tenantId,
};

/* oxlint-disable sonarjs/no-nested-functions -- Query-chain fakes exercise the public scoped repository seam; expires: 2027-03-31. */
describe('Inventory source import ledger', () => {
  it('declares durable accepted-identity uniqueness, Position scope, RLS, and immutable exact-scope verification', () => {
    const config = getTableConfig(inventorySourceImportLedger);

    expect(config.indexes.map(({ config: index }) => index.name)).toEqual(
      expect.arrayContaining([
        'inventory_source_import_accepted_assertion_uk',
        'inventory_source_import_accepted_source_identity_uk',
        'inventory_source_import_accepted_revision_uk',
        'inventory_source_import_ledger_stream_idx',
      ]),
    );
    expect(config.foreignKeys.map((foreignKey) => foreignKey.getName())).toContain(
      'inventory_source_import_ledger_position_fk',
    );
    expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
    expect(inventorySourceImportLedgerVerifierContract).toMatchObject({
      acceptedAssertionForeignKey: 'inventory_source_import_ledger_accepted_assertion_fk',
      immutableTriggerName: 'inventory_source_import_ledger_immutable_trg',
      scopeTriggerName: 'inventory_source_import_ledger_exact_scope_trg',
    });
  });

  it.effect('locks the exact Stock Position before reading accepted source history', () =>
    Effect.gen(function* lockStream() {
      type SelectedTable =
        | typeof inventorySourceImportLedger
        | typeof inventoryStockPositions
        | typeof inventorySourceAssertions
        | typeof inventorySourceAssertionCoverage;
      const selectedTables: SelectedTable[] = [];
      const lockedTables: SelectedTable[] = [];
      const uncertain = {
        ...entry,
        outcome: {
          assertionId,
          reason: 'MATERIAL_EFFECT_COVERAGE_UNKNOWN',
          reconciliationRequired: true as const,
          status: 'INDETERMINATE' as const,
        },
      };
      const uncertainRow = { ...row, outcomeJson: uncertain.outcome, status: 'INDETERMINATE' };
      const assertion = Schema.decodeUnknownSync(InventorySourceAssertionSchema)({
        ...proposal,
        authorityConfiguration: {
          configurationId: '77777777-7777-4777-8777-777777777777',
          customerConfigurationId: proposal.customerConfigurationId,
          revision: 1,
          selectedAt: '2026-09-24T09:00:00.000Z',
          selection: {
            backend: 'external_business_system',
            backendId: 'erp-a',
            exactReservationCapability: 'SUPPORTED',
            stockCorrectionCapability: 'UNSUPPORTED',
          },
          tenantId,
        },
        issuerAuthority: 'SELECTED_BACKEND',
        itemCorrelationRef: {
          moduleId: 'commerce.inventory',
          resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          resourceType: 'commerce.inventory.external-stock-correlation',
          tenantId,
        },
        locationCorrelationRef: {
          moduleId: 'commerce.inventory',
          resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          resourceType: 'commerce.inventory.external-stock-correlation',
          tenantId,
        },
        stockItemRef: {
          moduleId: 'commerce.inventory',
          resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          resourceType: 'commerce.inventory.stock-item',
          tenantId,
        },
        stockLocationRef: {
          moduleId: 'commerce.inventory',
          resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          resourceType: 'commerce.inventory.stock-location',
          tenantId,
        },
      });
      const queuedRows: unknown[][] = [
        [{ positionId: proposal.positionRef.resourceId }],
        [row],
        [{ entry: uncertainRow }],
        [{ assertionJson: assertion }],
        [],
      ];
      const transaction = {
        select: () => ({
          from: (table: SelectedTable) => {
            selectedTables.push(table);
            const effect = Effect.succeed(queuedRows.shift() ?? []);
            const result = Object.assign(effect, { limit: () => effect });
            return {
              innerJoin: () => ({ where: () => result }),
              where: () =>
                table === inventoryStockPositions
                  ? {
                      for: () => {
                        lockedTables.push(table);
                        return result;
                      },
                    }
                  : result,
            };
          },
        }),
      };
      // @ts-expect-error Mock implements only the exercised query chains.
      const persistence = inventorySourceImportLedgerPersistenceForScope(transaction, { tenantId });

      const history = yield* persistence.lockAndReadAcceptedHistory(proposal);

      expect(history).toEqual([entry]);
      expect(selectedTables).toEqual([inventoryStockPositions, inventorySourceImportLedger]);
      expect(lockedTables).toEqual([inventoryStockPositions]);
      const persisted = yield* persistence.findPersistedSourceHistory(proposal);
      expect(persisted).toEqual([uncertain]);
      expect(selectedTables.slice(2)).toEqual([
        inventorySourceImportLedger,
        inventorySourceAssertions,
        inventorySourceAssertionCoverage,
      ]);
      const queryCount = selectedTables.length;
      expect(
        yield* persistence.findPersistedSourceHistory({
          ...proposal,
          positionRef: { ...proposal.positionRef, tenantId: '99999999-9999-4999-8999-999999999999' },
        }),
      ).toEqual([]);
      expect(selectedTables).toHaveLength(queryCount);
      queuedRows.push(
        [{ entry: uncertainRow }],
        [{ assertionJson: { ...assertion, quantity: { ...assertion.quantity, amount: '999' } } }],
        [],
      );
      const invalid = yield* persistence.findPersistedSourceHistory(proposal).pipe(Effect.flip);
      expect(Schema.is(InventorySourceImportUnavailable)(invalid)).toBe(true);
    }),
  );

  it.effect('records and returns the exact per-item decision evidence', () =>
    Effect.gen(function* appendDecision() {
      const inserted: (typeof inventorySourceImportLedger)[] = [];
      const transaction = {
        insert: (table: typeof inventorySourceImportLedger) => {
          inserted.push(table);
          return { values: () => ({ returning: () => Effect.succeed([row]) }) };
        },
      };
      // @ts-expect-error Mock implements only the exercised insert chain.
      const persistence = inventorySourceImportLedgerPersistenceForScope(transaction, { tenantId });

      const stored = yield* persistence.append(entry);

      expect(stored).toEqual(entry);
      expect(inserted).toEqual([inventorySourceImportLedger]);
    }),
  );
});
/* oxlint-enable sonarjs/no-nested-functions */

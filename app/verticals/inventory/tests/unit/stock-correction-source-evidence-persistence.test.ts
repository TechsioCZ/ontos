import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { OntosWmsStockCorrectionSourceEvidenceSchema } from '../../shared/domain/stock-correction.ts';
import { stockCorrectionSourceEvidencePersistenceForScope } from '../../src/persistence/stock-correction-source-evidence-repository.ts';
import {
  inventoryStockCorrectionSourceEvidence,
  inventoryStockCorrectionSourceEvidenceCoverage,
  inventoryStockCorrectionSourceEvidenceCurrent,
} from '../../src/persistence/stock-correction-source-evidence-table.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '22222222-2222-4222-8222-222222222222';
const effectId = '33333333-3333-4333-8333-333333333333';
const observedAt = '2026-09-24T10:00:00.000Z';
const configuration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId: '44444444-4444-4444-8444-444444444444',
  customerConfigurationId: 'customer-configuration:primary',
  revision: 1,
  selectedAt: '2026-09-01T00:00:00.000Z',
  selection: {
    backend: 'ontos_wms',
    backendId: 'ontos-wms-primary',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});
const evidence = Schema.decodeUnknownSync(OntosWmsStockCorrectionSourceEvidenceSchema)({
  authorityConfiguration: configuration,
  businessObservedAt: observedAt,
  coverage: [
    {
      effectId,
      evidenceId,
      ownerEvidenceRef: 'ontos-wms:coverage:issue-41',
      relation: 'INCLUDES',
    },
  ],
  customerConfigurationId: 'customer-configuration:primary',
  evidenceId,
  factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
  issuer: { backendId: 'ontos-wms-primary', backendKind: 'ontos_wms' },
  orderingEvidence: { _tag: 'OWNER_ORDER_KEY', key: 'count-sequence:000042' },
  ownerEvidenceRef: 'ontos-wms:count:42',
  positionRef: {
    moduleId: 'commerce.inventory',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.inventory.stock-position',
    tenantId,
  },
  quantity: {
    amount: '7',
    unitRef: {
      moduleId: 'commerce.catalog',
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'commerce.catalog.product-unit',
      tenantId,
    },
  },
  receivedAt: '2026-09-24T10:01:00.000Z',
  sourceReference: 'ontos-wms:warehouse:prague:count:42',
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: '77777777-7777-4777-8777-777777777777',
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
  stockLocationRef: {
    moduleId: 'commerce.inventory',
    resourceId: '88888888-8888-4888-8888-888888888888',
    resourceType: 'commerce.inventory.stock-location',
    tenantId,
  },
});
const scope = { tenantId } as const;

const evidenceRow = { evidenceJson: evidence };
const coverageRow = {
  effectId,
  evidenceId,
  ownerEvidenceRef: evidence.coverage[0]?.ownerEvidenceRef,
  relation: evidence.coverage[0]?.relation,
};

const selectRows = (rows: readonly unknown[]) => ({
  from: () => {
    const where = () => {
      const result = Effect.succeed(rows);
      return Object.assign(result, { limit: () => result });
    };
    return { innerJoin: () => ({ where }), where };
  },
});

describe('Stock Correction source evidence persistence', () => {
  it.effect('appends trusted owner evidence and its evidence-bound coverage atomically', () =>
    Effect.gen(function* appendEvidence() {
      const insertedTables: (
        | typeof inventoryStockCorrectionSourceEvidence
        | typeof inventoryStockCorrectionSourceEvidenceCoverage
        | typeof inventoryStockCorrectionSourceEvidenceCurrent
      )[] = [];
      const transaction = {
        insert: (
          table:
            | typeof inventoryStockCorrectionSourceEvidence
            | typeof inventoryStockCorrectionSourceEvidenceCoverage
            | typeof inventoryStockCorrectionSourceEvidenceCurrent,
        ) => {
          insertedTables.push(table);
          return table === inventoryStockCorrectionSourceEvidenceCurrent
            ? {
                values: () => ({
                  onConflictDoUpdate: () => Effect.succeed([]),
                }),
              }
            : {
                values: () =>
                  table === inventoryStockCorrectionSourceEvidence
                    ? { returning: () => Effect.succeed([evidenceRow]) }
                    : Effect.succeed([]),
              };
        },
      };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockCorrectionSourceEvidencePersistenceForScope(transaction, scope);

      const stored = yield* persistence.appendTrusted(evidence);

      expect(stored).toEqual(evidence);
      expect(insertedTables).toEqual([
        inventoryStockCorrectionSourceEvidence,
        inventoryStockCorrectionSourceEvidenceCoverage,
        inventoryStockCorrectionSourceEvidenceCurrent,
      ]);
    }),
  );

  it.effect('resolves current evidence from only its opaque ID and rebuilds coverage from relational rows', () =>
    Effect.gen(function* readCurrentEvidence() {
      const queuedRows = [[evidenceRow], [coverageRow]];
      const transaction = { select: () => selectRows(queuedRows.shift() ?? []) };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockCorrectionSourceEvidencePersistenceForScope(transaction, scope);

      const found = yield* persistence.findCurrentById(evidence.evidenceId);

      expect(Option.getOrThrow(found)).toEqual(evidence);
    }),
  );

  it.effect('returns no current evidence when a newer owner-order proof exists in the same stream', () =>
    Effect.gen(function* rejectSupersededEvidence() {
      const queuedRows = [[]];
      const transaction = { select: () => selectRows(queuedRows.shift() ?? []) };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockCorrectionSourceEvidencePersistenceForScope(transaction, scope);

      const found = yield* persistence.findCurrentById(evidence.evidenceId);

      expect(Option.isNone(found)).toBe(true);
    }),
  );

  it.effect('fails closed when relational coverage no longer proves the stored evidence', () =>
    Effect.gen(function* rejectIncompleteCoverage() {
      const queuedRows = [[evidenceRow], []];
      const transaction = { select: () => selectRows(queuedRows.shift() ?? []) };
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const persistence = stockCorrectionSourceEvidencePersistenceForScope(transaction, scope);

      const failure = yield* persistence.findCurrentById(evidence.evidenceId).pipe(Effect.flip);

      expect(failure).toMatchObject({ code: 'stock_correction_unavailable', retryable: true });
    }),
  );

  it.effect('rejects cross-Tenant or non-owner-sortable trusted evidence before touching persistence', () =>
    Effect.gen(function* rejectUntrustedAppend() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('must not touch transaction');
          },
        },
      );
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const foreignScopePersistence = stockCorrectionSourceEvidencePersistenceForScope(transaction, {
        tenantId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      });
      const foreignFailure = yield* foreignScopePersistence.appendTrusted(evidence).pipe(Effect.flip);
      expect(foreignFailure).toMatchObject({ code: 'stock_correction_unavailable', retryable: true });

      const invalidOrder = Schema.decodeUnknownSync(OntosWmsStockCorrectionSourceEvidenceSchema)({
        ...evidence,
        orderingEvidence: { _tag: 'SOURCE_REVISION', revision: '42' },
      });
      // @ts-expect-error Mock implements only the exercised transaction chains.
      const sameScopePersistence = stockCorrectionSourceEvidencePersistenceForScope(transaction, scope);
      const orderFailure = yield* sameScopePersistence.appendTrusted(invalidOrder).pipe(Effect.flip);
      expect(orderFailure).toMatchObject({ code: 'stock_correction_unavailable', retryable: true });
    }),
  );

  it('rejects WMS evidence observed before the selected owner cutover', () => {
    expect(() =>
      Schema.decodeUnknownSync(OntosWmsStockCorrectionSourceEvidenceSchema)({
        ...evidence,
        businessObservedAt: '2026-08-31T23:59:59.999Z',
      }),
    ).toThrow(/observed at or after the selected owner cutover/u);
  });
});

import { DateTime, Effect, Option, Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { symmyStockScopeKey } from '../../shared/domain/symmy-stock-batch.ts';
import type { SymmyStockRow, SymmyStockRows, SymmyStockScopeEntry } from '../../shared/domain/symmy-stock-batch.ts';
import { uuidFromDigest } from './derived-identity.ts';

/** The Inventory import every enrolled stock row is planned as, and the one owner operation of the stock route. */
export const stockOperation = {
  entrypointKey: 'commerce.inventory.import-source-assertion',
  moduleId: 'commerce.inventory',
  schemaVersion: '1',
} as const;

interface SymmyStockItemInput<Failure> {
  /** A stable hex digest. Replays of one Idempotency-Key must reproduce every derived identity. */
  readonly digest: (value: string) => Effect.Effect<string, Failure>;
  readonly entry: SymmyStockScopeEntry;
  readonly idempotencyKey: string;
  readonly index: number;
  readonly receivedAt: DateTime.Utc;
  readonly row: SymmyStockRow;
  readonly source: SymmyFixtureExecutionPlan['items'][number]['source'];
}

export interface SymmyStockPlanInput<Failure> {
  readonly digest: SymmyStockItemInput<Failure>['digest'];
  readonly idempotencyKey: string;
  /** The instant of the first admission. A replay never reaches this builder, it reads the saved plan. */
  readonly receivedAt: DateTime.Utc;
  readonly rows: SymmyStockRows;
  readonly template: SymmyFixtureExecutionPlan;
}

const buildStockItem = Effect.fn('SymmyStockPlan.item')(function* buildStockItem<Failure>(
  input: SymmyStockItemInput<Failure>,
) {
  const { digest, entry, idempotencyKey, index, receivedAt, row, source } = input;
  const [assertion, occurrence, record, evidence] = yield* Effect.all(
    [
      digest(`assertion\u0000${idempotencyKey}\u0000${index}`),
      digest(`occurrence\u0000${idempotencyKey}\u0000${index}`),
      digest(`record\u0000${symmyStockScopeKey(row)}`),
      digest(`evidence\u0000${row.revision.length}:${row.revision}${row.sourceReference}`),
    ],
    { concurrency: 4 },
  );
  const key = {
    customerConfigurationId: entry.customerConfigurationId,
    externalScope: entry.scope,
    issuer: { backendId: entry.issuerBackendId, backendKind: 'external_business_system' },
    namespace: entry.namespace,
    tenantId: entry.positionRef.tenantId,
  };
  return {
    effects: [
      {
        effectKey: 'inventory-absolute-on-hand',
        intent: {
          _tag: 'InventoryImport',
          payload: {
            authorizationTargetRef: entry.positionRef,
            items: [
              {
                assertionId: uuidFromDigest(assertion),
                businessObservedAt: row.businessObservedAt,
                coverage: [],
                customerConfigurationId: entry.customerConfigurationId,
                factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
                issuer: key.issuer,
                itemExternalKey: { ...key, externalValue: row.itemKey, identifierKind: 'ITEM' },
                locationExternalKey: { ...key, externalValue: row.locationKey, identifierKind: 'LOCATION' },
                orderingEvidence: { _tag: 'SOURCE_REVISION', revision: row.revision },
                ownerEvidenceRef: `symmy-stock:${evidence}`,
                positionRef: entry.positionRef,
                quantity: row.quantity,
                receivedAt: DateTime.formatIso(receivedAt),
                sourceReference: row.sourceReference,
              },
            ],
          },
        },
        operation: stockOperation,
        originalTarget: entry.positionRef,
      },
    ],
    itemKey: `stock-${index}`,
    source: {
      entityKind: 'STOCK',
      issuerId: source.issuerId,
      sourceNamespace: source.sourceNamespace,
      sourceRecordId: `symmy-stock:${record}`,
    },
    sourceOccurrenceId: uuidFromDigest(occurrence),
  };
});

/**
 * Maps the public stock rows to one internal stock effect per row. A row that names a position the route
 * is not enrolled for, or that the owner could not accept for the enrolled scope, yields no plan at all, so
 * nothing is admitted and no owner call is made for any row of the request.
 */
export const buildSymmyStockPlan = Effect.fn('SymmyStockPlan.build')(function* buildSymmyStockPlan<Failure>(
  input: SymmyStockPlanInput<Failure>,
) {
  const { digest, idempotencyKey, receivedAt, rows, template } = input;
  const [{ source }] = template.items;
  const { inventoryBackendId, stockScope } = template;
  const selectedBackendId: string | undefined = inventoryBackendId;
  if (selectedBackendId === undefined || stockScope === undefined) {
    return Option.none<SymmyFixtureExecutionPlan>();
  }
  const enrolled = new Map(stockScope.map((entry) => [symmyStockScopeKey(entry), entry]));
  const entries = rows.flatMap((row) => {
    const entry = enrolled.get(symmyStockScopeKey(row));
    return entry?.issuerBackendId === selectedBackendId ? [{ entry, row }] : [];
  });
  if (entries.length !== rows.length) {
    return Option.none<SymmyFixtureExecutionPlan>();
  }
  const items = yield* Effect.forEach(
    entries,
    ({ entry, row }, index) => buildStockItem({ digest, entry, idempotencyKey, index, receivedAt, row, source }),
    { concurrency: 1 },
  );
  return Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items });
});

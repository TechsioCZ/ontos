import type { SourceStockPositionResolutionResponse } from '@app/inventory/api/source-stock-position-resolution';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyFixtureExecutionPlan } from '../../shared/domain/symmy-job-execution.ts';
import { symmyStockScopeKey } from '../../shared/domain/symmy-stock-batch.ts';
import type {
  SymmyStockRow,
  SymmyStockRows,
  SymmyInventorySource,
  SymmyStockPositionFacts,
} from '../../shared/domain/symmy-stock-batch.ts';
import { uuidFromDigest } from './derived-identity.ts';

export const stockOperation = {
  entrypointKey: 'commerce.inventory.import-source-assertion',
  moduleId: 'commerce.inventory',
  schemaVersion: '1',
} as const;

interface SymmyStockItemInput<Failure> {
  /** A stable hex digest. Replays of one Idempotency-Key must reproduce every derived identity. */
  readonly digest: (value: string) => Effect.Effect<string, Failure>;
  readonly entry: SymmyInventorySource;
  readonly idempotencyKey: string;
  readonly index: number;
  readonly receivedAt: DateTime.Utc;
  readonly resolution: Extract<SourceStockPositionResolutionResponse, { readonly _tag: 'RESOLVED' }>;
  readonly row: SymmyStockRow;
  readonly source: SymmyFixtureExecutionPlan['items'][number]['source'];
}

export interface SymmyStockPlanInput<Failure> {
  readonly digest: SymmyStockItemInput<Failure>['digest'];
  readonly facts: SymmyStockPositionFacts | undefined;
  readonly idempotencyKey: string;
  /** The instant of the first admission. A replay never reaches this builder, it reads the saved plan. */
  readonly receivedAt: DateTime.Utc;
  readonly rows: SymmyStockRows;
  readonly template: SymmyFixtureExecutionPlan;
}

const buildStockItem = Effect.fn('SymmyStockPlan.item')(function* buildStockItem<Failure>(
  input: SymmyStockItemInput<Failure>,
) {
  const { digest, entry, idempotencyKey, index, receivedAt, resolution, row, source } = input;
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
    externalScope: entry.externalScope,
    issuer: entry.issuer,
    namespace: entry.namespace,
    tenantId: entry.policyRef.tenantId,
  };
  return {
    effects: [
      {
        effectKey: 'inventory-absolute-on-hand',
        intent: {
          _tag: 'InventoryImport',
          payload: {
            authorizationTargetRef: resolution.positionRef,
            items: [
              {
                assertionId: uuidFromDigest(assertion),
                businessObservedAt: row.businessObservedAt,
                coverage: [],
                customerConfigurationId: entry.customerConfigurationId,
                factMeaning: 'ABSOLUTE_PHYSICAL_ON_HAND',
                issuer: entry.issuer,
                itemExternalKey: { ...key, externalValue: row.itemKey, identifierKind: 'ITEM' },
                locationExternalKey: { ...key, externalValue: row.locationKey, identifierKind: 'LOCATION' },
                orderingEvidence: { _tag: 'SOURCE_REVISION', revision: row.revision },
                ownerEvidenceRef: `symmy-stock:${evidence}`,
                positionRef: resolution.positionRef,
                quantity: row.quantity,
                receivedAt: DateTime.formatIso(receivedAt),
                sourceReference: row.sourceReference,
              },
            ],
          },
        },
        operation: stockOperation,
        originalTarget: resolution.positionRef,
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
 * Maps the public stock rows to one internal stock effect per row. Only the fixed location and unit are enrolled. ITEM keys are
 * resolved through Inventory’s public port before admission, after product provisioning. An out-of-policy row yields no plan, so
 * nothing is admitted and no owner call is made for any row of the request.
 */
export const buildSymmyStockPlan = Effect.fn('SymmyStockPlan.build')(function* buildSymmyStockPlan<Failure>(
  input: SymmyStockPlanInput<Failure>,
) {
  const { digest, facts, idempotencyKey, receivedAt, rows, template } = input;
  const [{ source }] = template.items;
  const { inventoryBackendId, inventorySource } = template;
  if (facts === undefined || inventorySource === undefined || inventoryBackendId !== inventorySource.issuer.backendId) {
    return Option.none<SymmyFixtureExecutionPlan>();
  }
  const entries = rows.flatMap((row) => {
    const matches = facts.filter(
      ({ request }) =>
        request.itemKey === row.itemKey &&
        request.locationKey === row.locationKey &&
        request.customerConfigurationId === inventorySource.customerConfigurationId &&
        request.externalScope === inventorySource.externalScope &&
        request.namespace === inventorySource.namespace &&
        request.issuer.backendId === inventorySource.issuer.backendId &&
        request.issuer.backendKind === inventorySource.issuer.backendKind,
    );
    const [fact] = matches;
    const { unitRef } = row.quantity;
    const location = inventorySource.locations.find(({ locationKey }) => locationKey === row.locationKey);
    if (matches.length !== 1 || fact === undefined || location === undefined) {
      return [];
    }
    return Match.value(fact.resolution).pipe(
      Match.tag('UNRESOLVED', () => []),
      Match.tag('RESOLVED', (resolution) =>
        unitRef.tenantId === inventorySource.policyRef.tenantId &&
        unitRef.resourceId === inventorySource.unitRef.resourceId &&
        resolution.positionRef.tenantId === inventorySource.policyRef.tenantId &&
        resolution.policyRef.tenantId === inventorySource.policyRef.tenantId &&
        resolution.policyRef.resourceId === inventorySource.policyRef.resourceId &&
        resolution.stockLocationRef.resourceId === location.stockLocationRef.resourceId &&
        resolution.stockLocationRef.tenantId === location.stockLocationRef.tenantId
          ? [{ entry: inventorySource, resolution, row }]
          : [],
      ),
      Match.exhaustive,
    );
  });
  if (entries.length !== rows.length) {
    return Option.none<SymmyFixtureExecutionPlan>();
  }
  const items = yield* Effect.forEach(
    entries,
    ({ entry, resolution, row }, index) =>
      buildStockItem({ digest, entry, idempotencyKey, index, receivedAt, resolution, row, source }),
    { concurrency: 1 },
  );
  return Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema)({ items });
});

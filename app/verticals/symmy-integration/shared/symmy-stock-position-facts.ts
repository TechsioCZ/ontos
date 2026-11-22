import { SourceStockPositionResolutionRequestSchema } from '@app/inventory/api/source-stock-position-resolution';
import type {
  SourceStockPositionResolutionRequest,
  SourceStockPositionResolutionResponse,
} from '@app/inventory/api/source-stock-position-resolution';
import { Effect, Match, Option, Schema } from 'effect';

import { symmyStockScopeKey } from './domain/symmy-stock-batch.ts';
import type { SymmyInventorySource, SymmyStockPositionFacts, SymmyStockRows } from './domain/symmy-stock-batch.ts';

/**
 * The public route reads these facts before synchronous admission, under its governed Inventory read authority.
 * Replay uses the already pinned admission instead. A missing item is not a new Position or an enrollment request:
 * the whole batch stays unadmitted until product provisioning has committed.
 */
export const readSymmyStockPositionFacts = Effect.fn('SymmyStock.readPositionFacts')(function* read<Failure>({
  resolve,
  rows,
  source,
}: {
  readonly resolve: (
    request: SourceStockPositionResolutionRequest,
  ) => Effect.Effect<SourceStockPositionResolutionResponse, Failure>;
  readonly rows: SymmyStockRows;
  readonly source: SymmyInventorySource;
}) {
  if (
    rows.some(
      (row) =>
        !source.locations.some(({ locationKey }) => locationKey === row.locationKey) ||
        row.quantity.unitRef.tenantId !== source.policyRef.tenantId ||
        row.quantity.unitRef.resourceId !== source.unitRef.resourceId,
    )
  ) {
    return Option.none<SymmyStockPositionFacts>();
  }
  const unique = new Map(rows.map((row) => [symmyStockScopeKey(row), row]));
  return yield* Effect.forEach(
    unique.values(),
    Effect.fn('SymmyStock.readPositionFact')(function* fact(row) {
      const request = yield* Schema.decodeUnknownEffect(SourceStockPositionResolutionRequestSchema)({
        customerConfigurationId: source.customerConfigurationId,
        externalScope: source.externalScope,
        issuer: source.issuer,
        itemKey: row.itemKey,
        locationKey: row.locationKey,
        namespace: source.namespace,
      });
      const resolution = yield* resolve(request);
      return Match.value(resolution).pipe(
        Match.tag('UNRESOLVED', () => Option.none<SymmyStockPositionFacts[number]>()),
        Match.tag('RESOLVED', (resolved) => {
          const location = source.locations.find(({ locationKey }) => locationKey === row.locationKey);
          return resolved.policyRef.resourceId === source.policyRef.resourceId &&
            [resolved.policyRef, resolved.positionRef, resolved.stockItemRef, resolved.stockLocationRef].every(
              ({ tenantId }) => tenantId === source.policyRef.tenantId,
            ) &&
            resolved.stockLocationRef.resourceId === location?.stockLocationRef.resourceId
            ? Option.some({ request, resolution: resolved })
            : Option.none<SymmyStockPositionFacts[number]>();
        }),
        Match.exhaustive,
      );
    }),
    { concurrency: 1 },
  ).pipe(Effect.map(Option.all));
});

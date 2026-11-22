import {
  SourceStockPositionResolutionApi,
  SourceStockPositionResolutionRequestSchema,
} from '@app/inventory/api/source-stock-position-resolution';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import type { SymmyRouteContextResponseSchema } from '@app/symmy-integration/api/symmy-route-context';
import type { SymmyStockPositionFacts, SymmyStockRows } from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Match, Redacted, Schema } from 'effect';

import {
  SymmyStockDependencyNotReadyProblemSchema,
  SymmyStockInputProblemSchema,
  SymmyStockSourceUnavailableProblemSchema,
} from './contract.ts';
import type { SymmyIngressProblem, symmyUnavailableProblem } from './contract.ts';
import { acquireSymmyReadAssertion, mapSymmyOwnerReadProblem, requireRouteRead } from './source-read-projections.ts';
import type { SymmyIngressAdmission } from './transport.ts';

const sourceUnavailable = (
  reason: typeof SymmyStockSourceUnavailableProblemSchema.Type.reason,
  row: SymmyStockRows[number],
) =>
  SymmyStockSourceUnavailableProblemSchema.make({
    detail: 'Inventory source authority could not be resolved. Check the source policy or retry after owner recovery.',
    itemKey: row.itemKey,
    locationKey: row.locationKey,
    reason,
    retryable: true,
    status: SymmyStockSourceUnavailableProblemSchema.fields.status.literal,
    title: 'Stock source unavailable',
    type: 'https://ontos.dev/problems/symmy-stock-source-unavailable',
  });

const invalidRow = (reason: typeof SymmyStockInputProblemSchema.Type.reason, row: SymmyStockRows[number]) =>
  SymmyStockInputProblemSchema.make({
    detail:
      reason === 'UNIT_NOT_ENROLLED'
        ? 'Use the stock unit enrolled for this integration.'
        : 'Use a location key enrolled for this integration.',
    itemKey: row.itemKey,
    locationKey: row.locationKey,
    reason,
    status: SymmyStockInputProblemSchema.fields.status.literal,
    title: 'Invalid stock row',
    type: 'https://ontos.dev/problems/symmy-stock-input',
  });

/** Fresh stock admission resolves Inventory's current position; replays never enter this reader. */
export const readSymmyStockBatchFacts = Effect.fn('SymmyStockBatch.positionFacts')(function* facts(
  input: {
    readonly admission: SymmyIngressAdmission;
    readonly routeScope: typeof SymmyRouteContextResponseSchema.Type;
    readonly rows: SymmyStockRows;
  },
  newRequestIdentifier: Effect.Effect<string, typeof symmyUnavailableProblem>,
): Effect.fn.Return<SymmyStockPositionFacts, SymmyIngressProblem> {
  const { admission, routeScope, rows } = input;
  yield* requireRouteRead(routeScope, 'commerce.inventory', 'commerce.inventory.api.source-stock-position-resolution');
  const source = routeScope.inventorySource;
  if (source === undefined) {
    return yield* Effect.fail(sourceUnavailable('POLICY_NOT_FOUND', rows[0]));
  }
  if (source.policyRef.tenantId !== routeScope.tenantId) {
    return yield* Effect.fail(sourceUnavailable('TENANT_SCOPE_MISMATCH', rows[0]));
  }
  // Reject caller errors before acquiring owner authority for any row. A foreign tenant is not an input correction.
  for (const row of rows) {
    if (row.quantity.unitRef.tenantId !== source.policyRef.tenantId) {
      return yield* Effect.fail(sourceUnavailable('TENANT_SCOPE_MISMATCH', row));
    }
    if (row.quantity.unitRef.resourceId !== source.unitRef.resourceId) {
      return yield* Effect.fail(invalidRow('UNIT_NOT_ENROLLED', row));
    }
    if (!source.locations.some(({ locationKey }) => locationKey === row.locationKey)) {
      return yield* Effect.fail(invalidRow('LOCATION_NOT_ENROLLED', row));
    }
  }
  const unique = new Map(
    rows.map((row) => [`${row.itemKey.length}:${row.itemKey}${row.locationKey.length}:${row.locationKey}`, row]),
  );
  return yield* Effect.forEach(
    unique.values(),
    Effect.fn('SymmyStockBatch.resolvePosition')(function* resolvePosition(row) {
      const request = yield* Schema.decodeUnknownEffect(SourceStockPositionResolutionRequestSchema)({
        customerConfigurationId: source.customerConfigurationId,
        externalScope: source.externalScope,
        issuer: source.issuer,
        itemKey: row.itemKey,
        locationKey: row.locationKey,
        namespace: source.namespace,
      }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(sourceUnavailable('OWNER_RESOLUTION_MISMATCH', row))));
      // Inventory is tenant-scoped even when Symmy's admitting route also names a company.
      const assertion = yield* acquireSymmyReadAssertion(admission, 'inventory');
      const resolution = yield* makeGovernedEffectBffClient(
        {
          api: SourceStockPositionResolutionApi,
          credential: Redacted.make(`Bearer ${Redacted.value(assertion.assertion)}`),
          defaultApiPrefix: '/inventory-api',
          requestCorrelation: yield* newRequestIdentifier,
        },
        { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
      ).pipe(
        Effect.flatMap((client) => client.sourceStockPositionResolution.execute({ payload: request })),
        Effect.mapError((error) => {
          const problem = mapSymmyOwnerReadProblem(error);
          return problem.status === 503 ? sourceUnavailable('OWNER_UNAVAILABLE', row) : problem;
        }),
      );
      return yield* Match.value(resolution).pipe(
        Match.tag('UNRESOLVED', ({ reason }) => {
          if (reason === 'ITEM_NOT_PROVISIONED' || reason === 'POSITION_NOT_FOUND') {
            return Effect.fail(
              SymmyStockDependencyNotReadyProblemSchema.make({
                detail: 'Wait for product stock provisioning to complete before retrying this row.',
                itemKey: row.itemKey,
                locationKey: row.locationKey,
                reason,
                retryable: true,
                status: SymmyStockDependencyNotReadyProblemSchema.fields.status.literal,
                title: 'Stock dependency not ready',
                type: 'https://ontos.dev/problems/symmy-stock-dependency-not-ready',
              }),
            );
          }
          return Effect.fail(sourceUnavailable(reason, row));
        }),
        Match.tag('RESOLVED', (resolved) => {
          const location = source.locations.find(({ locationKey }) => locationKey === row.locationKey);
          return resolved.policyRef.resourceId === source.policyRef.resourceId &&
            [resolved.policyRef, resolved.positionRef, resolved.stockItemRef, resolved.stockLocationRef].every(
              ({ tenantId }) => tenantId === source.policyRef.tenantId,
            ) &&
            resolved.stockLocationRef.resourceId === location?.stockLocationRef.resourceId
            ? Effect.succeed({ request, resolution: resolved })
            : Effect.fail(sourceUnavailable('OWNER_RESOLUTION_MISMATCH', row));
        }),
        Match.exhaustive,
      );
    }),
    { concurrency: 1 },
  );
});

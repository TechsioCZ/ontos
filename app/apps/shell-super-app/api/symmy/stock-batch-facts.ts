import { SourceStockPositionResolutionApi } from '@app/inventory/api/source-stock-position-resolution';
import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import type { SymmyRouteContextResponseSchema } from '@app/symmy-integration/api/symmy-route-context';
import type { SymmyStockPositionFacts, SymmyStockRows } from '@app/symmy-integration/symmy-internal-contracts';
import { readSymmyStockPositionFacts } from '@app/symmy-integration/symmy-stock-position-facts';
import { Effect, Option, Redacted } from 'effect';

import { symmyUnavailableProblem } from './contract.ts';
import type { SymmyIngressProblem } from './contract.ts';
import { acquireSymmyReadAssertion, mapSymmyOwnerReadProblem, requireRouteRead } from './source-read-projections.ts';
import type { SymmyIngressAdmission } from './transport.ts';

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
  if (source === undefined || source.policyRef.tenantId !== routeScope.tenantId) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const resolved = yield* readSymmyStockPositionFacts({
    resolve: Effect.fn('SymmyStockBatch.resolvePosition')(function* resolvePosition(request) {
      // Inventory is tenant-scoped even when Symmy's admitting route also names a company.
      const assertion = yield* acquireSymmyReadAssertion(admission, 'inventory');
      return yield* makeGovernedEffectBffClient(
        {
          api: SourceStockPositionResolutionApi,
          credential: Redacted.make(`Bearer ${Redacted.value(assertion.assertion)}`),
          defaultApiPrefix: '/inventory-api',
          requestCorrelation: yield* newRequestIdentifier,
        },
        { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
      ).pipe(
        Effect.flatMap((client) => client.sourceStockPositionResolution.execute({ payload: request })),
        Effect.mapError(mapSymmyOwnerReadProblem),
      );
    }),
    rows,
    source,
  }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));
  return yield* Option.match(resolved, {
    onNone: () => Effect.fail(symmyUnavailableProblem),
    onSome: Effect.succeed,
  });
});

import { Effect, Redacted, Schema } from 'effect';

import { DemoOrderExportRequestSchema } from '@app/merchandise/apis/demo-order-export';
import { demoOrderExportOperation } from '@app/merchandise/operation/demo-order-export';
import { executeDemoOrderExportWithAuthorization } from '@app/merchandise/apis/demo-order-export/client';
import { symmyInvalidProblem, symmyUnavailableProblem } from './contract.ts';
import type { SymmyIngressProblem } from './contract.ts';
import type { SymmyIngressAdmission } from './transport.ts';
import {
  acquireSymmyReadAssertion,
  mapSymmyOwnerReadProblem,
  requireRouteCompany,
  requireRouteRead,
} from './source-read-projections.ts';
import type { SymmySourceReadScope } from './source-read-projections.ts';
import {
  SymmyDemoOrdersQuerySchema,
  mapSymmyDemoOrder,
  symmyDemoOrdersResultMatches,
  symmyDemoOrderNotFoundProblem,
} from './demo-orders-contract.ts';
import type { SymmyDemoOrdersQuery } from './demo-orders-contract.ts';

export { demoOrderExportOperation } from '@app/merchandise/operation/demo-order-export';

/** Treat an owner response for another tenant/company or selector as an unavailable read, never as empty data. */
export const validateSymmyDemoOrdersResult = (
  result: Parameters<typeof symmyDemoOrdersResultMatches>[0],
  expected: Parameters<typeof symmyDemoOrdersResultMatches>[1],
): Effect.Effect<void, SymmyIngressProblem> =>
  symmyDemoOrdersResultMatches(result, expected) ? Effect.void : Effect.fail(symmyUnavailableProblem);

/** Both list and detail use the same request-local authenticated, route-enrolled company scope. */
export const readSymmyDemoOrders = Effect.fn('SymmyDemoOrders.read')(function* read(
  scope: SymmySourceReadScope,
  query: SymmyDemoOrdersQuery,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: Effect.Effect<string, typeof symmyUnavailableProblem>,
  orderId?: string,
) {
  yield* requireRouteRead(scope, demoOrderExportOperation.moduleId, demoOrderExportOperation.entrypointKey);
  const legalEntityId = yield* requireRouteCompany(scope);
  const parsed = yield* Schema.decodeUnknownEffect(SymmyDemoOrdersQuerySchema)(query).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)),
  );
  const paging = { limit: parsed.limit ?? 50, offset: parsed.offset ?? 0 };
  const raw = orderId === undefined ? paging : { limit: 1, offset: 0, orderId };
  const payload = yield* Schema.decodeUnknownEffect(DemoOrderExportRequestSchema)(raw).pipe(
    Effect.catchTag('SchemaError', () => Effect.fail(symmyInvalidProblem)),
  );
  const credential = yield* acquireSymmyReadAssertion(admission, demoOrderExportOperation.audience, legalEntityId);
  const result = yield* executeDemoOrderExportWithAuthorization(
    payload,
    Redacted.make(`Bearer ${Redacted.value(credential.assertion)}`),
    yield* newRequestIdentifier,
    { baseUrl: credential.apiBaseUrl, compositionRevision: credential.compositionRevision },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  yield* validateSymmyDemoOrdersResult(result, { ...payload, legalEntityId, tenantId: scope.tenantId });
  return {
    count: result.count,
    limit: payload.limit,
    offset: payload.offset,
    orders: result.orders.map(mapSymmyDemoOrder),
  };
});

export const readSymmyDemoOrder = Effect.fn('SymmyDemoOrders.detail')(function* read(
  scope: SymmySourceReadScope,
  orderId: string,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: Effect.Effect<string, typeof symmyUnavailableProblem>,
) {
  const result = yield* readSymmyDemoOrders(scope, {}, admission, newRequestIdentifier, orderId);
  const [order] = result.orders;
  if (order === undefined) {
    return yield* Effect.fail(symmyDemoOrderNotFoundProblem);
  }
  return { order };
});

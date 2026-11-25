import { executeDemoCatalogRevisionWithAuthorization } from '@app/merchandise/apis/demo-catalog-revision/client';
import { Effect, Redacted } from 'effect';
import { symmyUnavailableProblem } from './contract.ts';
import {
  acquireSymmyReadAssertion,
  mapSymmyOwnerReadProblem,
  requireRouteCompany,
  requireRouteRead,
} from './source-read-projections.ts';
import type { SymmyDemoCatalogContext } from './demo-catalog.ts';

/** Reading the required write fence is part of the route's enrolled catalog-import capability. */
export const readSymmyDemoCatalogRevision = Effect.fn('SymmyDemoCatalog.revision')(function* revision(
  context: Pick<SymmyDemoCatalogContext, 'admission' | 'newRequestIdentifier' | 'scope'>,
) {
  const { admission, newRequestIdentifier, scope } = context;
  yield* requireRouteRead(scope, 'demo.merchandise', 'demo.merchandise.import-source-catalog');
  const company = yield* requireRouteCompany(scope);
  const assertion = yield* acquireSymmyReadAssertion(admission, 'merchandise', company);
  const result = yield* executeDemoCatalogRevisionWithAuthorization(
    {},
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision, requestCache: 'no-store' },
  ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  if (result.tenantId !== scope.tenantId || result.legalEntityId !== company) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  return result;
});

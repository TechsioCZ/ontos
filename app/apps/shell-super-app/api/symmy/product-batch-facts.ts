import { executePriceGroupSourceAssociationsWithAuthorization } from '@app/price-group-catalog/api/client';
import type { SymmyProductPriceGroupFacts, SymmyProductRows } from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Option, Redacted } from 'effect';

import type { symmyUnavailableProblem, SymmyIngressProblem } from './contract.ts';
import {
  acquireSymmyReadAssertion,
  mapSymmyOwnerReadProblem,
  priceGroupCatalogAudience,
  requireRouteRead,
} from './source-read-projections.ts';
import type { SymmySourceReadScope } from './source-read-projections.ts';
import type { SymmyIngressAdmission } from './transport.ts';

type RequestIdentifier = Effect.Effect<string, typeof symmyUnavailableProblem>;

const priceGroupModule = 'pricing.price-group-catalog';

/** The distinct price group codes the products name, in the order they first appear. */
const namedPriceGroupCodes = (products: SymmyProductRows): readonly string[] => [
  ...new Set(
    products.flatMap(({ variants }) =>
      variants.flatMap(({ prices }) => prices.flatMap(({ priceGroupCode }) => priceGroupCode ?? [])),
    ),
  ),
];

export interface ProductBatchFactsInput {
  readonly admission: SymmyIngressAdmission;
  readonly products: SymmyProductRows;
  /** The scope of the products route: the issuer, namespace and source route of the price lists it may name. */
  readonly routeScope: SymmySourceReadScope;
}

/**
 * Resolves each price group code of the products to the price list this route's own source created under that
 * code (its source association with the route's issuer, namespace and source route). A code no such list answers
 * to has no fact, and the price that names it ends unsupported instead of reaching an owner. Naming a code needs
 * the route to enroll the association read (403 without it).
 */
export const readSymmyProductPriceGroupFacts = Effect.fn('SymmyProductBatch.priceGroupFacts')(function* groupFacts(
  input: ProductBatchFactsInput,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<SymmyProductPriceGroupFacts, SymmyIngressProblem> {
  const { admission, products, routeScope } = input;
  const codes = namedPriceGroupCodes(products);
  if (codes.length === 0) {
    return [];
  }
  yield* requireRouteRead(
    routeScope,
    priceGroupModule,
    'pricing.price-group-catalog.api.price-group-source-associations',
  );
  const routeId = routeScope.sourceRouteId ?? routeScope.routeId;
  const facts = yield* Effect.forEach(
    codes.filter((code) => code === code.trim()),
    Effect.fn('SymmyProductBatch.priceGroupFact')(function* readCode(code: string) {
      const assertion = yield* acquireSymmyReadAssertion(admission, priceGroupCatalogAudience);
      const page = yield* executePriceGroupSourceAssociationsWithAuthorization(
        {
          issuer: routeScope.issuerId,
          limit: 2,
          namespace: routeScope.sourceNamespace,
          offset: 0,
          recordKey: code,
          routeId,
        },
        `Bearer ${Redacted.value(assertion.assertion)}`,
        yield* newRequestIdentifier,
        { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
      ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
      const [association] = page.associations;
      return page.count === 1 &&
        page.associations.length === 1 &&
        association !== undefined &&
        association.sourceCorrelation.recordKey === code &&
        association.sourceCorrelation.issuer === routeScope.issuerId &&
        association.sourceCorrelation.namespace === routeScope.sourceNamespace &&
        association.sourceCorrelation.routeId === routeId &&
        association.priceGroupRef.tenantId === routeScope.tenantId
        ? Option.some({ code, priceGroupRef: association.priceGroupRef })
        : Option.none();
    }),
    { concurrency: 1 },
  );
  return facts.flatMap((fact) => (Option.isSome(fact) ? [fact.value] : []));
});

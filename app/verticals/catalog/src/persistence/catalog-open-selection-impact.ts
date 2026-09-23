import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import type {
  CartOpenSelectionPopulationPort,
  CatalogSelectionEvidenceReader,
} from '../../shared/domain/catalog-open-selection-population.ts';
import { openSelectionReferencesProduct } from '../../shared/domain/catalog-open-selection-population.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import { assessCatalogOpenSelectionImpact } from './catalog-selection-open-population.ts';
import { catalogSelectionEvidenceForScope } from './catalog-selection-evidence-service.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export class CatalogOpenSelectionImpactUnavailable extends Schema.TaggedError<CatalogOpenSelectionImpactUnavailable>()(
  'CatalogOpenSelectionImpactUnavailable',
  { code: Schema.Literal('catalog_open_selection_impact_unavailable'), reason: Schema.String },
) {}

const unavailable = (reason: string) =>
  new CatalogOpenSelectionImpactUnavailable({ code: 'catalog_open_selection_impact_unavailable', reason });

/**
 * Catalog has no durable registry of open Cart/checkout selections. A positive path exists only
 * when the Cart owner injects a complete population port and Catalog reads a Current-VALID #479
 * assessment for it. This is a thin action-facing adapter over the one canonical
 * {@link assessCatalogOpenSelectionImpact} engine: an absent or failing owner contract and any
 * affected-but-unproven selection stay a visible typed failure, and an attribute-value write is
 * still blocked by any open selection that references the Product. An absent local row can never
 * attest an empty population or authorize an impact write.
 */
export const catalogOpenSelectionImpactForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  population?: CartOpenSelectionPopulationPort,
  assessOpenSelection?: CatalogSelectionEvidenceReader['assess'],
) => ({
  assess: Effect.fn('CatalogOpenSelectionImpact.assess')(function* assess(productRef: ProductRef) {
    const impacted = yield* assessCatalogOpenSelectionImpact({
      affected: ({ selection }) => openSelectionReferencesProduct(selection, productRef),
      assess:
        assessOpenSelection ?? ((request) => catalogSelectionEvidenceForScope(transaction, scope).assess(request)),
      population,
      purpose: 'CART_VALIDATION',
      tenantId: scope.tenantId,
    }).pipe(
      Effect.catchTag('CartOpenSelectionPopulationUnavailable', (failure) => Effect.fail(unavailable(failure.reason))),
    );
    if (impacted.kind === 'POPULATION_UNAVAILABLE') {
      return yield* unavailable(impacted.reason);
    }
    if (impacted.kind === 'NOT_PROVEN') {
      return yield* unavailable(`An affected open Catalog selection is not Current-VALID: ${impacted.reason}`);
    }
    if (impacted.evidence.length === 0) {
      return yield* Effect.void;
    }
    return yield* unavailable(
      `Product is referenced by ${impacted.evidence.length} open Catalog selection(s): ${impacted.evidence
        .map((decision) => decision.status)
        .join(', ')}`,
    );
  }),
});

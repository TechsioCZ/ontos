import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { Effect } from 'effect';

import type {
  CartOpenSelectionPopulationEvidence,
  CartOpenSelectionPopulationPort,
  CartOpenSelectionPopulationUnavailable,
  CartOpenSelectionReference,
  CatalogSelectionEvidenceReader,
} from '../../shared/domain/catalog-open-selection-population.ts';
import { readCartOpenSelectionPopulation } from '../../shared/domain/catalog-open-selection-population.ts';
import type { CatalogSelectionEvidence } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelectionPurpose } from '../../shared/domain/catalog-selection-purpose.ts';
import { catalogSelectionEvidenceForScope } from './catalog-selection-evidence-service.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export type CatalogOpenSelectionImpact =
  | { readonly evidence: readonly CatalogSelectionEvidence[]; readonly kind: 'PROVEN' }
  | { readonly kind: 'NOT_PROVEN'; readonly reason: string }
  | { readonly kind: 'POPULATION_UNAVAILABLE'; readonly reason: string };

export interface CatalogOpenSelectionSnapshotRequest {
  /** Only Cart open selections Catalog judges to be affected by the change under review. */
  readonly affected?: (reference: CartOpenSelectionReference) => boolean;
  readonly assess: CatalogSelectionEvidenceReader['assess'];
  readonly purpose: CatalogSelectionPurpose;
  readonly snapshot: CartOpenSelectionPopulationEvidence;
}

/**
 * Assess every affected open selection of one already-read Cart population through the #479
 * evidence service. Any non-VALID Catalog decision is `NOT_PROVEN`; only a complete population
 * whose affected selections are all Current-VALID is `PROVEN`. An empty but owner-confirmed
 * population proves only that there is nothing to preserve.
 */
export const assessCatalogOpenSelectionSnapshot = Effect.fn('CatalogSelectionOpenPopulation.assessSnapshot')(
  function* assessOpenSelectionSnapshot(input: CatalogOpenSelectionSnapshotRequest) {
    const { affected, assess, purpose, snapshot } = input;
    const references = snapshot.selections.filter(affected ?? (() => true));
    const decisions = yield* Effect.forEach(
      references,
      (reference) =>
        assess({ purpose, selection: reference.selection }).pipe(
          Effect.map((result) => ({ decision: result.evidence, selectionId: reference.selectionId })),
        ),
      { concurrency: 1 },
    );
    const blocked = decisions.find(({ decision }) => !('status' in decision) || decision.status !== 'VALID');
    if (blocked !== undefined) {
      return {
        kind: 'NOT_PROVEN',
        reason: `An affected open selection has no Current-VALID Catalog evidence (${blocked.selectionId})`,
      } as const;
    }
    return {
      evidence: decisions.flatMap(({ decision }) => ('status' in decision ? [decision] : [])),
      kind: 'PROVEN',
    } as const;
  },
);

export interface CatalogOpenSelectionImpactRequest {
  readonly affected?: (reference: CartOpenSelectionReference) => boolean;
  readonly population?: CartOpenSelectionPopulationPort | undefined;
  readonly purpose: CatalogSelectionPurpose;
  readonly tenantId: string;
}

/**
 * Read the injected Cart owner population, then assess its affected selections. An absent port is
 * `POPULATION_UNAVAILABLE`; a failing owner read propagates as the typed Cart owner error and is
 * never treated as an empty population.
 */
export const assessCatalogOpenSelectionImpact = Effect.fn('CatalogSelectionOpenPopulation.assessImpact')(
  function* assessOpenSelectionImpact(
    input: CatalogOpenSelectionImpactRequest & { readonly assess: CatalogSelectionEvidenceReader['assess'] },
  ): Effect.fn.Return<CatalogOpenSelectionImpact, CartOpenSelectionPopulationUnavailable> {
    if (input.population === undefined) {
      return {
        kind: 'POPULATION_UNAVAILABLE',
        reason: 'Owner-confirmed Cart/checkout open-selection population is unavailable',
      };
    }
    const snapshot = yield* readCartOpenSelectionPopulation(input.population, input.tenantId);
    return yield* assessCatalogOpenSelectionSnapshot({ ...input, snapshot });
  },
);

/** Production binding of the #479 evidence service; the caller supplies only the owner population. */
export const catalogSelectionOpenPopulationImpactForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  population?: CartOpenSelectionPopulationPort,
  assess?: CatalogSelectionEvidenceReader['assess'],
) => ({
  assess: (input: Omit<CatalogOpenSelectionImpactRequest, 'assess' | 'tenantId'>) =>
    assessCatalogOpenSelectionImpact({
      ...input,
      assess: assess ?? ((request) => catalogSelectionEvidenceForScope(transaction, scope).assess(request)),
      population,
      tenantId: scope.tenantId,
    }),
});

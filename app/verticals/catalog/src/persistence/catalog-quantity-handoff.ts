import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { DateTime, Effect } from 'effect';

import type {
  CatalogQuantityHandoff,
  CatalogQuantityHandoffBasisFacts,
} from '../../shared/domain/catalog-quantity-handoff.ts';
import { assembleCatalogQuantityHandoff } from '../../shared/domain/catalog-quantity-handoff.ts';
import type { CatalogSelectionCurrentFacts } from '../../shared/domain/catalog-selection-assessment.ts';
import { assessCatalogSelection } from '../../shared/domain/catalog-selection-assessment.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import type { QuantityNormalization } from '../../shared/domain/purchase-quantity.ts';
import type { CatalogQuantityPreparation } from './catalog-quantity-preparation.ts';
import { catalogQuantityPreparationForScope } from './catalog-quantity-preparation.ts';
import { catalogSelectionCurrentBasisForScope } from './catalog-selection-current-basis.ts';
import { catalogSelectionPackageUnitBasisForScope } from './catalog-selection-package-unit-basis.ts';
import type { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export interface CatalogQuantityHandoffRequest {
  readonly amount: string;
  /** Commerce purpose the Current facts are assessed for; it is not a commercial decision. */
  readonly purpose: string;
  readonly selection: CatalogSelection;
}

interface PackageUnitBasisFailure {
  readonly reason: string;
  readonly status: 'INVALID' | 'INDETERMINATE';
}

type PackageUnitBasisResult =
  | (CatalogQuantityHandoffBasisFacts & { readonly status: 'CURRENT' })
  | PackageUnitBasisFailure;

/**
 * Owner-local reads are injected so the seam can be exercised without a database. A real caller
 * supplies the same scoped readers that other Catalog governed reads use.
 */
export interface CatalogQuantityHandoffReaders {
  readonly prepareQuantity: (input: {
    readonly amount: string;
    readonly selection: CatalogSelection;
  }) => Effect.Effect<CatalogQuantityPreparation, CatalogPersistenceUnavailable>;
  readonly readCurrent: (input: {
    readonly purpose: string;
    readonly selection: CatalogSelection;
  }) => Effect.Effect<CatalogSelectionCurrentFacts, CatalogPersistenceUnavailable>;
  readonly readPackageUnitBasis: (
    selection: CatalogSelection,
    at: Date,
  ) => Effect.Effect<PackageUnitBasisResult, CatalogPersistenceUnavailable>;
}

/** A prepared candidate may only combine with the exact Current basis it was normalized against. */
const matchesPreparedSources = (
  basis: CatalogQuantityHandoffBasisFacts & { readonly status: 'CURRENT' },
  preparation: Extract<CatalogQuantityPreparation, { status: 'PREPARED' }>,
): boolean => {
  const { sources } = preparation;
  const selectedPackage = sources.packageDefinition;
  return (
    basis.productRevision === sources.product.revision &&
    basis.variantRevision === sources.variant.revision &&
    basis.unit.ruleRevision === sources.unitRuleRevision &&
    basis.unit.targetDivisibilityRevision === sources.targetDivisibilityRevision &&
    (selectedPackage === undefined
      ? basis.contentPath.length === 0
      : basis.contentPath[0]?.revision === selectedPackage.revision)
  );
};

const normalizeForHandoff = (preparation: CatalogQuantityPreparation): QuantityNormalization => {
  if (preparation.status === 'PREPARED') {
    return preparation.quantity;
  }
  if (preparation.status === 'INVALID') {
    return { reason: preparation.reason, status: 'INVALID' };
  }
  if (preparation.status === 'STALE') {
    return { reason: preparation.reason, status: 'REPREPARE_REQUIRED' };
  }
  return { reason: preparation.reason, status: 'UNVERIFIABLE' };
};

/** Exact Catalog quantity facts for Commerce #333; customer-specific quantity rules stay outside Catalog. */
export const catalogQuantityHandoffWith = (readers: CatalogQuantityHandoffReaders) => ({
  prepare: Effect.fn('CatalogQuantityHandoff.prepare')(function* prepare(
    input: CatalogQuantityHandoffRequest,
  ): Effect.fn.Return<CatalogQuantityHandoff, CatalogPersistenceUnavailable> {
    const current = yield* readers.readCurrent({ purpose: input.purpose, selection: input.selection });
    const evidence = assessCatalogSelection({
      assessedAt: current.assessedAt,
      current,
      purpose: input.purpose,
      selection: input.selection,
    });
    if (evidence.status !== 'VALID') {
      return evidence.status === 'INVALID'
        ? { reason: evidence.reason, status: 'INVALID' }
        : { reason: evidence.reason, status: 'UNVERIFIABLE' };
    }
    const at = DateTime.toDateUtc(DateTime.makeUnsafe(current.assessedAt));
    const basis = yield* readers.readPackageUnitBasis(input.selection, at);
    if (basis.status !== 'CURRENT') {
      return basis.status === 'INVALID'
        ? { reason: basis.reason, status: 'INVALID' }
        : { reason: basis.reason, status: 'UNVERIFIABLE' };
    }
    const preparation = yield* readers.prepareQuantity({ amount: input.amount, selection: input.selection });
    if (preparation.status === 'PREPARED' && !matchesPreparedSources(basis, preparation)) {
      return { reason: 'Prepared Quantity sources do not match the exact Current basis', status: 'STALE' };
    }
    return assembleCatalogQuantityHandoff({
      basis,
      current,
      quantity: normalizeForHandoff(preparation),
      selection: input.selection,
    });
  }),
});

/** Core supplies one tenant-scoped transaction; this never resolves a commercial verdict. */
export const catalogQuantityHandoffForScope = (transaction: ScopedTransaction, scope: OperationalScope) =>
  catalogQuantityHandoffWith({
    prepareQuantity: (input) =>
      catalogQuantityPreparationForScope(transaction, scope).prepare({ ...input, phase: 'PREPARE' }),
    readCurrent: (input) => catalogSelectionCurrentBasisForScope(transaction, scope).read(input),
    readPackageUnitBasis: (selection, at) =>
      catalogSelectionPackageUnitBasisForScope(transaction, scope).read(selection, at),
  });

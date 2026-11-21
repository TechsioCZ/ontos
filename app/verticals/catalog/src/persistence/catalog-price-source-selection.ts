import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Option, Schema } from 'effect';

import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import { CatalogSelectionEvidenceSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelectionOwnerAssessmentResult } from '../../shared/domain/catalog-selection-owner-contract.ts';
import type { CatalogPriceSourceSelectionPurpose } from '../../shared/domain/catalog-selection-purpose.ts';
import { productVariants, products } from '../database/schema.ts';
import type { CatalogSelectionEvidenceServiceResult } from './catalog-selection-evidence-service.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type EvidenceInput = typeof CatalogSelectionEvidenceSchema.Encoded;
type Decision =
  | Pick<Extract<EvidenceInput, { readonly status: 'INVALID' }>, 'basis' | 'reason' | 'status'>
  | Pick<Extract<EvidenceInput, { readonly status: 'VALID' }>, 'basis' | 'membership' | 'status'>;

const purpose: CatalogPriceSourceSelectionPurpose = 'PRICE_SOURCE_ASSERTION';
const catalogModuleId = 'commerce.catalog';

/** The Current rows of the named Product and Variant in the trusted Tenant; a row the Tenant does not hold is absent. */
export interface CatalogPriceSourceSelectionRows {
  readonly product?: { readonly lifecycleState: string; readonly revision: number } | undefined;
  readonly variant?:
    | { readonly lifecycleState: string; readonly productId: string; readonly revision: number }
    | undefined;
}

const pricedProductLifecycles: ReadonlySet<string> = new Set(['ACTIVE', 'DRAFT']);
const pricedVariantLifecycles: ReadonlySet<string> = new Set(['ACTIVE', 'WORK_IN_PROGRESS']);

const namesCatalogRef = (
  ref: CatalogSelection['productRef'] | CatalogSelection['variantRef'],
  resourceType: string,
  tenantId: string,
): boolean => ref.moduleId === catalogModuleId && ref.resourceType === resourceType && ref.tenantId === tenantId;

/**
 * Whether a Price an external source asserts may name this selection: the exact Variant of the exact Product, both
 * held by the trusted Tenant and neither retired. A DRAFT Product and a WORK_IN_PROGRESS Variant are accepted, since a
 * source prices what it imports before anyone activates it; readiness for sale stays the PRICING question. A
 * selection that pins a package, set or configuration is not this question and is refused.
 */
export const assessCatalogPriceSourceSelection = (input: {
  readonly assessedAt: string;
  readonly attestationId: string;
  readonly rows: CatalogPriceSourceSelectionRows;
  readonly selection: CatalogSelection;
  readonly tenantId: string;
}): CatalogSelectionOwnerAssessmentResult => {
  const { assessedAt, attestationId, rows, selection, tenantId } = input;
  const { product, variant } = rows;
  const basis: Decision['basis'] = [
    ...(product === undefined
      ? []
      : [{ role: 'PRODUCT' as const, source: { resourceRef: selection.productRef, revision: product.revision } }]),
    ...(variant === undefined
      ? []
      : [{ role: 'VARIANT' as const, source: { resourceRef: selection.variantRef, revision: variant.revision } }]),
  ];
  const decided = (decision: Decision): CatalogSelectionOwnerAssessmentResult =>
    Option.getOrElse(
      Schema.decodeUnknownOption(CatalogSelectionEvidenceSchema)({ ...decision, assessedAt, purpose, selection }),
      () => ({ kind: 'UNAVAILABLE', reason: 'Catalog price source answer could not be verified' }) as const,
    );
  const invalid = (reason: string) => decided({ basis, reason, status: 'INVALID' });
  if (
    !namesCatalogRef(selection.productRef, 'commerce.catalog.product', tenantId) ||
    !namesCatalogRef(selection.variantRef, 'commerce.catalog.variant', tenantId)
  ) {
    return invalid('A price source names a Product and Variant of another Tenant or owner');
  }
  if (
    selection.configuration !== undefined ||
    selection.packageOption !== undefined ||
    selection.setComposition !== undefined
  ) {
    return invalid('A price source names only an exact Product and Variant');
  }
  if (product === undefined || variant === undefined) {
    return { kind: 'NOT_FOUND', requested: selection };
  }
  if (variant.productId !== selection.productRef.resourceId) {
    return invalid('Variant belongs to another Product');
  }
  if (product.lifecycleState === 'RETIRED' || variant.lifecycleState === 'RETIRED') {
    return invalid('Selected Product or Variant is retired');
  }
  if (!pricedProductLifecycles.has(product.lifecycleState) || !pricedVariantLifecycles.has(variant.lifecycleState)) {
    return invalid('Selected Product or Variant has no lifecycle a source may price');
  }
  return decided({
    basis,
    membership: {
      attestationId,
      observedAt: assessedAt,
      productRef: selection.productRef,
      source: 'CATALOG_OWNER_CURRENT_READ',
      variant: { resourceRef: selection.variantRef, revision: variant.revision },
    },
    status: 'VALID',
  });
};

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog Current basis is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

/** The price source answer from the owner's own Current rows, inside the one tenant-scoped transaction of the Read. */
export const catalogPriceSourceSelectionForScope = (transaction: ScopedTransaction, scope: OperationalScope) => {
  const readVariant = (variantId: string) =>
    transaction
      .select({
        lifecycleState: productVariants.lifecycleState,
        productId: productVariants.productId,
        revision: productVariants.currentRevision,
      })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, scope.tenantId), eq(productVariants.variantId, variantId)))
      .limit(1)
      .pipe(
        Effect.map(([row]) => row),
        Effect.mapError(unavailable),
      );
  return {
    assess: Effect.fn('CatalogPriceSourceSelection.assess')(function* assess(
      selection: CatalogSelection,
    ): Effect.fn.Return<CatalogSelectionEvidenceServiceResult, never, Crypto.Crypto> {
      const assessedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* Effect.gen(function* readCurrentRows() {
        const [product] = yield* transaction
          .select({ lifecycleState: products.lifecycleState, revision: products.currentRevision })
          .from(products)
          .where(and(eq(products.tenantId, scope.tenantId), eq(products.productId, selection.productRef.resourceId)))
          .limit(1)
          .pipe(Effect.mapError(unavailable));
        // A Product the Tenant does not hold has no Variant to read: the answer is NOT_FOUND either way.
        const variant = product === undefined ? undefined : yield* readVariant(selection.variantRef.resourceId);
        const attestationId = yield* (yield* Crypto.Crypto).randomUUIDv4().pipe(Effect.mapError(unavailable));
        return {
          evidence: assessCatalogPriceSourceSelection({
            assessedAt,
            attestationId,
            rows: { product, variant },
            selection,
            tenantId: scope.tenantId,
          }),
          missingRoles: [],
        };
      }).pipe(
        Effect.catchTag('CatalogPersistenceUnavailable', () =>
          Effect.succeed<CatalogSelectionEvidenceServiceResult>({
            evidence: { kind: 'UNAVAILABLE', reason: 'Catalog Current basis is temporarily unavailable' },
            missingRoles: [],
          }),
        ),
      );
    }),
  };
};

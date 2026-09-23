import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, isNull } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { CatalogMediaAssignmentSchema, selectCatalogMediaSet } from '../../shared/domain/catalog-media-assignment.ts';
import type { CatalogMediaAssignment, CatalogMediaSet } from '../../shared/domain/catalog-media-assignment.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import { catalogMediaAssignments, catalogMediaAssignmentSets, productVariants, products } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Target = ProductRef | VariantRef;
type SetRow = typeof catalogMediaAssignmentSets.$inferSelect;
type AssignmentRow = typeof catalogMediaAssignments.$inferSelect;

interface CatalogMediaReadResult extends CatalogMediaSet {
  /** Revision of the selected owner set, or zero when no set exists. */
  readonly setRevision: number;
}

export interface CatalogMediaReads {
  readonly current: (
    target: Target,
  ) => Effect.Effect<Option.Option<CatalogMediaReadResult>, CatalogPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog media read is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision > 0;
const CATALOG_MODULE = 'commerce.catalog';
const PRODUCT_RESOURCE = 'commerce.catalog.product';
const VARIANT_RESOURCE = 'commerce.catalog.variant';
const validTarget = (target: Target, tenantId: string) =>
  target.tenantId === tenantId &&
  target.moduleId === CATALOG_MODULE &&
  (target.resourceType === PRODUCT_RESOURCE || target.resourceType === VARIANT_RESOURCE) &&
  target.resourceId.length > 0;

const decodeAssignments = Effect.fn('CatalogMediaReads.decodeAssignments')(function* decodeAssignments(
  rows: readonly AssignmentRow[],
  set: SetRow,
  target: Target,
): Effect.fn.Return<readonly CatalogMediaAssignment[], CatalogPersistenceUnavailable> {
  const active = rows.filter((row) => row.state === 'ACTIVE' && row.resourceKind === 'MEDIA');
  if (
    rows.some(
      (row) =>
        row.tenantId !== set.tenantId ||
        row.assignmentSetId !== set.assignmentSetId ||
        (row.state !== 'ACTIVE' && row.state !== 'REMOVED') ||
        (row.resourceKind !== 'MEDIA' && row.resourceKind !== 'DOCUMENT'),
    )
  ) {
    return yield* unavailable();
  }
  const ordered = active.toSorted((a, b) => a.position - b.position);
  if (ordered.some((row, index) => row.position !== index + 1)) {
    return yield* unavailable();
  }
  return yield* Effect.forEach(
    ordered,
    (row) =>
      Schema.decodeEffect(CatalogMediaAssignmentSchema)({
        assignmentId: row.assignmentId,
        assignmentRevision: row.currentRevision,
        order: row.position,
        purpose: row.purpose,
        resourceRef: {
          moduleId: row.ownerModuleId,
          resourceId: row.ownerResourceId,
          resourceType: row.ownerResourceType,
          tenantId: row.ownerTenantId,
        },
        target,
      }).pipe(Effect.mapError(unavailable)),
    { concurrency: 1 },
  );
});

/** Private owner service; Core supplies the verified tenant-scoped read transaction. */
export const catalogMediaReadsForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): CatalogMediaReads => {
  const { tenantId } = scope;
  const readSet = (productId: string, variantId: string | null) =>
    transaction
      .select()
      .from(catalogMediaAssignmentSets)
      .where(
        and(
          eq(catalogMediaAssignmentSets.tenantId, tenantId),
          eq(catalogMediaAssignmentSets.productId, productId),
          variantId === null
            ? isNull(catalogMediaAssignmentSets.variantId)
            : eq(catalogMediaAssignmentSets.variantId, variantId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
  const readAssignments = (set: SetRow) =>
    transaction
      .select()
      .from(catalogMediaAssignments)
      .where(
        and(
          eq(catalogMediaAssignments.tenantId, tenantId),
          eq(catalogMediaAssignments.assignmentSetId, set.assignmentSetId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
  const readValidated = Effect.fn('CatalogMediaReads.readValidated')(function* readValidated(
    productId: string,
    variantId: string | null,
  ) {
    const sets = yield* readSet(productId, variantId);
    if (sets.length > 1) {
      return yield* unavailable();
    }
    const [set] = sets;
    if (set === undefined) {
      return { assignments: [], revision: 0 };
    }
    if (
      set.tenantId !== tenantId ||
      set.productId !== productId ||
      set.variantId !== variantId ||
      !validRevision(set.currentRevision)
    ) {
      return yield* unavailable();
    }
    // SAFETY: The subject ID is read from a Tenant-scoped Product or Variant row.
    const target =
      variantId === null
        ? ({
            moduleId: CATALOG_MODULE,
            resourceId: productId,
            resourceType: PRODUCT_RESOURCE,
            tenantId,
          } as ProductRef)
        : ({
            moduleId: CATALOG_MODULE,
            resourceId: variantId,
            resourceType: VARIANT_RESOURCE,
            tenantId,
          } as VariantRef);
    const assignments = yield* decodeAssignments(yield* readAssignments(set), set, target);
    return { assignments, revision: set.currentRevision };
  });
  const current: CatalogMediaReads['current'] = Effect.fn('CatalogMediaReads.current')(function* current(target) {
    if (!validTarget(target, tenantId)) {
      return yield* unavailable();
    }
    const isVariant = target.resourceType === VARIANT_RESOURCE;
    const subjects = isVariant
      ? yield* transaction
          .select({ productId: productVariants.productId })
          .from(productVariants)
          .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.variantId, target.resourceId)))
          .pipe(Effect.mapError(unavailable))
      : yield* transaction
          .select({ productId: products.productId })
          .from(products)
          .where(and(eq(products.tenantId, tenantId), eq(products.productId, target.resourceId)))
          .pipe(Effect.mapError(unavailable));
    if (subjects.length > 1) {
      return yield* unavailable();
    }
    const [subject] = subjects;
    if (subject === undefined) {
      return Option.none();
    }
    const { productId } = subject;
    if (productId.length === 0) {
      return yield* unavailable();
    }
    const product = yield* readValidated(productId, null);
    const variant = isVariant ? yield* readValidated(productId, target.resourceId) : undefined;
    const selected = selectCatalogMediaSet(product.assignments, variant?.assignments);
    return Option.some({
      ...selected,
      setRevision: selected.source === 'VARIANT' ? (variant?.revision ?? 0) : product.revision,
    });
  });
  return { current };
};

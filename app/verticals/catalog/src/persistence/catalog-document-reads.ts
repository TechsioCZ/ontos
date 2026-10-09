import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq, isNull } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import {
  CatalogMediaAssignmentSchema,
  evaluateCatalogCurrentUse,
  sameCatalogDocumentResourceRef,
} from '../../shared/domain/catalog-media-assignment.ts';
import type { CatalogCurrentUse, CatalogDocumentAvailability } from '../../shared/domain/catalog-media-assignment.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import type { VariantRef } from '../../shared/resources/variant.ts';
import { catalogMediaAssignments, catalogMediaAssignmentSets, productVariants, products } from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type Target = ProductRef | VariantRef;
type SetRow = typeof catalogMediaAssignmentSets.$inferSelect;
type AssignmentRow = typeof catalogMediaAssignments.$inferSelect;

interface CatalogDocumentReadResult {
  readonly assignments: readonly CatalogCurrentUse[];
  /** Exact Catalog assignment-set revision; no Documents Centre version is implied. */
  readonly setRevision: number;
}

export interface CatalogDocumentReads {
  /**
   * `ownerAvailability` is Documents Center evidence for exact Resources. When omitted or absent for
   * an assignment, the projection stays OWNER_CHECK_REQUIRED and never resolves Current or access.
   */
  readonly current: (
    target: Target,
    ownerAvailability?: readonly CatalogDocumentAvailability[],
  ) => Effect.Effect<Option.Option<CatalogDocumentReadResult>, CatalogPersistenceUnavailable>;
}

const unavailable = (cause?: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog document read is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const CATALOG_MODULE = 'commerce.catalog';
const PRODUCT_RESOURCE = 'commerce.catalog.product';
const VARIANT_RESOURCE = 'commerce.catalog.variant';
const validTarget = (target: Target, tenantId: string) =>
  target.tenantId === tenantId &&
  target.moduleId === CATALOG_MODULE &&
  (target.resourceType === PRODUCT_RESOURCE || target.resourceType === VARIANT_RESOURCE) &&
  target.resourceId.length > 0;

const decodeAssignments = Effect.fn('CatalogDocumentReads.decodeAssignments')(function* decodeAssignments(
  rows: readonly AssignmentRow[],
  set: SetRow,
  target: Target,
  ownerAvailability: readonly CatalogDocumentAvailability[],
) {
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
  const active = rows
    .filter((row) => row.state === 'ACTIVE' && row.resourceKind === 'DOCUMENT')
    .toSorted((left, right) => left.position - right.position);
  if (active.some((row, index) => row.position !== index + 1)) {
    return yield* unavailable();
  }
  return yield* Effect.forEach(
    active,
    (row) => {
      const resourceRef = {
        moduleId: row.ownerModuleId,
        resourceId: row.ownerResourceId,
        resourceType: row.ownerResourceType,
        tenantId: row.ownerTenantId,
      };
      // Evidence is matched by full owner identity; an unmatched Resource never substitutes.
      const evidence = ownerAvailability.find((candidate) =>
        sameCatalogDocumentResourceRef(candidate.resourceRef, resourceRef),
      );
      return Schema.decodeEffect(CatalogMediaAssignmentSchema)({
        assignmentId: row.assignmentId,
        assignmentRevision: row.currentRevision,
        order: row.position,
        purpose: row.purpose,
        resourceRef,
        target,
      }).pipe(
        Effect.map((assignment) => evaluateCatalogCurrentUse(assignment, evidence)),
        Effect.mapError(unavailable),
      );
    },
    { concurrency: 1 },
  );
});

/** Private owner-local read. This never resolves Documents Centre Current or access. */
export const catalogDocumentReadsForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): CatalogDocumentReads => {
  const { tenantId } = scope;
  const current: CatalogDocumentReads['current'] = Effect.fn('CatalogDocumentReads.current')(function* current(
    target,
    ownerAvailability = [],
  ) {
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
    const sets = yield* transaction
      .select()
      .from(catalogMediaAssignmentSets)
      .where(
        and(
          eq(catalogMediaAssignmentSets.tenantId, tenantId),
          eq(catalogMediaAssignmentSets.productId, productId),
          isVariant
            ? eq(catalogMediaAssignmentSets.variantId, target.resourceId)
            : isNull(catalogMediaAssignmentSets.variantId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    if (sets.length > 1) {
      return yield* unavailable();
    }
    const [set] = sets;
    if (set === undefined) {
      return Option.some({ assignments: [], setRevision: 0 });
    }
    if (
      set.tenantId !== tenantId ||
      set.productId !== productId ||
      set.variantId !== (isVariant ? target.resourceId : null) ||
      !Number.isSafeInteger(set.currentRevision) ||
      set.currentRevision < 1
    ) {
      return yield* unavailable();
    }
    const rows = yield* transaction
      .select()
      .from(catalogMediaAssignments)
      .where(
        and(
          eq(catalogMediaAssignments.tenantId, tenantId),
          eq(catalogMediaAssignments.assignmentSetId, set.assignmentSetId),
        ),
      )
      .pipe(Effect.mapError(unavailable));
    return Option.some({
      assignments: yield* decodeAssignments(rows, set, target, ownerAvailability),
      setRevision: set.currentRevision,
    });
  });
  return { current };
};

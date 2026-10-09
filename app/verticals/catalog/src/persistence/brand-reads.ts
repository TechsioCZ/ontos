import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import type { BrandRef } from '../../shared/resources/brand.ts';
import { BrandRefSchema } from '../../shared/resources/brand.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import {
  brandRevisions,
  brands,
  productBrandAssignmentRevisions,
  productBrandAssignments,
  products,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type BrandRevisionRow = typeof brandRevisions.$inferSelect;
type AssignmentRevisionRow = typeof productBrandAssignmentRevisions.$inferSelect;

interface BrandRevisionRead {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly brandRef: BrandRef;
  readonly changeKind: 'CREATED' | 'RENAMED' | 'RETIRED' | 'REACTIVATED';
  readonly evidenceRefs: readonly string[];
  readonly lifecycleState: 'ACTIVE' | 'RETIRED';
  readonly name: string;
  readonly reason: string;
  readonly recordedAt: Date;
  readonly revision: number;
}

interface BrandCurrentRead extends BrandRevisionRead {
  readonly assignable: boolean;
}

type ProductBrandClaim =
  | { readonly brandRef: BrandRef; readonly kind: 'brand' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'confirmed_unbranded' };

interface ProductBrandRevisionRead {
  readonly actingPrincipalId: string;
  readonly actionInvocationId: string;
  readonly assignment: ProductBrandClaim;
  readonly evidenceRef: string | null;
  readonly productRef: ProductRef;
  readonly reason: string;
  readonly recordedAt: Date;
  readonly revision: number;
}

interface ProductBrandCurrentRead {
  readonly assignment: ProductBrandClaim;
  readonly productRef: ProductRef;
  readonly revision: number;
}

export interface BrandReads {
  readonly current: (ref: BrandRef) => Effect.Effect<Option.Option<BrandCurrentRead>, CatalogPersistenceUnavailable>;
  readonly history: (ref: BrandRef) => Effect.Effect<readonly BrandRevisionRead[], CatalogPersistenceUnavailable>;
  readonly productCurrent: (
    ref: ProductRef,
  ) => Effect.Effect<Option.Option<ProductBrandCurrentRead>, CatalogPersistenceUnavailable>;
  readonly productHistory: (
    ref: ProductRef,
  ) => Effect.Effect<readonly ProductBrandRevisionRead[], CatalogPersistenceUnavailable>;
  readonly productRevision: (
    ref: ProductRef,
    revision: number,
  ) => Effect.Effect<Option.Option<ProductBrandRevisionRead>, CatalogPersistenceUnavailable>;
  readonly revision: (
    ref: BrandRef,
    revision: number,
  ) => Effect.Effect<Option.Option<BrandRevisionRead>, CatalogPersistenceUnavailable>;
}

const unavailable = (cause?: unknown) => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog Brand read is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const brandRef = (tenantId: string, resourceId: string): BrandRef => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: 'commerce.catalog.brand',
  tenantId,
});
const productRef = (tenantId: string, resourceId: string): ProductRef => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: 'commerce.catalog.product',
  tenantId,
});
const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision > 0;
const validText = (value: string, max: number) => value.length > 0 && value.length <= max && value.trim() === value;
const validDate = (value: Date) => Option.isSome(DateTime.make(value));
const validId = (value: string) => Schema.is(Schema.String.check(Schema.isUUID()))(value);
const lifecycleSchema = Schema.Literals(['ACTIVE', 'RETIRED']);
const changeKindSchema = Schema.Literals(['CREATED', 'RENAMED', 'RETIRED', 'REACTIVATED']);

const decodeBrand = (row: BrandRevisionRow, tenantId: string, id: string) => {
  const { changeKind, lifecycleState } = row;
  if (
    row.tenantId !== tenantId ||
    row.brandId !== id ||
    !validRevision(row.revision) ||
    !validText(row.name, 240) ||
    !validText(row.reason, 1000) ||
    !validDate(row.recordedAt) ||
    !validId(row.actionInvocationId) ||
    !validId(row.actingPrincipalId) ||
    !Array.isArray(row.evidenceRefs) ||
    row.evidenceRefs.length === 0 ||
    row.evidenceRefs.some((value) => !validText(value, 300)) ||
    !Schema.is(lifecycleSchema)(lifecycleState) ||
    !Schema.is(changeKindSchema)(changeKind)
  ) {
    return null;
  }
  return {
    actingPrincipalId: row.actingPrincipalId,
    actionInvocationId: row.actionInvocationId,
    brandRef: brandRef(tenantId, id),
    changeKind,
    evidenceRefs: row.evidenceRefs,
    lifecycleState,
    name: row.name,
    reason: row.reason,
    recordedAt: row.recordedAt,
    revision: row.revision,
  } satisfies BrandRevisionRead;
};

const decodeAssignment = (row: AssignmentRevisionRow, tenantId: string, id: string) => {
  if (
    row.tenantId !== tenantId ||
    row.productId !== id ||
    !validRevision(row.revision) ||
    !validText(row.reason, 1000) ||
    !validDate(row.recordedAt) ||
    !validId(row.actionInvocationId) ||
    !validId(row.actingPrincipalId)
  ) {
    return null;
  }
  let assignment: ProductBrandClaim;
  if (
    row.claimKind === 'BRANDED' &&
    row.brandId !== null &&
    validId(row.brandId) &&
    row.evidenceRef !== null &&
    validText(row.evidenceRef, 1000)
  ) {
    assignment = { brandRef: brandRef(tenantId, row.brandId), kind: 'brand' };
  } else if (
    row.claimKind === 'CONFIRMED_UNBRANDED' &&
    row.brandId === null &&
    row.evidenceRef !== null &&
    validText(row.evidenceRef, 1000)
  ) {
    assignment = { kind: 'confirmed_unbranded' };
  } else if (row.claimKind === 'UNKNOWN' && row.brandId === null && row.evidenceRef === null) {
    assignment = { kind: 'unknown' };
  } else {
    return null;
  }
  return {
    actingPrincipalId: row.actingPrincipalId,
    actionInvocationId: row.actionInvocationId,
    assignment,
    evidenceRef: row.evidenceRef,
    productRef: productRef(tenantId, id),
    reason: row.reason,
    recordedAt: row.recordedAt,
    revision: row.revision,
  } satisfies ProductBrandRevisionRead;
};

const ordered = <T extends { readonly revision: number }>(rows: readonly T[], expected?: number) => {
  const result = rows.toSorted((a, b) => a.revision - b.revision);
  if (expected !== undefined && result.length !== expected) {
    return null;
  }
  return result.every((row, index) => row.revision === index + 1) ? result : null;
};

const assignmentMatchesHead = (
  head: typeof productBrandAssignments.$inferSelect,
  latest: ProductBrandRevisionRead,
  tenantId: string,
  productId: string,
) =>
  head.tenantId === tenantId &&
  head.productId === productId &&
  head.currentRevision === latest.revision &&
  head.evidenceRef === latest.evidenceRef &&
  ((latest.assignment.kind === 'brand' &&
    head.claimKind === 'BRANDED' &&
    head.brandId === latest.assignment.brandRef.resourceId) ||
    (latest.assignment.kind === 'unknown' && head.claimKind === 'UNKNOWN' && head.brandId === null) ||
    (latest.assignment.kind === 'confirmed_unbranded' &&
      head.claimKind === 'CONFIRMED_UNBRANDED' &&
      head.brandId === null));

/** Runs only inside Core's verified, tenant-scoped read transaction. */
export const brandReadsForScope = (transaction: ScopedTransaction, scope: OperationalScope): BrandReads => {
  const { tenantId } = scope;
  const validBrandRef = (ref: BrandRef) => Schema.is(BrandRefSchema)(ref) && ref.tenantId === tenantId;
  const validProductRef = (ref: ProductRef) => Schema.is(ProductRefSchema)(ref) && ref.tenantId === tenantId;
  const brandRows = (id: string) =>
    transaction
      .select()
      .from(brandRevisions)
      .where(and(eq(brandRevisions.tenantId, tenantId), eq(brandRevisions.brandId, id)))
      .pipe(Effect.mapError(unavailable));
  const assignmentRows = (id: string) =>
    transaction
      .select()
      .from(productBrandAssignmentRevisions)
      .where(
        and(eq(productBrandAssignmentRevisions.tenantId, tenantId), eq(productBrandAssignmentRevisions.productId, id)),
      )
      .pipe(Effect.mapError(unavailable));
  const brandHistory = Effect.fn('BrandReads.history')(function* brandHistory(ref: BrandRef) {
    if (!validBrandRef(ref)) {
      return yield* unavailable();
    }
    const rows = yield* brandRows(ref.resourceId);
    const decoded: BrandRevisionRead[] = [];
    for (const row of rows) {
      const value = decodeBrand(row, tenantId, ref.resourceId);
      if (value === null) {
        return yield* unavailable();
      }
      decoded.push(value);
    }
    const history = ordered(decoded);
    if (
      history === null ||
      history.some(
        (row, index) =>
          (index === 0 && (row.changeKind !== 'CREATED' || row.lifecycleState !== 'ACTIVE')) ||
          (index > 0 && row.changeKind === 'CREATED') ||
          (row.changeKind === 'RETIRED' && row.lifecycleState !== 'RETIRED') ||
          (row.changeKind === 'REACTIVATED' && row.lifecycleState !== 'ACTIVE'),
      )
    ) {
      return yield* unavailable();
    }
    return history;
  });
  const productHistory = Effect.fn('BrandReads.productHistory')(function* productHistory(ref: ProductRef) {
    if (!validProductRef(ref)) {
      return yield* unavailable();
    }
    const rows = yield* assignmentRows(ref.resourceId);
    const decoded: ProductBrandRevisionRead[] = [];
    for (const row of rows) {
      const value = decodeAssignment(row, tenantId, ref.resourceId);
      if (value === null) {
        return yield* unavailable();
      }
      decoded.push(value);
    }
    const history = ordered(decoded);
    if (history === null) {
      return yield* unavailable();
    }
    return history;
  });
  return {
    current: Effect.fn('BrandReads.current')(function* current(ref) {
      if (!validBrandRef(ref)) {
        return yield* unavailable();
      }
      const [head] = yield* transaction
        .select()
        .from(brands)
        .where(and(eq(brands.tenantId, tenantId), eq(brands.brandId, ref.resourceId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (head === undefined) {
        if ((yield* brandHistory(ref)).length > 0) {
          return yield* unavailable();
        }
        return Option.none();
      }
      const history = yield* brandHistory(ref);
      const latest = history.at(-1);
      if (
        latest === undefined ||
        head.tenantId !== tenantId ||
        head.brandId !== ref.resourceId ||
        head.currentRevision !== latest.revision ||
        head.name !== latest.name ||
        head.lifecycleState !== latest.lifecycleState
      ) {
        return yield* unavailable();
      }
      return Option.some({ ...latest, assignable: latest.lifecycleState === 'ACTIVE' });
    }),
    history: brandHistory,
    productCurrent: Effect.fn('BrandReads.productCurrent')(function* productCurrent(ref) {
      if (!validProductRef(ref)) {
        return yield* unavailable();
      }
      const [product] = yield* transaction
        .select()
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, ref.resourceId)))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (product === undefined) {
        return Option.none();
      }
      if (product.tenantId !== tenantId || product.productId !== ref.resourceId) {
        return yield* unavailable();
      }
      const [heads, history] = yield* Effect.all(
        [
          transaction
            .select()
            .from(productBrandAssignments)
            .where(
              and(
                eq(productBrandAssignments.tenantId, tenantId),
                eq(productBrandAssignments.productId, ref.resourceId),
              ),
            )
            .limit(1)
            .pipe(Effect.mapError(unavailable)),
          productHistory(ref),
        ],
        { concurrency: 2 },
      );
      const [head] = heads;
      if (head === undefined) {
        if (history.length > 0) {
          return yield* unavailable();
        }
        return Option.some({ assignment: { kind: 'unknown' }, productRef: ref, revision: 0 });
      }
      const latest = history.at(-1);
      if (latest === undefined || !assignmentMatchesHead(head, latest, tenantId, ref.resourceId)) {
        return yield* unavailable();
      }
      return Option.some({ assignment: latest.assignment, productRef: ref, revision: latest.revision });
    }),
    productHistory,
    productRevision: Effect.fn('BrandReads.productRevision')(function* productRevision(ref, number) {
      if (!validRevision(number)) {
        return yield* unavailable();
      }
      const history = yield* productHistory(ref);
      const found = history[number - 1];
      return found === undefined ? Option.none() : Option.some(found);
    }),
    revision: Effect.fn('BrandReads.revision')(function* revision(ref, number) {
      if (!validRevision(number)) {
        return yield* unavailable();
      }
      const history = yield* brandHistory(ref);
      const found = history[number - 1];
      return found === undefined ? Option.none() : Option.some(found);
    }),
  };
};

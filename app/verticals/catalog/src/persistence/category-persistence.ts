import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Schema } from 'effect';

import { CategoryValidSchema, validateCategoryMove } from '../../shared/domain/category-hierarchy.ts';
import {
  productCategories,
  productCategoryAssignments,
  productCategoryEvents,
  productCategoryHierarchyRevisions,
  products,
} from '../database/schema.ts';

import { ProductCategoryRefSchema } from '../../shared/resources/product-category.ts';
import type { ProductCategoryRef } from '../../shared/resources/product-category.ts';
import { ProductRefSchema } from '../../shared/resources/product.ts';
import type { ProductRef } from '../../shared/resources/product.ts';

export class CategoryPersistenceUnavailable extends Schema.TaggedError<CategoryPersistenceUnavailable>()(
  'CategoryPersistenceUnavailable',
  { code: Schema.Literal('category_persistence_unavailable'), reason: Schema.String },
) {}

interface CategoryRecord {
  readonly categoryRef: ProductCategoryRef;
  readonly lifecycle: 'ACTIVE' | 'RETIRED';
  readonly name: string;
  readonly parentRef?: ProductCategoryRef;
  readonly revision: number;
}

interface MutationBase {
  readonly actionInvocationId: string;
  readonly principalId: string;
  readonly reason: string;
  readonly tenantId: string;
}

export interface CreateCategoryInput extends MutationBase {
  readonly categoryId: string;
  readonly name: string;
  readonly parentCategoryId?: string;
}

export interface RenameCategoryInput extends MutationBase {
  readonly categoryId: string;
  readonly expectedRevision: number;
  readonly name: string;
}

interface MoveCategoryInput extends MutationBase {
  readonly categoryId: string;
  readonly expectedRevision: number;
  readonly parentCategoryId?: string;
}

interface RetireCategoryInput extends MutationBase {
  readonly categoryId: string;
  readonly expectedRevision: number;
}

interface CategoryAssignmentInput extends MutationBase {
  readonly categoryId: string;
  readonly productId: string;
}

const CategoryRecordSchema = Schema.Struct({
  categoryRef: ProductCategoryRefSchema,
  lifecycle: Schema.Literals(['ACTIVE', 'RETIRED']),
  name: Schema.String,
  parentRef: Schema.optionalKey(ProductCategoryRefSchema),
  revision: Schema.Finite,
});
const MutationSuccessFields = {
  category: CategoryRecordSchema,
  changed: Schema.Boolean,
  hierarchyRevision: Schema.Finite,
};
const CategoryMutationOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('created', MutationSuccessFields),
  Schema.TaggedStruct('renamed', MutationSuccessFields),
  Schema.TaggedStruct('moved', MutationSuccessFields),
  Schema.TaggedStruct('retired', MutationSuccessFields),
  Schema.TaggedStruct('not_found', { reason: Schema.String }),
  Schema.TaggedStruct('lifecycle_conflict', { reason: Schema.String }),
  Schema.TaggedStruct('hierarchy_conflict', { reason: Schema.String }),
  Schema.TaggedStruct('reference_conflict', { reason: Schema.String }),
  Schema.TaggedStruct('revision_conflict', { actualRevision: Schema.Finite, reason: Schema.String }),
]);
export type CategoryMutationOutcome = typeof CategoryMutationOutcomeSchema.Type;

const AssignmentSuccessFields = {
  assignmentRevision: Schema.Finite,
  categoryRef: ProductCategoryRefSchema,
  productRef: ProductRefSchema,
};
const CategoryAssignmentOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('added', AssignmentSuccessFields),
  Schema.TaggedStruct('removed', AssignmentSuccessFields),
  Schema.TaggedStruct('unchanged', AssignmentSuccessFields),
  Schema.TaggedStruct('not_found', { reason: Schema.String }),
  Schema.TaggedStruct('lifecycle_conflict', { reason: Schema.String }),
  Schema.TaggedStruct('reference_conflict', { reason: Schema.String }),
]);
export type CategoryAssignmentOutcome = typeof CategoryAssignmentOutcomeSchema.Type;

/** An owner-local service bound to Core's already-scoped transaction. */
export interface CategoryPersistence {
  readonly addAssignment: (
    input: CategoryAssignmentInput,
  ) => Effect.Effect<CategoryAssignmentOutcome, CategoryPersistenceUnavailable>;
  readonly createCategory: (
    input: CreateCategoryInput,
  ) => Effect.Effect<CategoryMutationOutcome, CategoryPersistenceUnavailable>;
  readonly moveCategory: (
    input: MoveCategoryInput,
  ) => Effect.Effect<CategoryMutationOutcome, CategoryPersistenceUnavailable>;
  readonly removeAssignment: (
    input: CategoryAssignmentInput,
  ) => Effect.Effect<CategoryAssignmentOutcome, CategoryPersistenceUnavailable>;
  readonly renameCategory: (
    input: RenameCategoryInput,
  ) => Effect.Effect<CategoryMutationOutcome, CategoryPersistenceUnavailable>;
  readonly retireCategory: (
    input: RetireCategoryInput,
  ) => Effect.Effect<CategoryMutationOutcome, CategoryPersistenceUnavailable>;
}

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];
type CategoryRow = typeof productCategories.$inferSelect;
type MutationInput =
  | CreateCategoryInput
  | RenameCategoryInput
  | MoveCategoryInput
  | RetireCategoryInput
  | CategoryAssignmentInput;

const tenantMismatchReason = 'Tenant mismatch';
const categoryNotFoundReason = 'Category not found';
const revisionChangedReason = 'Revision changed';
const categoryRetiredReason = 'Category retired';
const inconsistentHierarchyReason = 'Hierarchy is inconsistent';

const unavailable = (cause?: unknown): CategoryPersistenceUnavailable => {
  const failure = new CategoryPersistenceUnavailable({
    code: 'category_persistence_unavailable',
    reason: 'Category persistence is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const categoryRef = (tenantId: string, resourceId: string): ProductCategoryRef => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: 'commerce.catalog.product-category',
  tenantId,
});
const productRef = (tenantId: string, resourceId: string): ProductRef => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: 'commerce.catalog.product',
  tenantId,
});
const record = (row: CategoryRow): CategoryRecord => {
  const result = {
    categoryRef: categoryRef(row.tenantId, row.categoryId),
    lifecycle: row.lifecycleState === 'RETIRED' ? 'RETIRED' : 'ACTIVE',
    name: row.name,
    revision: row.currentRevision,
  } satisfies CategoryRecord;
  return row.parentCategoryId === null
    ? result
    : { ...result, parentRef: categoryRef(row.tenantId, row.parentCategoryId) };
};

/** Core has already opened and scoped this transaction; the revision row serializes this tenant's category writes. */
export const categoryPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<CategoryPersistence> => {
  const { tenantId } = scope;
  const query = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, CategoryPersistenceUnavailable> =>
    effect.pipe(Effect.mapError(unavailable));
  const lock = Effect.fn('CategoryPersistence.lock')(function* lock() {
    yield* query(transaction.insert(productCategoryHierarchyRevisions).values({ tenantId }).onConflictDoNothing());
    const [row] = yield* query(
      transaction
        .select()
        .from(productCategoryHierarchyRevisions)
        .where(eq(productCategoryHierarchyRevisions.tenantId, tenantId))
        .for('update')
        .limit(1),
    );
    if (row === undefined) {
      return yield* unavailable();
    }
    return row;
  });
  const find = Effect.fn('CategoryPersistence.find')(function* find(categoryId: string) {
    const [row] = yield* query(
      transaction
        .select()
        .from(productCategories)
        .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.categoryId, categoryId)))
        .limit(1),
    );
    return row;
  });
  const event = (
    input: MutationInput,
    kind: string,
    before: CategoryRow | undefined,
    after: CategoryRow,
    revisions: {
      assignmentRevision: number;
      hierarchyRevision: number;
    },
    productId?: string,
  ) =>
    query(
      transaction.insert(productCategoryEvents).values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        assignmentRevision: revisions.assignmentRevision,
        categoryId: after.categoryId,
        categoryRevision: after.currentRevision,
        changeKind: kind,
        hierarchyRevision: revisions.hierarchyRevision,
        nextLifecycleState: after.lifecycleState,
        nextName: after.name,
        nextParentCategoryId: after.parentCategoryId,
        previousLifecycleState: before?.lifecycleState ?? null,
        previousName: before?.name ?? null,
        previousParentCategoryId: before?.parentCategoryId ?? null,
        productId: productId ?? null,
        reason: input.reason,
        tenantId,
      }),
    );
  const bump = Effect.fn('CategoryPersistence.bump')(function* bump(
    kind: 'hierarchy' | 'assignment',
    current: {
      assignmentRevision: number;
      hierarchyRevision: number;
    },
  ) {
    const next = {
      assignmentRevision: current.assignmentRevision + (kind === 'assignment' ? 1 : 0),
      hierarchyRevision: current.hierarchyRevision + (kind === 'hierarchy' ? 1 : 0),
    };
    yield* query(
      transaction
        .update(productCategoryHierarchyRevisions)
        .set({ ...next, updatedAt: DateTime.toDateUtc(yield* DateTime.now) })
        .where(eq(productCategoryHierarchyRevisions.tenantId, tenantId)),
    );
    return next;
  });
  const validParent = Effect.fn('CategoryPersistence.validParent')(function* validParent(parentId?: string) {
    if (parentId === undefined) {
      return true;
    }
    const parent = yield* find(parentId);
    return parent?.lifecycleState === 'ACTIVE';
  });
  const createCategory: CategoryPersistence['createCategory'] = Effect.fn('CategoryPersistence.createCategory')(
    function* createCategory(input) {
      if (input.tenantId !== tenantId) {
        return { _tag: 'not_found', reason: tenantMismatchReason } as const;
      }
      const revision = yield* lock();
      if ((yield* find(input.categoryId)) !== undefined) {
        return { _tag: 'reference_conflict', reason: 'Category already exists' } as const;
      }
      if (!(yield* validParent(input.parentCategoryId))) {
        return { _tag: 'reference_conflict', reason: 'Parent is not active' } as const;
      }
      const [created] = yield* query(
        transaction
          .insert(productCategories)
          .values({
            categoryId: input.categoryId,
            createdByActionInvocationId: input.actionInvocationId,
            createdByPrincipalId: input.principalId,
            name: input.name,
            parentCategoryId: input.parentCategoryId ?? null,
            tenantId,
          })
          .returning(),
      );
      if (created === undefined) {
        return yield* unavailable();
      }
      const next = yield* bump('hierarchy', revision);
      yield* event(input, 'CREATED', undefined, created, next);
      return {
        _tag: 'created',
        category: record(created),
        changed: true,
        hierarchyRevision: next.hierarchyRevision,
      } as const;
    },
  );

  const renameCategory: CategoryPersistence['renameCategory'] = Effect.fn('CategoryPersistence.renameCategory')(
    function* renameCategory(input) {
      if (input.tenantId !== tenantId) {
        return { _tag: 'not_found', reason: tenantMismatchReason } as const;
      }
      const revision = yield* lock();
      const current = yield* find(input.categoryId);
      if (current === undefined) {
        return { _tag: 'not_found', reason: categoryNotFoundReason } as const;
      }
      if (current.currentRevision !== input.expectedRevision) {
        return {
          _tag: 'revision_conflict',
          actualRevision: current.currentRevision,
          reason: revisionChangedReason,
        } as const;
      }
      if (current.lifecycleState !== 'ACTIVE') {
        return { _tag: 'lifecycle_conflict', reason: categoryRetiredReason } as const;
      }
      if (current.name === input.name) {
        return {
          _tag: 'renamed',
          category: record(current),
          changed: false,
          hierarchyRevision: revision.hierarchyRevision,
        } as const;
      }
      const [updated] = yield* query(
        transaction
          .update(productCategories)
          .set({
            currentRevision: current.currentRevision + 1,
            name: input.name,
            updatedAt: DateTime.toDateUtc(yield* DateTime.now),
          })
          .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.categoryId, input.categoryId)))
          .returning(),
      );
      if (updated === undefined) {
        return yield* unavailable();
      }
      const next = yield* bump('hierarchy', revision);
      yield* event(input, 'RENAMED', current, updated, next);
      return {
        _tag: 'renamed',
        category: record(updated),
        changed: true,
        hierarchyRevision: next.hierarchyRevision,
      } as const;
    },
  );

  const moveCategory: CategoryPersistence['moveCategory'] = Effect.fn('CategoryPersistence.moveCategory')(
    function* moveCategory(input) {
      if (input.tenantId !== tenantId) {
        return { _tag: 'not_found', reason: tenantMismatchReason } as const;
      }
      const revision = yield* lock();
      const current = yield* find(input.categoryId);
      if (current === undefined) {
        return { _tag: 'not_found', reason: categoryNotFoundReason } as const;
      }
      if (current.currentRevision !== input.expectedRevision) {
        return {
          _tag: 'revision_conflict',
          actualRevision: current.currentRevision,
          reason: revisionChangedReason,
        } as const;
      }
      if (current.lifecycleState !== 'ACTIVE') {
        return { _tag: 'lifecycle_conflict', reason: categoryRetiredReason } as const;
      }
      const hierarchy = yield* query(
        transaction.select().from(productCategories).where(eq(productCategories.tenantId, tenantId)),
      );
      const validation = validateCategoryMove(
        hierarchy.map(record),
        categoryRef(tenantId, input.categoryId),
        input.parentCategoryId === undefined ? undefined : categoryRef(tenantId, input.parentCategoryId),
      );
      if (!Schema.is(CategoryValidSchema)(validation)) {
        return Match.value(validation.reason).pipe(
          Match.when('CATEGORY_NOT_FOUND', () => ({ _tag: 'not_found', reason: categoryNotFoundReason }) as const),
          Match.when(
            'CATEGORY_RETIRED',
            () => ({ _tag: 'lifecycle_conflict', reason: categoryRetiredReason }) as const,
          ),
          Match.when('PARENT_RETIRED', () => ({ _tag: 'lifecycle_conflict', reason: 'Parent retired' }) as const),
          Match.when('PARENT_NOT_FOUND', () => ({ _tag: 'reference_conflict', reason: 'Parent not found' }) as const),
          Match.when('CROSS_TENANT_PARENT', () => ({ _tag: 'reference_conflict', reason: 'Foreign parent' }) as const),
          Match.when('SELF_PARENT', () => ({ _tag: 'hierarchy_conflict', reason: 'Self-parent cycle' }) as const),
          Match.when('CYCLE', () => ({ _tag: 'hierarchy_conflict', reason: 'Move would create a cycle' }) as const),
          Match.when(
            'INCONSISTENT_HIERARCHY',
            () => ({ _tag: 'hierarchy_conflict', reason: inconsistentHierarchyReason }) as const,
          ),
          Match.when(
            'DIRECT_CHILDREN_REMAIN',
            () => ({ _tag: 'hierarchy_conflict', reason: inconsistentHierarchyReason }) as const,
          ),
          Match.when(
            'DIRECT_ASSIGNMENTS_REMAIN',
            () => ({ _tag: 'hierarchy_conflict', reason: inconsistentHierarchyReason }) as const,
          ),
          Match.exhaustive,
        );
      }
      if (current.parentCategoryId === (input.parentCategoryId ?? null)) {
        return {
          _tag: 'moved',
          category: record(current),
          changed: false,
          hierarchyRevision: revision.hierarchyRevision,
        } as const;
      }
      const [updated] = yield* query(
        transaction
          .update(productCategories)
          .set({
            currentRevision: current.currentRevision + 1,
            parentCategoryId: input.parentCategoryId ?? null,
            updatedAt: DateTime.toDateUtc(yield* DateTime.now),
          })
          .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.categoryId, input.categoryId)))
          .returning(),
      );
      if (updated === undefined) {
        return yield* unavailable();
      }
      const next = yield* bump('hierarchy', revision);
      yield* event(input, 'MOVED', current, updated, next);
      return {
        _tag: 'moved',
        category: record(updated),
        changed: true,
        hierarchyRevision: next.hierarchyRevision,
      } as const;
    },
  );

  const retireCategory: CategoryPersistence['retireCategory'] = Effect.fn('CategoryPersistence.retireCategory')(
    function* retireCategory(input) {
      if (input.tenantId !== tenantId) {
        return { _tag: 'not_found', reason: tenantMismatchReason } as const;
      }
      const revision = yield* lock();
      const current = yield* find(input.categoryId);
      if (current === undefined) {
        return { _tag: 'not_found', reason: categoryNotFoundReason } as const;
      }
      if (current.currentRevision !== input.expectedRevision) {
        return {
          _tag: 'revision_conflict',
          actualRevision: current.currentRevision,
          reason: revisionChangedReason,
        } as const;
      }
      if (current.lifecycleState !== 'ACTIVE') {
        return { _tag: 'lifecycle_conflict', reason: categoryRetiredReason } as const;
      }
      const [child] = yield* query(
        transaction
          .select({ categoryId: productCategories.categoryId })
          .from(productCategories)
          .where(
            and(eq(productCategories.tenantId, tenantId), eq(productCategories.parentCategoryId, input.categoryId)),
          )
          .limit(1),
      );
      if (child !== undefined) {
        return { _tag: 'reference_conflict', reason: 'Category has children' } as const;
      }
      const [dependentAssignment] = yield* query(
        transaction
          .select({ productId: productCategoryAssignments.productId })
          .from(productCategoryAssignments)
          .where(
            and(
              eq(productCategoryAssignments.tenantId, tenantId),
              eq(productCategoryAssignments.categoryId, input.categoryId),
            ),
          )
          .limit(1),
      );
      if (dependentAssignment !== undefined) {
        return { _tag: 'reference_conflict', reason: 'Category has assignments' } as const;
      }
      const [updated] = yield* query(
        transaction
          .update(productCategories)
          .set({
            currentRevision: current.currentRevision + 1,
            lifecycleState: 'RETIRED',
            updatedAt: DateTime.toDateUtc(yield* DateTime.now),
          })
          .where(and(eq(productCategories.tenantId, tenantId), eq(productCategories.categoryId, input.categoryId)))
          .returning(),
      );
      if (updated === undefined) {
        return yield* unavailable();
      }
      const next = yield* bump('hierarchy', revision);
      yield* event(input, 'RETIRED', current, updated, next);
      return {
        _tag: 'retired',
        category: record(updated),
        changed: true,
        hierarchyRevision: next.hierarchyRevision,
      } as const;
    },
  );

  const assignment = Effect.fn('CategoryPersistence.assignment')(function* assignment(
    kind: 'add' | 'remove',
    input: CategoryAssignmentInput,
  ) {
    if (input.tenantId !== tenantId) {
      return { _tag: 'not_found', reason: tenantMismatchReason } as const;
    }
    const revision = yield* lock();
    const category = yield* find(input.categoryId);
    if (category === undefined) {
      return { _tag: 'not_found', reason: 'Product or category not found' } as const;
    }
    if (category.lifecycleState !== 'ACTIVE') {
      return { _tag: 'lifecycle_conflict', reason: categoryRetiredReason } as const;
    }
    const [product] = yield* query(
      transaction
        .select({ productId: products.productId })
        .from(products)
        .where(and(eq(products.tenantId, tenantId), eq(products.productId, input.productId)))
        .limit(1),
    );
    if (product === undefined) {
      return { _tag: 'not_found', reason: 'Product or category not found' } as const;
    }
    const [existing] = yield* query(
      transaction
        .select({ productId: productCategoryAssignments.productId })
        .from(productCategoryAssignments)
        .where(
          and(
            eq(productCategoryAssignments.tenantId, tenantId),
            eq(productCategoryAssignments.productId, input.productId),
            eq(productCategoryAssignments.categoryId, input.categoryId),
          ),
        )
        .limit(1),
    );
    const changed = kind === 'add' ? existing === undefined : existing !== undefined;
    if (!changed) {
      return {
        _tag: 'unchanged',
        assignmentRevision: revision.assignmentRevision,
        categoryRef: categoryRef(tenantId, input.categoryId),
        productRef: productRef(tenantId, input.productId),
      } as const;
    }
    yield* query(
      kind === 'add'
        ? transaction.insert(productCategoryAssignments).values({
            assignedByActionInvocationId: input.actionInvocationId,
            assignedByPrincipalId: input.principalId,
            categoryId: input.categoryId,
            productId: input.productId,
            tenantId,
          })
        : transaction
            .delete(productCategoryAssignments)
            .where(
              and(
                eq(productCategoryAssignments.tenantId, tenantId),
                eq(productCategoryAssignments.productId, input.productId),
                eq(productCategoryAssignments.categoryId, input.categoryId),
              ),
            ),
    );
    const next = yield* bump('assignment', revision);
    yield* event(input, kind === 'add' ? 'ASSIGNED' : 'UNASSIGNED', category, category, next, input.productId);
    return {
      _tag: kind === 'add' ? 'added' : 'removed',
      assignmentRevision: next.assignmentRevision,
      categoryRef: categoryRef(tenantId, input.categoryId),
      productRef: productRef(tenantId, input.productId),
    } as const;
  });

  return Effect.succeed({
    addAssignment: (input) => assignment('add', input),
    createCategory,
    moveCategory,
    removeAssignment: (input) => assignment('remove', input),
    renameCategory,
    retireCategory,
  });
};

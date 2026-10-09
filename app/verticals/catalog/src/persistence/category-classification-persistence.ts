import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Option } from 'effect';

import { deriveClassification } from '../../shared/domain/category-classification.ts';
import type { ClassificationResult } from '../../shared/domain/category-classification.ts';
import {
  productCategories,
  productCategoryAssignments,
  productCategoryHierarchyRevisions,
  products,
} from '../database/schema.ts';
import { CategoryPersistenceUnavailable } from './category-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (cause?: unknown): CategoryPersistenceUnavailable => {
  const failure = new CategoryPersistenceUnavailable({
    code: 'category_persistence_unavailable',
    reason: 'Category classification is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

export interface CategoryClassificationPersistence {
  readonly getClassification: (
    productId: string,
  ) => Effect.Effect<Option.Option<CurrentClassificationResult>, CategoryPersistenceUnavailable>;
}

type CurrentClassificationResult =
  | (Extract<ClassificationResult, { readonly status: 'AVAILABLE' }> & {
      readonly categoryNames: readonly {
        readonly categoryRef: { readonly resourceId: string; readonly tenantId: string };
        readonly name: string;
      }[];
    })
  | { readonly status: 'UNAVAILABLE' };

/** Read a revision-paired classification inside Core's scoped read transaction. */
export const categoryClassificationPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<CategoryClassificationPersistence> => {
  const { tenantId } = scope;
  const getClassification: CategoryClassificationPersistence['getClassification'] = Effect.fn(
    'CategoryClassificationPersistence.getClassification',
  )(function* getClassification(productId) {
    const [product] = yield* transaction
      .select({ productId: products.productId })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.productId, productId)))
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (product === undefined) {
      return Option.none<CurrentClassificationResult>();
    }
    // Every Category write locks this row FOR UPDATE first. A shared lock freezes the pair
    // while the following classification rows are read; an absent row is rechecked below.
    const [basis] = yield* transaction
      .select()
      .from(productCategoryHierarchyRevisions)
      .where(eq(productCategoryHierarchyRevisions.tenantId, tenantId))
      .for('share')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    const [assignments, categories] = yield* Effect.all(
      [
        transaction
          .select()
          .from(productCategoryAssignments)
          .where(
            and(eq(productCategoryAssignments.tenantId, tenantId), eq(productCategoryAssignments.productId, productId)),
          )
          .pipe(Effect.mapError(unavailable)),
        transaction
          .select()
          .from(productCategories)
          .where(eq(productCategories.tenantId, tenantId))
          .pipe(Effect.mapError(unavailable)),
      ],
      { concurrency: 1 },
    );
    if (basis === undefined) {
      const [lateBasis] = yield* transaction
        .select()
        .from(productCategoryHierarchyRevisions)
        .where(eq(productCategoryHierarchyRevisions.tenantId, tenantId))
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (lateBasis !== undefined) {
        return yield* unavailable();
      }
    }
    const classification = deriveClassification(
      { resourceId: productId, tenantId },
      assignments.map(({ categoryId }) => ({
        categoryRef: { resourceId: categoryId, tenantId },
        productRef: { resourceId: productId, tenantId },
      })),
      categories.map(({ categoryId, lifecycleState, parentCategoryId }) => {
        const categoryRef = { resourceId: categoryId, tenantId };
        const lifecycle = lifecycleState === 'ACTIVE' ? ('ACTIVE' as const) : ('RETIRED' as const);
        return parentCategoryId === null
          ? { categoryRef, lifecycle }
          : { categoryRef, lifecycle, parentRef: { resourceId: parentCategoryId, tenantId } };
      }),
      { assignments: basis?.assignmentRevision ?? 0, hierarchy: basis?.hierarchyRevision ?? 0 },
    );
    if (classification.status === 'UNAVAILABLE') {
      return yield* unavailable();
    }
    const currentById = new Map(
      categories.map(({ categoryId, lifecycleState, name }) => [categoryId, { lifecycleState, name }]),
    );
    const referenced = [
      ...classification.directCategories,
      ...classification.ancestors.map(({ ancestorRef }) => ancestorRef),
    ];
    const uniqueRefs = new Map(referenced.map((categoryRef) => [categoryRef.resourceId, categoryRef]));
    const categoryNames = [];
    for (const categoryRef of uniqueRefs.values()) {
      const current = currentById.get(categoryRef.resourceId);
      if (current?.lifecycleState !== 'ACTIVE' || current.name.trim() !== current.name || current.name.length === 0) {
        return yield* unavailable();
      }
      categoryNames.push({ categoryRef, name: current.name });
    }
    return Option.some({ ...classification, categoryNames });
  });
  return Effect.succeed(Object.freeze({ getClassification }));
};

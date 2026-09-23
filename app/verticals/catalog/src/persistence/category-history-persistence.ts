import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';

import { ProductCategoryHistoryResponseSchema } from '../../shared/apis/product-category-history.ts';
import type { ProductCategoryHistoryResponse } from '../../shared/apis/product-category-history.ts';
import type { ProductCategoryRef } from '../../shared/resources/product-category.ts';
import type { ProductRef } from '../../shared/resources/product.ts';
import { productCategoryEvents } from '../database/schema.ts';
import { CategoryPersistenceUnavailable } from './category-persistence.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

const unavailable = (cause?: unknown): CategoryPersistenceUnavailable => {
  const failure = new CategoryPersistenceUnavailable({
    code: 'category_persistence_unavailable',
    reason: 'Category history is temporarily unavailable',
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

export interface CategoryHistoryPersistence {
  readonly getHistory: (
    categoryId: string,
  ) => Effect.Effect<Option.Option<ProductCategoryHistoryResponse>, CategoryPersistenceUnavailable>;
}

/** Exact append-only event snapshots, never reconstructed from a Current Category row. */
export const categoryHistoryPersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
): Effect.Effect<CategoryHistoryPersistence> => {
  const { tenantId } = scope;
  const getHistory: CategoryHistoryPersistence['getHistory'] = Effect.fn('CategoryHistoryPersistence.getHistory')(
    function* getHistory(categoryId) {
      const rows = yield* transaction
        .select()
        .from(productCategoryEvents)
        .where(and(eq(productCategoryEvents.tenantId, tenantId), eq(productCategoryEvents.categoryId, categoryId)))
        .orderBy(asc(productCategoryEvents.recordedAt), asc(productCategoryEvents.productCategoryEventId));
      if (rows.length === 0) {
        return Option.none<ProductCategoryHistoryResponse>();
      }
      const candidate = {
        categoryRef: categoryRef(tenantId, categoryId),
        events: rows.map((row) => {
          const event = {
            actionInvocationId: row.actionInvocationId,
            assignmentRevision: row.assignmentRevision,
            categoryRevision: row.categoryRevision,
            changeKind: row.changeKind,
            hierarchyRevision: row.hierarchyRevision,
            nextLifecycle: row.nextLifecycleState ?? undefined,
            nextName: row.nextName ?? undefined,
            nextParentRef:
              row.nextParentCategoryId === null ? undefined : categoryRef(tenantId, row.nextParentCategoryId),
            previousLifecycle: row.previousLifecycleState ?? undefined,
            previousName: row.previousName ?? undefined,
            previousParentRef:
              row.previousParentCategoryId === null ? undefined : categoryRef(tenantId, row.previousParentCategoryId),
            productRef: row.productId === null ? undefined : productRef(tenantId, row.productId),
            recordedAt: row.recordedAt.toISOString(),
          };
          for (const key of [
            'nextLifecycle',
            'nextName',
            'nextParentRef',
            'previousLifecycle',
            'previousName',
            'previousParentRef',
            'productRef',
          ] as const) {
            if (event[key] === undefined) {
              Reflect.deleteProperty(event, key);
            }
          }
          return event;
        }),
        historical: true as const,
      };
      const history = yield* Schema.decodeUnknownEffect(ProductCategoryHistoryResponseSchema)(candidate);
      return Option.some(history);
    },
    Effect.mapError(unavailable),
  );
  return Effect.succeed(Object.freeze({ getHistory }));
};

import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  productCategoryHistoryEntrypoint,
  readProductCategoryHistory,
} from '../../src/api/product-category-history.read.ts';
import { productCategoryEvents } from '../../src/database/schema.ts';
import { categoryHistoryPersistenceForScope } from '../../src/persistence/category-history-persistence.ts';
import type { CategoryHistoryPersistence } from '../../src/persistence/category-history-persistence.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const categoryId = '00000000-0000-4000-8000-000000000002';
const oldParentId = '00000000-0000-4000-8000-000000000003';
const newParentId = '00000000-0000-4000-8000-000000000004';
const productId = '00000000-0000-4000-8000-000000000008';
const categoryRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: categoryId,
  resourceType: 'commerce.catalog.product-category' as const,
  tenantId,
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:category-history-test:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000009',
    tenantId,
  }),
  correlationId: 'category-history-test',
};

const historyTransaction = <Row>(rows: readonly Row[]) => {
  const orderBy = () => Effect.succeed(rows);
  const where = () => ({ orderBy });
  const from = (table: typeof productCategoryEvents) => {
    expect(table).toBe(productCategoryEvents);
    return { where };
  };
  const select = () => ({ from });
  return { select };
};

describe('governed Category history', () => {
  it('uses the explicit historical read access class for retained Category events', () => {
    expect(productCategoryHistoryEntrypoint.access).toBe('historical_read');
  });

  it.effect('returns exact retained rename and move snapshots without reading Current', () =>
    Effect.gen(function* readRetainedCategoryHistoryCase() {
      const rows = [
        {
          actionInvocationId: '00000000-0000-4000-8000-000000000005',
          assignmentRevision: 1,
          categoryRevision: 2,
          changeKind: 'RENAMED',
          hierarchyRevision: 3,
          nextLifecycleState: 'ACTIVE',
          nextName: 'Wall shelves',
          nextParentCategoryId: oldParentId,
          previousLifecycleState: 'ACTIVE',
          previousName: 'Shelves on wall',
          previousParentCategoryId: oldParentId,
          productId: null,
          recordedAt: new Date('2026-09-17T10:00:00.000Z'),
        },
        {
          actionInvocationId: '00000000-0000-4000-8000-000000000006',
          assignmentRevision: 1,
          categoryRevision: 3,
          changeKind: 'MOVED',
          hierarchyRevision: 4,
          nextLifecycleState: 'ACTIVE',
          nextName: 'Wall shelves',
          nextParentCategoryId: newParentId,
          previousLifecycleState: 'ACTIVE',
          previousName: 'Wall shelves',
          previousParentCategoryId: oldParentId,
          productId: null,
          recordedAt: new Date('2026-09-17T11:00:00.000Z'),
        },
      ];
      const transaction = historyTransaction(rows);
      // @ts-expect-error SAFETY: mock implements precisely the single event-select chain used by getHistory.
      const services = yield* categoryHistoryPersistenceForScope(transaction, scope);
      const result = yield* readProductCategoryHistory({ categoryRef }, tenantId, services);
      expect(result.historical).toBe(true);
      expect(result.events).toHaveLength(2);
      expect(result.events[0]?.previousName).toBe('Shelves on wall');
      expect(result.events[1]?.previousParentRef?.resourceId).toBe(oldParentId);
      expect(result.events[1]?.nextParentRef?.resourceId).toBe(newParentId);
      expect('current' in result).toBe(false);
    }),
  );

  it.effect('retains assignment product identity and legacy nullable Category revision', () =>
    Effect.gen(function* readAssignmentHistoryCase() {
      const rows = [
        {
          actionInvocationId: '00000000-0000-4000-8000-000000000007',
          assignmentRevision: 2,
          categoryRevision: null,
          changeKind: 'ASSIGNED',
          hierarchyRevision: 4,
          nextLifecycleState: null,
          nextName: null,
          nextParentCategoryId: null,
          previousLifecycleState: null,
          previousName: null,
          previousParentCategoryId: null,
          productId,
          recordedAt: new Date('2026-09-17T12:00:00.000Z'),
        },
      ];
      // @ts-expect-error SAFETY: mock implements precisely the single event-select chain used by getHistory.
      const services = yield* categoryHistoryPersistenceForScope(historyTransaction(rows), scope);
      const result = yield* readProductCategoryHistory({ categoryRef }, tenantId, services);
      expect(result.events[0]?.categoryRevision).toBeNull();
      expect(result.events[0]?.productRef?.resourceId).toBe(productId);
    }),
  );

  it.effect('does not fall back to Current when exact history is absent', () =>
    Effect.gen(function* noCurrentFallbackCase() {
      const services: CategoryHistoryPersistence = { getHistory: () => Effect.succeed(Option.none()) };
      const error = yield* readProductCategoryHistory({ categoryRef }, tenantId, services).pipe(Effect.flip);
      expect(error.code).toBe('read_handler_not_found');
    }),
  );

  it.effect('rejects foreign-tenant history before touching persistence', () =>
    Effect.gen(function* rejectForeignHistoryCase() {
      const services: CategoryHistoryPersistence = { getHistory: () => Effect.die('foreign history read') };
      const foreignRef = { ...categoryRef, tenantId: '00000000-0000-4000-8000-000000000099' };
      const error = yield* readProductCategoryHistory({ categoryRef: foreignRef }, tenantId, services).pipe(
        Effect.flip,
      );
      expect(error.code).toBe('read_handler_not_found');
    }),
  );
});

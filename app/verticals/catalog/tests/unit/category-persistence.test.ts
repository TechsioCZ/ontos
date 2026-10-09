import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  productCategories,
  productCategoryEvents,
  productCategoryHierarchyRevisions,
} from '../../src/database/schema.ts';
import { categoryPersistenceForScope } from '../../src/persistence/category-persistence.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const categoryA = '00000000-0000-4000-8000-000000000002';
const categoryB = '00000000-0000-4000-8000-000000000003';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:category-test:run:1',
    authMethod: 'system',
    principalId: '00000000-0000-4000-8000-000000000005',
    tenantId,
  }),
  correlationId: 'category-test',
};
const input = {
  actionInvocationId: '00000000-0000-4000-8000-000000000004',
  principalId: '00000000-0000-4000-8000-000000000005',
  reason: 'Organize catalog',
  tenantId,
};

const revisionLockQuery = (calls: string[]) => ({
  where: () => ({
    for: () => {
      calls.push('revision-lock');
      return { limit: () => Effect.succeed([{ assignmentRevision: 0, hierarchyRevision: 1, tenantId }]) };
    },
  }),
});

interface CategoryRowStub {
  categoryId: string;
  currentRevision: number;
  lifecycleState: string;
  name: string;
  parentCategoryId: string | null;
  tenantId: string;
}

const categoryReadQuery = (rows: CategoryRowStub[]) => ({
  where: () => ({ limit: () => Effect.succeed([rows.shift()]) }),
});

const moveTransaction = (current: CategoryRowStub, snapshot: CategoryRowStub[], calls: string[]) => {
  let categoryReads = 0;
  return {
    insert: (table: typeof productCategories | typeof productCategoryHierarchyRevisions) => {
      expect(table).toBe(productCategoryHierarchyRevisions);
      calls.push('revision-upsert');
      return { values: () => ({ onConflictDoNothing: () => Effect.succeed([]) }) };
    },
    select: () => ({
      from: (table: typeof productCategories | typeof productCategoryHierarchyRevisions) => {
        if (table === productCategoryHierarchyRevisions) {
          calls.push('revision-select');
          return revisionLockQuery(calls);
        }
        expect(table).toBe(productCategories);
        calls.push('category-read');
        categoryReads += 1;
        return categoryReads === 1 ? categoryReadQuery([current]) : { where: () => Effect.succeed(snapshot) };
      },
    }),
    update: () => {
      throw new Error('invalid move must not write');
    },
  };
};

const updatedCategoryQuery = <Row>(row: Row) => ({
  set: () => ({ where: () => ({ returning: () => Effect.succeed([row]) }) }),
});

describe('Category persistence transaction boundary', () => {
  it.effect('stores complete before/after state on a create event', () =>
    Effect.gen(function* createHistory() {
      const events: (typeof productCategoryEvents.$inferInsert)[] = [];
      const created = {
        categoryId: categoryA,
        currentRevision: 1,
        lifecycleState: 'ACTIVE',
        name: 'A',
        parentCategoryId: null,
        tenantId,
      };
      const transaction = {
        insert: (
          table: typeof productCategories | typeof productCategoryEvents | typeof productCategoryHierarchyRevisions,
        ) => {
          if (table === productCategoryHierarchyRevisions) {
            return { values: () => ({ onConflictDoNothing: () => Effect.succeed([]) }) };
          }
          if (table === productCategories) {
            return { values: () => ({ returning: () => Effect.succeed([created]) }) };
          }
          expect(table).toBe(productCategoryEvents);
          return {
            values: (row: typeof productCategoryEvents.$inferInsert) => {
              events.push(row);
              return Effect.succeed([]);
            },
          };
        },
        select: () => ({
          from: (table: typeof productCategories | typeof productCategoryHierarchyRevisions) =>
            table === productCategoryHierarchyRevisions ? revisionLockQuery([]) : categoryReadQuery([]),
        }),
        update: () => ({ set: () => ({ where: () => Effect.succeed([]) }) }),
      };
      // @ts-expect-error The mock implements only the create path's Drizzle query chains.
      const persistence = yield* categoryPersistenceForScope(transaction, scope);
      yield* persistence.createCategory({ ...input, categoryId: categoryA, name: 'A' });
      expect(events).toEqual([
        expect.objectContaining({
          categoryId: categoryA,
          categoryRevision: 1,
          changeKind: 'CREATED',
          nextLifecycleState: 'ACTIVE',
          nextName: 'A',
          nextParentCategoryId: null,
          previousLifecycleState: null,
          previousName: null,
          previousParentCategoryId: null,
        }),
      ]);
    }),
  );

  it.effect('stores the exact old and new category names on rename', () =>
    Effect.gen(function* renameHistory() {
      const events: (typeof productCategoryEvents.$inferInsert)[] = [];
      const previous = {
        categoryId: categoryA,
        currentRevision: 1,
        lifecycleState: 'ACTIVE',
        name: 'Old',
        parentCategoryId: null,
        tenantId,
      };
      const updated = { ...previous, currentRevision: 2, name: 'New' };
      const transaction = {
        insert: (table: typeof productCategoryEvents | typeof productCategoryHierarchyRevisions) => {
          if (table === productCategoryHierarchyRevisions) {
            return { values: () => ({ onConflictDoNothing: () => Effect.succeed([]) }) };
          }
          expect(table).toBe(productCategoryEvents);
          return {
            values: (row: typeof productCategoryEvents.$inferInsert) => {
              events.push(row);
              return Effect.succeed([]);
            },
          };
        },
        select: () => ({
          from: (table: typeof productCategories | typeof productCategoryHierarchyRevisions) =>
            table === productCategoryHierarchyRevisions ? revisionLockQuery([]) : categoryReadQuery([previous]),
        }),
        update: (table: typeof productCategories | typeof productCategoryHierarchyRevisions) => {
          if (table === productCategoryHierarchyRevisions) {
            return { set: () => ({ where: () => Effect.succeed([]) }) };
          }
          return updatedCategoryQuery(updated);
        },
      };
      // @ts-expect-error The mock implements only the rename path's Drizzle query chains.
      const persistence = yield* categoryPersistenceForScope(transaction, scope);
      yield* persistence.renameCategory({ ...input, categoryId: categoryA, expectedRevision: 1, name: 'New' });
      expect(events).toEqual([
        expect.objectContaining({
          categoryRevision: 2,
          changeKind: 'RENAMED',
          nextLifecycleState: 'ACTIVE',
          nextName: 'New',
          previousLifecycleState: 'ACTIVE',
          previousName: 'Old',
        }),
      ]);
    }),
  );

  it.effect('rejects a tenant mismatch before touching the transaction', () =>
    Effect.gen(function* tenantMismatch() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('transaction touched');
          },
        },
      );
      // @ts-expect-error The deliberately uncallable transaction proves that no DB access occurs.
      const persistence = yield* categoryPersistenceForScope(transaction, scope);
      const outcome = yield* persistence.createCategory({
        ...input,
        categoryId: categoryA,
        name: 'A',
        tenantId: '00000000-0000-4000-8000-000000000099',
      });
      expect(
        Match.value(outcome).pipe(
          Match.tag('not_found', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('locks the tenant revision before reading a move and rejects a reciprocal cycle', () =>
    Effect.gen(function* reciprocalCycle() {
      const calls: string[] = [];
      const current = {
        categoryId: categoryA,
        currentRevision: 1,
        lifecycleState: 'ACTIVE',
        name: 'A',
        parentCategoryId: null,
        tenantId,
      };
      const child = { ...current, categoryId: categoryB, name: 'B', parentCategoryId: categoryA };
      const transaction = moveTransaction(current, [current, child], calls);
      // @ts-expect-error The mock implements only the query chain reached by a rejected cycle.
      const persistence = yield* categoryPersistenceForScope(transaction, scope);
      const outcome = yield* persistence.moveCategory({
        ...input,
        categoryId: categoryA,
        expectedRevision: 1,
        parentCategoryId: categoryB,
      });
      expect(
        Match.value(outcome).pipe(
          Match.tag('hierarchy_conflict', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(calls).toEqual(['revision-upsert', 'revision-select', 'revision-lock', 'category-read', 'category-read']);
    }),
  );

  it.effect('rejects a root move when an unrelated cycle exists in the locked tenant snapshot', () =>
    Effect.gen(function* unrelatedCycle() {
      const calls: string[] = [];
      const current = {
        categoryId: categoryA,
        currentRevision: 1,
        lifecycleState: 'ACTIVE',
        name: 'A',
        parentCategoryId: categoryB,
        tenantId,
      };
      const previousParent = { ...current, categoryId: categoryB, name: 'B', parentCategoryId: null };
      const cycleC = {
        ...current,
        categoryId: '00000000-0000-4000-8000-000000000006',
        name: 'C',
        parentCategoryId: '00000000-0000-4000-8000-000000000007',
      };
      const cycleD = {
        ...current,
        categoryId: '00000000-0000-4000-8000-000000000007',
        name: 'D',
        parentCategoryId: cycleC.categoryId,
      };
      const transaction = moveTransaction(current, [current, previousParent, cycleC, cycleD], calls);
      // @ts-expect-error The mock implements only the query chains reached by a rejected root move.
      const persistence = yield* categoryPersistenceForScope(transaction, scope);
      const outcome = yield* persistence.moveCategory({ ...input, categoryId: categoryA, expectedRevision: 1 });
      expect(
        Match.value(outcome).pipe(
          Match.tag('hierarchy_conflict', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(calls).toEqual(['revision-upsert', 'revision-select', 'revision-lock', 'category-read', 'category-read']);
    }),
  );
});

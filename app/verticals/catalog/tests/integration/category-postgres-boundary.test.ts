import { findPostgresFailure, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { eq, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  catalogRelations,
  productCategories,
  productCategoryAssignments,
  products,
} from '../../src/database/schema.ts';
import type { CatalogTransaction } from '../../src/database/types.ts';
import { categoryPersistenceForScope } from '../../src/persistence/category-persistence.ts';

// Category rows are intentionally delete-protected. Allocate a fresh isolated Tenant namespace
// for every run and leave immutable evidence in the disposable integration database.
const tenantA = randomUUID();
const tenantB = randomUUID();
const principalId = randomUUID();
const firstId = randomUUID();
const secondId = randomUUID();
const retiringId = randomUUID();
const productA = randomUUID();
const productB = randomUUID();

const scopeFor = (tenantId: string) => ({
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:category-postgres-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'category-postgres-test',
});

const mutation = (tenantId: string, actionInvocationId: string) => ({
  actionInvocationId,
  principalId,
  reason: 'PostgreSQL category boundary proof',
  tenantId,
});

it.live('serializes category moves and retirement against assignments while enforcing tenant boundaries', () =>
  Effect.scoped(
    Effect.gen(function* categoryPostgresBoundary() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, catalogRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, catalogRelations);
      const withTenant = <Value, Failure>(
        tenantId: string,
        operation: (transaction: CatalogTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedCategoryTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            return yield* operation(transaction);
          }),
        );
      const categoryService = (transaction: CatalogTransaction) =>
        // The fixture installs tenant scope before passing the owner transaction. Core's private
        // brand is intentionally unavailable to package tests, while the query methods are real.
        categoryPersistenceForScope(
          // @ts-expect-error The test transaction intentionally lacks only Core's private scope brand.
          transaction,
          scopeFor(tenantA),
        );

      yield* admin.insert(productCategories).values([
        {
          categoryId: firstId,
          createdByActionInvocationId: firstId,
          createdByPrincipalId: principalId,
          name: 'First',
          tenantId: tenantA,
        },
        {
          categoryId: secondId,
          createdByActionInvocationId: secondId,
          createdByPrincipalId: principalId,
          name: 'Second',
          tenantId: tenantA,
        },
        {
          categoryId: retiringId,
          createdByActionInvocationId: retiringId,
          createdByPrincipalId: principalId,
          name: 'Retiring',
          tenantId: tenantA,
        },
      ]);
      yield* admin.insert(products).values([
        {
          createdByActionInvocationId: productA,
          createdByPrincipalId: principalId,
          productId: productA,
          tenantId: tenantA,
        },
        {
          createdByActionInvocationId: productB,
          createdByPrincipalId: principalId,
          productId: productB,
          tenantId: tenantB,
        },
      ]);

      const moves = yield* Effect.all(
        [
          withTenant(tenantA, (transaction) =>
            Effect.gen(function* moveFirst() {
              const service = yield* categoryService(transaction);
              return yield* service.moveCategory({
                ...mutation(tenantA, randomUUID()),
                categoryId: firstId,
                expectedRevision: 1,
                parentCategoryId: secondId,
              });
            }),
          ),
          withTenant(tenantA, (transaction) =>
            Effect.gen(function* moveSecond() {
              const service = yield* categoryService(transaction);
              return yield* service.moveCategory({
                ...mutation(tenantA, randomUUID()),
                categoryId: secondId,
                expectedRevision: 1,
                parentCategoryId: firstId,
              });
            }),
          ),
        ],
        { concurrency: 2 },
      );
      expect(new Set(moves.map((outcome) => outcome._tag))).toEqual(new Set(['hierarchy_conflict', 'moved']));
      const rows = yield* admin.select().from(productCategories).where(eq(productCategories.tenantId, tenantA));
      const first = rows.find((row) => row.categoryId === firstId);
      const second = rows.find((row) => row.categoryId === secondId);
      expect(first?.parentCategoryId === secondId && second?.parentCategoryId === firstId).toBe(false);

      const race = yield* Effect.all(
        [
          withTenant(tenantA, (transaction) =>
            Effect.gen(function* assignBeforeRetire() {
              const service = yield* categoryService(transaction);
              return yield* service.addAssignment({
                ...mutation(tenantA, randomUUID()),
                categoryId: retiringId,
                productId: productA,
              });
            }),
          ),
          withTenant(tenantA, (transaction) =>
            Effect.gen(function* retireBeforeAssign() {
              const service = yield* categoryService(transaction);
              return yield* service.retireCategory({
                ...mutation(tenantA, randomUUID()),
                categoryId: retiringId,
                expectedRevision: 1,
              });
            }),
          ),
        ],
        { concurrency: 2 },
      );
      const [retiring] = yield* admin
        .select()
        .from(productCategories)
        .where(eq(productCategories.categoryId, retiringId));
      const assignments = yield* admin
        .select()
        .from(productCategoryAssignments)
        .where(eq(productCategoryAssignments.categoryId, retiringId));
      expect(retiring?.lifecycleState === 'RETIRED' && assignments.length > 0).toBe(false);
      expect(new Set(race.map((outcome) => outcome._tag))).toEqual(
        new Set(
          retiring?.lifecycleState === 'RETIRED' ? ['lifecycle_conflict', 'retired'] : ['added', 'reference_conflict'],
        ),
      );

      expect(yield* withTenant(tenantB, (transaction) => transaction.select().from(productCategories))).toEqual([]);
      const role = yield* runtime.execute<{ rolbypassrls: boolean; rolsuper: boolean }>(
        sql`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`,
        'objects',
      );
      expect(role).toEqual([{ rolbypassrls: false, rolsuper: false }]);
      const foreignInsertError = yield* Effect.flip(
        withTenant(tenantB, (transaction) =>
          transaction.insert(productCategoryAssignments).values({
            assignedByActionInvocationId: randomUUID(),
            assignedByPrincipalId: principalId,
            categoryId: retiringId,
            productId: productB,
            tenantId: tenantB,
          }),
        ),
      );
      expect(Option.exists(findPostgresFailure(foreignInsertError), ({ code }) => code === '23503')).toBe(true);
    }),
  ),
);

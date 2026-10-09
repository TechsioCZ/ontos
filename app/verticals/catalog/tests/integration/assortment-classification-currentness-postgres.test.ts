import { randomUUID } from 'node:crypto';

import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { DateTime, Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { catalogRelations, products } from '../../src/database/schema.ts';
import { categoryPersistenceForScope } from '../../src/persistence/category-persistence.ts';
import {
  assortmentProductClassificationV1SourceForScope,
  observeOrVerifyAssortmentProductClassificationV1,
} from '../../src/persistence/assortment-product-classification-v1.ts';

const tenantId = randomUUID();
const productId = randomUUID();
const categoryId = randomUUID();
const principalId = randomUUID();
const scope = {
  authContextRef: `job:catalog-classification-test:${randomUUID()}`,
  authMethod: 'system',
  correlationId: randomUUID(),
  principalId,
  tenantId,
} satisfies OperationalScope;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const effectiveAt = DateTime.fromDateUnsafe(new Date('2030-01-01T00:00:00.000Z'));

it.live('invalidates an empty Product classification proof when a category assignment is added', () =>
  Effect.scoped(
    Effect.gen(function* classificationCurrentnessPostgres() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, catalogRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
      const runScoped = <Value, Failure>(
        operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedCatalogOperation() {
            const scoped = yield* installOperationalScope(transaction, scope);
            return yield* operation(scoped);
          }),
        );

      yield* admin.insert(products).values({
        createdByActionInvocationId: randomUUID(),
        createdByPrincipalId: principalId,
        productId,
        tenantId,
      });
      yield* runScoped((transaction) =>
        Effect.flatMap(categoryPersistenceForScope(transaction, scope), (categories) =>
          categories.createCategory({
            actionInvocationId: randomUUID(),
            categoryId,
            name: 'Classification proof category',
            principalId,
            reason: 'Establish category fence for empty classification',
            tenantId,
          }),
        ),
      );
      const observed = yield* runScoped((transaction) =>
        observeOrVerifyAssortmentProductClassificationV1(
          { effectiveAt, operation: 'OBSERVE', productRef },
          tenantId,
          assortmentProductClassificationV1SourceForScope(transaction, scope),
        ),
      );
      if (observed.operation !== 'OBSERVE') {
        throw new Error('Expected an initial classification observation');
      }
      expect(observed.observation.facts.directCategories).toEqual([]);
      const before = yield* runScoped((transaction) =>
        observeOrVerifyAssortmentProductClassificationV1(
          { effectiveAt, observation: observed.observation, operation: 'VERIFY_CURRENT' },
          tenantId,
          assortmentProductClassificationV1SourceForScope(transaction, scope),
        ),
      );
      expect(before).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'CURRENT' });

      yield* runScoped((transaction) =>
        Effect.flatMap(categoryPersistenceForScope(transaction, scope), (categories) =>
          categories.addAssignment({
            actionInvocationId: randomUUID(),
            categoryId,
            principalId,
            productId,
            reason: 'Change previously empty classification',
            tenantId,
          }),
        ),
      );
      const after = yield* runScoped((transaction) =>
        observeOrVerifyAssortmentProductClassificationV1(
          { effectiveAt, observation: observed.observation, operation: 'VERIFY_CURRENT' },
          tenantId,
          assortmentProductClassificationV1SourceForScope(transaction, scope),
        ),
      );
      expect(after).toMatchObject({ operation: 'VERIFY_CURRENT', status: 'STALE' });
    }),
  ),
);

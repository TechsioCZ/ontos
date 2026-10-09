import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { and, eq, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  attributeDefinitions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  catalogRelations,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  productTypeAssignments,
  productTypeAssignmentEvents,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
  products,
} from '../../src/database/schema.ts';
import type { CatalogTransaction } from '../../src/database/types.ts';
import { attributeValuesPersistenceForScope } from '../../src/persistence/attribute-values-persistence.ts';

const reference = <ResourceType extends 'attribute-definition' | 'product'>(
  resourceType: ResourceType,
  resourceId: string,
  tenantId: string,
) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType: `commerce.catalog.${resourceType}` as const,
  tenantId,
});

// Append-only revisions remain in the disposable integration database; fresh IDs isolate every run.
it.live('keeps two Products using one material definition independent in Current and history', () =>
  Effect.scoped(
    Effect.gen(function* attributeValueIsolation() {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const principalId = randomUUID();
      const definitionId = randomUUID();
      const typeId = randomUUID();
      const p1 = randomUUID();
      const p2 = randomUUID();
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const admin = yield* makeTestDatabaseFromClient(adminClient, catalogRelations);
      const runtime = yield* makeTestDatabaseFromClient(runtimeClient, catalogRelations);
      const scopeFor = (tenantId: string) => ({
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:attribute-isolation-test:run:1',
          authMethod: 'system',
          principalId,
          tenantId,
        }),
        correlationId: 'attribute-isolation-test',
      });
      const withTenant = <Value, Failure>(
        tenantId: string,
        operation: (transaction: CatalogTransaction) => Effect.Effect<Value, Failure>,
      ) =>
        runtime.transaction((transaction) =>
          Effect.gen(function* scopedAttributeTransaction() {
            yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`, 'objects');
            return yield* operation(transaction);
          }),
        );
      const setMaterial = (tenantId: string, productId: string, material: string, expectedRevision: number | null) =>
        withTenant(tenantId, (transaction) =>
          Effect.gen(function* persistMaterial() {
            const service = yield* attributeValuesPersistenceForScope(
              // @ts-expect-error The real test transaction lacks only Core's private scope brand.
              transaction,
              scopeFor(tenantId),
            );
            return yield* service.setProductValues({
              actionInvocationId: randomUUID(),
              attributeDefinitionRef: reference('attribute-definition', definitionId, tenantA),
              expectedRevision,
              principalId,
              productRef: reference('product', productId, tenantId),
              reason: 'Verified material correction',
              values: [{ kind: 'TEXT', text: material }],
            });
          }),
        );

      yield* admin.insert(products).values(
        [p1, p2].map((productId) => ({
          createdByActionInvocationId: randomUUID(),
          createdByPrincipalId: principalId,
          lifecycleState: 'ACTIVE',
          productId,
          tenantId: tenantA,
        })),
      );
      yield* admin.insert(attributeDefinitions).values({
        applicableLevels: ['PRODUCT'],
        attributeDefinitionId: definitionId,
        createdByActionInvocationId: randomUUID(),
        createdByPrincipalId: principalId,
        meaning: 'Constituent material of the Product',
        multiplicity: 'SINGLE',
        name: 'Material',
        tenantId: tenantA,
        valueKind: 'TEXT',
      });
      yield* admin.insert(productTypes).values({
        createdByActionInvocationId: randomUUID(),
        createdByPrincipalId: principalId,
        name: 'Material-bearing Product',
        productTypeId: typeId,
        tenantId: tenantA,
      });
      yield* admin.insert(productTypeRevisions).values({
        actingPrincipalId: principalId,
        actionInvocationId: randomUUID(),
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
        productTypeId: typeId,
        reason: 'Fixture type revision',
        revision: 1,
        tenantId: tenantA,
      });
      yield* admin.insert(productTypeRevisionAttributes).values({
        attributeDefinitionId: definitionId,
        level: 'PRODUCT',
        productTypeId: typeId,
        requirement: 'OPTIONAL',
        revision: 1,
        tenantId: tenantA,
      });
      yield* admin.transaction((transaction) =>
        Effect.forEach([p1, p2], (productId) => {
          const actionInvocationId = randomUUID();
          return Effect.gen(function* assignProductType() {
            yield* transaction.insert(productTypeAssignmentEvents).values({
              actingPrincipalId: principalId,
              actionInvocationId,
              assignmentRevision: 1,
              nextProductTypeId: typeId,
              productId,
              reason: 'Fixture Product Type assignment',
              tenantId: tenantA,
            });
            yield* transaction.insert(productTypeAssignments).values({
              assignedByActionInvocationId: actionInvocationId,
              assignedByPrincipalId: principalId,
              productId,
              productTypeId: typeId,
              tenantId: tenantA,
            });
          });
        }),
      );
      yield* admin.transaction((transaction) =>
        Effect.forEach([p1, p2], (productId) =>
          Effect.gen(function* declareProductMaterial() {
            yield* transaction.insert(productAttributeApplicability).values({
              attributeDefinitionId: definitionId,
              currentRevision: 1,
              productId,
              productLevel: true,
              tenantId: tenantA,
              variantLevel: false,
            });
            yield* transaction.insert(productAttributeApplicabilityRevisions).values({
              actingPrincipalId: principalId,
              actionInvocationId: randomUUID(),
              attributeDefinitionId: definitionId,
              evidenceRefs: [],
              productId,
              productLevel: true,
              reason: 'Fixture Product material declaration',
              revision: 1,
              tenantId: tenantA,
              variantLevel: false,
            });
          }),
        ),
      );

      const first = yield* setMaterial(tenantA, p1, 'steel', null);
      const second = yield* setMaterial(tenantA, p2, 'wood', null);
      expect(first.revision).toBe(1);
      expect(second.revision).toBe(1);
      expect(first.attributeValueSetId).not.toBe(second.attributeValueSetId);

      const p2Before = {
        current: yield* admin
          .select()
          .from(attributeValueSets)
          .where(eq(attributeValueSets.attributeValueSetId, second.attributeValueSetId)),
        history: yield* admin
          .select()
          .from(attributeValueRevisions)
          .where(eq(attributeValueRevisions.attributeValueSetId, second.attributeValueSetId)),
        items: yield* admin
          .select()
          .from(attributeValueItems)
          .where(eq(attributeValueItems.attributeValueSetId, second.attributeValueSetId)),
      };
      expect(p2Before.current).toMatchObject([
        { attributeDefinitionId: definitionId, currentRevision: 1, productId: p2 },
      ]);
      expect(p2Before.items).toMatchObject([{ textValue: 'wood' }]);
      expect(p2Before.history).toMatchObject([
        { revision: 1, valueSnapshot: { values: [{ kind: 'TEXT', text: 'wood' }] } },
      ]);

      expect(yield* setMaterial(tenantA, p1, 'stainless steel', 1)).toMatchObject({
        attributeValueSetId: first.attributeValueSetId,
        revision: 2,
      });
      expect(
        yield* admin
          .select()
          .from(attributeValueSets)
          .where(eq(attributeValueSets.attributeValueSetId, second.attributeValueSetId)),
      ).toEqual(p2Before.current);
      expect(
        yield* admin
          .select()
          .from(attributeValueItems)
          .where(eq(attributeValueItems.attributeValueSetId, second.attributeValueSetId)),
      ).toEqual(p2Before.items);
      expect(
        yield* admin
          .select()
          .from(attributeValueRevisions)
          .where(eq(attributeValueRevisions.attributeValueSetId, second.attributeValueSetId)),
      ).toEqual(p2Before.history);

      const p1Current = yield* admin
        .select()
        .from(attributeValueItems)
        .where(eq(attributeValueItems.attributeValueSetId, first.attributeValueSetId));
      const p1History = yield* admin
        .select()
        .from(attributeValueRevisions)
        .where(eq(attributeValueRevisions.attributeValueSetId, first.attributeValueSetId));
      expect(p1Current).toMatchObject([{ textValue: 'stainless steel' }]);
      expect(p1History).toMatchObject([
        { revision: 1, valueSnapshot: { values: [{ kind: 'TEXT', text: 'steel' }] } },
        { revision: 2, valueSnapshot: { values: [{ kind: 'TEXT', text: 'stainless steel' }] } },
      ]);

      expect(yield* withTenant(tenantB, (transaction) => transaction.select().from(attributeValueSets))).toEqual([]);
      expect(yield* withTenant(tenantB, (transaction) => transaction.select().from(attributeValueRevisions))).toEqual(
        [],
      );
      const foreignError = yield* Effect.flip(setMaterial(tenantB, p2, 'intrusion', null));
      expect(foreignError).toMatchObject({ conflict: 'INVALID_INPUT' });
      expect(
        yield* admin
          .select()
          .from(attributeValueSets)
          .where(and(eq(attributeValueSets.tenantId, tenantA), eq(attributeValueSets.productId, p2))),
      ).toEqual(p2Before.current);
    }),
  ),
);

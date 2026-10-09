import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  attributeDefinitions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  controlledAttributeValueRevisions,
  controlledAttributeValues,
  productAttributeApplicability,
  productTypeAssignments,
  productTypeRevisionAttributes,
  productTypes,
  productVariantAxes,
  productVariants,
  products,
} from '../../src/database/schema.ts';
import { attributePersistenceForScope } from '../../src/persistence/attribute-persistence.ts';

import {
  AttributeValuesConflict,
  attributeValuesPersistenceForScope,
  mapAttributeValuesWriteError,
  resolveAffectedInheritedVariantRefs,
  validateOverrideRemovalBasis,
} from '../../src/persistence/attribute-values-persistence.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

describe('Attribute value persistence error boundary', () => {
  it('identifies every non-retired Variant without a Current direct override', () => {
    const affected = resolveAffectedInheritedVariantRefs(
      '11111111-1111-4111-8111-111111111111',
      [
        { lifecycleState: 'ACTIVE', variantId: '22222222-2222-4222-8222-222222222222' },
        { lifecycleState: 'WORK_IN_PROGRESS', variantId: '33333333-3333-4333-8333-333333333333' },
        { lifecycleState: 'ACTIVE', variantId: '44444444-4444-4444-8444-444444444444' },
        { lifecycleState: 'RETIRED', variantId: '55555555-5555-4555-8555-555555555555' },
      ],
      [
        { currentState: 'SET', variantId: '22222222-2222-4222-8222-222222222222' },
        { currentState: 'REMOVED', variantId: '33333333-3333-4333-8333-333333333333' },
        { currentState: 'SET', variantId: null },
      ],
    );
    expect(affected.map(({ resourceId }) => resourceId)).toEqual([
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ]);
  });

  it('removes an override only against the current inherited source revision', () => {
    expect(validateOverrideRemovalBasis(2, 3, false, true)).toMatchObject({ conflict: 'BASIS_CHANGED' });
    expect(validateOverrideRemovalBasis(null, null, true, false)).toMatchObject({ conflict: 'REQUIRED' });
    expect(validateOverrideRemovalBasis(3, 3, false, false)).toMatchObject({ conflict: 'INAPPLICABLE' });
    expect(validateOverrideRemovalBasis(3, 3, true, true)).toBeNull();
    expect(validateOverrideRemovalBasis(null, null, false, false)).toBeNull();
  });
  it('classifies only its exact append-only invocation constraint', () => {
    expect(
      mapAttributeValuesWriteError({ code: '23505', constraint: 'catalog_attribute_value_revisions_invocation_uk' }),
    ).toMatchObject({ conflict: 'ACTION_INVOCATION_ID' });
  });

  it('does not invent a business conflict from an unrelated or indeterminate database failure', () => {
    for (const cause of [
      { code: '23505', constraint: 'catalog_attribute_value_sets_product_uk' },
      { code: '23503', constraint: 'catalog_attribute_value_items_controlled_fk' },
      new Error('duplicate'),
    ]) {
      const mapped = mapAttributeValuesWriteError(cause);
      expect(Schema.is(AttributeValuesConflict)(mapped)).toBe(false);
      expect(Schema.is(CatalogPersistenceUnavailable)(mapped)).toBe(true);
      expect(mapped.cause).toBe(cause);
    }
  });
});

describe('Controlled value persistence lifecycle', () => {
  it.effect('corrects one Product material without changing another Product value or history', () =>
    Effect.gen(function* independentProductValues() {
      const tenantId = '11111111-1111-4111-8111-111111111111';
      const principalId = '22222222-2222-4222-8222-222222222222';
      const definitionId = '33333333-3333-4333-8333-333333333333';
      const p1 = '55555555-5555-4555-8555-555555555555';
      const p2 = '66666666-6666-4666-8666-666666666666';
      const typeId = '88888888-8888-4888-8888-888888888888';
      const scope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:independent-materials:run:1',
          authMethod: 'system',
          principalId,
          tenantId,
        }),
        correlationId: 'independent-materials-test',
      };
      const definitionRef = {
        moduleId: 'commerce.catalog' as const,
        resourceId: definitionId,
        resourceType: 'commerce.catalog.attribute-definition' as const,
        tenantId,
      };
      const sets = new Map<string, typeof attributeValueSets.$inferInsert>();
      const items = new Map<string, readonly (typeof attributeValueItems.$inferInsert)[]>();
      const history: (typeof attributeValueRevisions.$inferInsert)[] = [];
      type FixtureTable =
        | typeof products
        | typeof attributeDefinitions
        | typeof productTypeAssignments
        | typeof productTypes
        | typeof productTypeRevisionAttributes
        | typeof productAttributeApplicability
        | typeof productVariantAxes
        | typeof attributeValueSets
        | typeof attributeValueItems
        | typeof attributeValueRevisions;
      let selectedProductId = p1;
      let updatedSetId = '';
      const rowsFor = (table: FixtureTable): readonly object[] => {
        if (table === products) {
          return [{ lifecycleState: 'ACTIVE', productId: selectedProductId }];
        }
        if (table === attributeDefinitions) {
          return [
            {
              allowsNone: 0,
              allowsNotApplicable: 0,
              allowsUnknown: 0,
              applicableLevels: ['PRODUCT'],
              currentRevision: 1,
              meaning: 'Constituent material of the product',
              multiplicity: 'SINGLE',
              name: 'Material',
              valueKind: 'TEXT',
            },
          ];
        }
        if (table === productTypeAssignments) {
          return [{ productTypeId: typeId }];
        }
        if (table === productTypes) {
          return [{ currentRevision: 1 }];
        }
        if (table === productTypeRevisionAttributes) {
          return [{ requirement: 'OPTIONAL' }];
        }
        if (table === productAttributeApplicability) {
          return [{ productLevel: true, variantLevel: false }];
        }
        if (table === productVariantAxes) {
          return [];
        }
        if (table === attributeValueSets) {
          const set = sets.get(selectedProductId);
          return set === undefined ? [] : [set];
        }
        throw new Error('Unexpected persistence read');
      };
      const transaction = {
        delete: (table: FixtureTable) => ({
          where: () => {
            expect(table).toBe(attributeValueItems);
            expect(updatedSetId).toBe(sets.get(selectedProductId)?.attributeValueSetId);
            items.delete(selectedProductId);
            return Effect.void;
          },
        }),
        insert: (table: FixtureTable) => ({
          values: (
            row:
              | typeof attributeValueSets.$inferInsert
              | readonly (typeof attributeValueItems.$inferInsert)[]
              | typeof attributeValueRevisions.$inferInsert,
          ) => {
            if (table === attributeValueSets && 'productId' in row) {
              sets.set(selectedProductId, row);
            } else if (table === attributeValueItems && Array.isArray(row)) {
              items.set(selectedProductId, row);
            } else if (table === attributeValueRevisions && 'actionInvocationId' in row) {
              history.push(row);
            }
            return Effect.void;
          },
        }),
        select: () => ({
          from: (table: FixtureTable) => {
            const query = {
              for: () => query,
              limit: () => Effect.succeed(rowsFor(table).slice(0, 1)),
              pipe: <A>(operation: (effect: Effect.Effect<readonly object[]>) => A): A =>
                operation(Effect.succeed(rowsFor(table))),
              where: () => query,
            };
            return query;
          },
        }),
        update: (table: FixtureTable) => ({
          set: (fields: Partial<typeof attributeValueSets.$inferInsert>) => ({
            where: () => {
              expect(table).toBe(attributeValueSets);
              const current = sets.get(selectedProductId);
              if (current?.attributeValueSetId === undefined) {
                throw new Error('Missing current Product value');
              }
              updatedSetId = current.attributeValueSetId;
              sets.set(selectedProductId, { ...current, ...fields });
              return Effect.void;
            },
          }),
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const persistence = yield* attributeValuesPersistenceForScope(transaction, scope);
      const setMaterial = (productId: string, material: string, revision: number | null, invocation: string) => {
        selectedProductId = productId;
        return persistence.setProductValues({
          actionInvocationId: invocation,
          attributeDefinitionRef: definitionRef,
          expectedRevision: revision,
          principalId,
          productRef: {
            moduleId: 'commerce.catalog',
            resourceId: productId,
            resourceType: 'commerce.catalog.product',
            tenantId,
          },
          reason: 'Verified material correction',
          values: [{ kind: 'TEXT', text: material }],
        });
      };
      yield* setMaterial(p1, 'steel', null, 'p1-steel');
      yield* setMaterial(p2, 'wood', null, 'p2-wood');
      const p2Before = {
        history: history.filter((row) => row.attributeValueSetId === sets.get(p2)?.attributeValueSetId),
        items: items.get(p2),
        set: { ...sets.get(p2) },
      };
      yield* setMaterial(p1, 'stainless steel', 1, 'p1-corrected');
      expect(sets.get(p1)).toMatchObject({ currentRevision: 2, currentState: 'SET' });
      expect(items.get(p1)).toEqual([expect.objectContaining({ textValue: 'stainless steel' })]);
      expect(sets.get(p2)).toEqual(p2Before.set);
      expect(items.get(p2)).toEqual(p2Before.items);
      expect(p2Before.items).toEqual([expect.objectContaining({ textValue: 'wood' })]);
      expect(history.filter((row) => row.attributeValueSetId === sets.get(p2)?.attributeValueSetId)).toEqual(
        p2Before.history,
      );
      expect(history.filter((row) => row.attributeValueSetId === sets.get(p1)?.attributeValueSetId)).toMatchObject([
        { revision: 1, valueSnapshot: { values: [{ kind: 'TEXT', text: 'steel' }] } },
        { revision: 2, valueSnapshot: { values: [{ kind: 'TEXT', text: 'stainless steel' }] } },
      ]);
      expect(sets.get(p1)?.attributeDefinitionId).toBe(definitionId);
      expect(sets.get(p2)?.attributeDefinitionId).toBe(definitionId);
    }),
  );

  it.effect('preserves P1 and V1 history while retirement gates only new Product and Variant assignments', () =>
    Effect.gen(function* lifecycle() {
      const tenantId = '11111111-1111-4111-8111-111111111111';
      const principalId = '22222222-2222-4222-8222-222222222222';
      const definitionId = '33333333-3333-4333-8333-333333333333';
      const valueId = '44444444-4444-4444-8444-444444444444';
      const p1 = '55555555-5555-4555-8555-555555555555';
      const p2 = '66666666-6666-4666-8666-666666666666';
      const v2 = '77777777-7777-4777-8777-777777777777';
      const typeId = '88888888-8888-4888-8888-888888888888';
      const scope = {
        ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
          authContextRef: 'job:controlled-lifecycle:run:1',
          authMethod: 'system',
          principalId,
          tenantId,
        }),
        correlationId: 'controlled-lifecycle-test',
      };
      const ref = <T extends string>(resourceType: T, resourceId: string) => ({
        moduleId: 'commerce.catalog' as const,
        resourceId,
        resourceType: `commerce.catalog.${resourceType}` as const,
        tenantId,
      });
      const attributeDefinitionRef = ref('attribute-definition', definitionId);
      const controlledValueRef = ref('controlled-attribute-value', valueId);
      const value = { kind: 'CONTROLLED' as const, valueRef: controlledValueRef };
      const controlled = {
        attributeDefinitionId: definitionId,
        colorGroup: null,
        controlledAttributeValueId: valueId,
        currentRevision: 1,
        lifecycleState: 'ACTIVE',
        meaning: 'Stainless steel material',
        name: 'Stainles steel',
        previewEvidenceRef: null,
        previewHex: null,
        specialization: 'GENERAL',
        swatchCode: null,
        swatchSystem: null,
        tenantId,
      };
      type FixtureTable =
        | typeof attributeDefinitions
        | typeof attributeValueItems
        | typeof attributeValueRevisions
        | typeof attributeValueSets
        | typeof controlledAttributeValueRevisions
        | typeof controlledAttributeValues
        | typeof productTypeAssignments
        | typeof productTypeRevisionAttributes
        | typeof productAttributeApplicability
        | typeof productTypes
        | typeof productVariantAxes
        | typeof productVariants
        | typeof products;
      type FixtureWrite =
        | typeof attributeValueItems.$inferInsert
        | typeof attributeValueRevisions.$inferInsert
        | typeof attributeValueSets.$inferInsert
        | typeof controlledAttributeValueRevisions.$inferInsert;
      const sets: (typeof attributeValueSets.$inferInsert)[] = [];
      const items: (typeof attributeValueItems.$inferInsert)[] = [];
      const revisions: FixtureWrite[] = [];
      const writes: [FixtureTable, FixtureWrite | readonly FixtureWrite[] | Partial<typeof controlled>][] = [];
      let selectedProductId = p1;
      let selectedVariantId: string | undefined;
      const rowsFor = (table: FixtureTable): readonly object[] => {
        if (table === products) {
          return [
            { lifecycleState: 'ACTIVE', productId: p1 },
            { lifecycleState: 'ACTIVE', productId: p2 },
          ];
        }
        if (table === productVariants) {
          return selectedProductId === p2 ? [{ lifecycleState: 'ACTIVE', productId: p2, variantId: v2 }] : [];
        }
        if (table === attributeDefinitions) {
          return [
            {
              allowsNone: 0,
              allowsNotApplicable: 0,
              allowsUnknown: 0,
              applicableLevels: ['PRODUCT', 'VARIANT'],
              currentRevision: 1,
              meaning: 'Material of product',
              multiplicity: 'SINGLE',
              name: 'Material',
              valueKind: 'CONTROLLED',
            },
          ];
        }
        if (table === productTypeAssignments) {
          return [{ productTypeId: typeId }];
        }
        if (table === productTypes) {
          return [{ currentRevision: 1 }];
        }
        if (table === productTypeRevisionAttributes) {
          return [{ requirement: 'OPTIONAL' }];
        }
        if (table === productAttributeApplicability) {
          return [{ productLevel: true, variantLevel: true }];
        }
        if (table === productVariantAxes) {
          return [];
        }
        if (table === controlledAttributeValues) {
          return [controlled];
        }
        if (table === attributeValueSets) {
          return sets.filter(
            (set) => set.productId === selectedProductId && set.variantId === (selectedVariantId ?? null),
          );
        }
        throw new Error('Unexpected persistence read');
      };
      const transaction = {
        insert: (table: FixtureTable) => ({
          values: (row: FixtureWrite | readonly FixtureWrite[]) => {
            writes.push([table, row]);
            const rows = Array.isArray(row) ? row : [row];
            if (table === attributeValueSets) {
              sets.push({
                attributeDefinitionId: definitionId,
                attributeValueSetId: `fixture-set-${sets.length + 1}`,
                currentRevision: 1,
                currentState: 'SET',
                productId: selectedProductId,
                tenantId,
                variantId: selectedVariantId ?? null,
              });
            }
            if (table === attributeValueItems) {
              items.push({
                attributeDefinitionId: definitionId,
                attributeValueSetId: 'fixture-set-1',
                controlledAttributeValueId: valueId,
                ordinal: 0,
                tenantId,
                valueKind: 'CONTROLLED',
              });
            }
            if (table === attributeValueRevisions || table === controlledAttributeValueRevisions) {
              revisions.push(...rows);
            }
            return Effect.void;
          },
        }),
        select: () => ({
          from: (table: FixtureTable) => {
            const query = {
              for: () => query,
              limit: () => Effect.succeed(rowsFor(table).slice(0, 1)),
              pipe: <A>(operation: (effect: Effect.Effect<readonly object[]>) => A): A =>
                operation(Effect.succeed(rowsFor(table))),
              where: () => query,
            };
            return query;
          },
        }),
        update: (table: FixtureTable) => ({
          set: (fields: Partial<typeof controlled>) => ({
            where: () => {
              writes.push([table, fields]);
              if (table === controlledAttributeValues) {
                Object.assign(controlled, fields);
              }
              return Effect.void;
            },
          }),
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const governance = yield* attributePersistenceForScope(transaction, scope);
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const assignments = yield* attributeValuesPersistenceForScope(transaction, scope);
      const change = (actionInvocationId: string, expectedRevision: number) => ({
        actionInvocationId,
        controlledValueRef,
        effectiveAt: new Date('2026-09-18T00:00:00.000Z'),
        evidence: 'catalog-review-1',
        expectedRevision,
        principalId,
        reason: 'Verified lifecycle change',
      });
      const assign = (productId: string, actionInvocationId: string, variantId?: string) => {
        selectedProductId = productId;
        selectedVariantId = variantId;
        const input = {
          actionInvocationId,
          attributeDefinitionRef,
          expectedRevision: null,
          principalId,
          productRef: ref('product', productId),
          reason: 'Verified material assignment',
          values: [value],
        };
        return variantId === undefined
          ? assignments.setProductValues(input)
          : assignments.setVariantOverride({
              ...input,
              classification: { evidenceRefs: ['catalog-review-1'], kind: 'NON_MATERIAL', reason: input.reason },
              variantRef: ref('variant', variantId),
            });
      };
      const original = yield* assign(p1, 'assign-p1');
      expect(original.state).toBe('SET');
      expect(writes).toContainEqual([
        attributeValueItems,
        [expect.objectContaining({ controlledAttributeValueId: valueId })],
      ]);
      expect(items).toEqual([expect.objectContaining({ controlledAttributeValueId: valueId })]);
      yield* governance.renameControlledValue({
        ...change('rename-v1', 1),
        name: 'Stainless steel',
        sameMeaning: true,
      });
      expect(controlled).toMatchObject({
        controlledAttributeValueId: valueId,
        currentRevision: 2,
        name: 'Stainless steel',
      });
      expect(revisions[0]).toMatchObject({ valueSnapshot: expect.objectContaining({ values: [value] }) });
      yield* governance.retireControlledValue(change('retire-v1', 2));
      expect(controlled).toMatchObject({
        controlledAttributeValueId: valueId,
        currentRevision: 3,
        lifecycleState: 'RETIRED',
      });
      expect(sets).toEqual([expect.objectContaining({ currentState: 'SET', productId: p1 })]);
      expect(items).toEqual([expect.objectContaining({ controlledAttributeValueId: valueId })]);
      const beforeRejected = writes.length;
      expect(yield* assign(p2, 'assign-p2-retired').pipe(Effect.flip)).toMatchObject({
        conflict: 'CONTROLLED_RETIRED',
      });
      expect(yield* assign(p2, 'assign-v2-retired', v2).pipe(Effect.flip)).toMatchObject({
        conflict: 'CONTROLLED_RETIRED',
      });
      expect(writes).toHaveLength(beforeRejected);
      yield* governance.reactivateControlledValue({ ...change('reactivate-v1', 3), currentMeaningConfirmed: true });
      expect(controlled).toMatchObject({
        controlledAttributeValueId: valueId,
        currentRevision: 4,
        lifecycleState: 'ACTIVE',
      });
      const activeProductValue = yield* assign(p2, 'assign-p2-active');
      expect(activeProductValue.state).toBe('SET');
      expect(activeProductValue.affectedVariantRefs).toEqual([expect.objectContaining({ resourceId: v2, tenantId })]);
      expect((yield* assign(p2, 'assign-v2-active', v2)).state).toBe('SET');
      expect(writes.every(([table]) => table !== products && table !== productVariants)).toBe(true);
      expect(sets[0]).toMatchObject({ currentState: 'SET', productId: p1 });
    }),
  );
});

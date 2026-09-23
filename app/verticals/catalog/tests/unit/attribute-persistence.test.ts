import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  AttributePersistenceConflict,
  attributePersistenceForScope,
  deriveAttributeImpact,
  mapAttributeWriteError,
} from '../../src/persistence/attribute-persistence.ts';
import type { AttributeRuleProposal } from '../../src/persistence/attribute-persistence.ts';
import {
  CartOpenSelectionPopulationEvidenceSchema,
  CartOpenSelectionPopulationUnavailable,
} from '../../shared/domain/catalog-open-selection-population.ts';
import type {
  CartOpenSelectionPopulationEvidence,
  CartOpenSelectionPopulationPort,
} from '../../shared/domain/catalog-open-selection-population.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';
import {
  attributeDefinitionRevisions,
  attributeDefinitions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
} from '../../src/database/schema.ts';
import type {
  productTypeRevisionAttributes,
  productTypes,
  productVariantAxes,
  productVariants,
} from '../../src/database/schema.ts';

describe('Attribute persistence error boundary', () => {
  it('classifies only exact owned identity and invocation constraints', () => {
    for (const constraint of [
      'attribute_definitions_pkey',
      'controlled_attribute_values_pkey',
      'catalog_attribute_definitions_scope_id_uk',
      'catalog_controlled_values_scope_id_uk',
    ]) {
      expect(mapAttributeWriteError({ code: '23505', constraint })).toMatchObject({ conflict: 'IDENTITY' });
    }
    for (const constraint of [
      'catalog_attribute_definition_revisions_invocation_uk',
      'catalog_controlled_value_revisions_invocation_uk',
    ]) {
      expect(mapAttributeWriteError({ code: '23505', constraint })).toMatchObject({
        conflict: 'ACTION_INVOCATION_ID',
      });
    }
  });

  it('fails closed for unrelated and indeterminate driver failures', () => {
    for (const error of [
      { code: '23505', constraint: 'foreign_constraint' },
      { code: '08006', constraint: 'attribute_definitions_pkey' },
      new Error('duplicate attribute'),
    ]) {
      const mapped = mapAttributeWriteError(error);
      expect(Schema.is(AttributePersistenceConflict)(mapped)).toBe(false);
      expect(Schema.is(CatalogPersistenceUnavailable)(mapped)).toBe(true);
      expect(mapped.cause).toBe(error);
    }
  });
});

describe('Attribute current impact', () => {
  it('distinguishes direct Product and Variant references from inherited values', () => {
    const sets = [
      { attributeValueSetId: 'p1', currentState: 'SET', productId: 'product-1', variantId: null },
      { attributeValueSetId: 'v2', currentState: 'SET', productId: 'product-1', variantId: 'variant-2' },
      { attributeValueSetId: 'p2', currentState: 'SET', productId: 'product-2', variantId: null },
      { attributeValueSetId: 'v4', currentState: 'REMOVED', productId: 'product-2', variantId: 'variant-4' },
    ];
    const impact = deriveAttributeImpact({
      axisProductIds: ['product-1'],
      controlledValueId: 'steel',
      items: [
        { attributeValueSetId: 'p1', controlledAttributeValueId: 'steel' },
        { attributeValueSetId: 'v2', controlledAttributeValueId: 'aluminium' },
        { attributeValueSetId: 'p2', controlledAttributeValueId: 'steel' },
      ],
      productTypeIds: ['type-1'],
      sets,
      variants: [
        { productId: 'product-1', variantId: 'variant-1' },
        { productId: 'product-1', variantId: 'variant-2' },
        { productId: 'product-2', variantId: 'variant-3' },
        { productId: 'product-2', variantId: 'variant-4' },
      ],
    });
    expect(impact).toEqual({
      directProducts: ['product-1', 'product-2'],
      directVariants: [],
      inheritedVariants: ['variant-1', 'variant-3', 'variant-4'],
      productTypes: ['type-1'],
      variantAxisProducts: ['product-1'],
    });
  });

  it('includes direct variant facts for a definition without merging overridden inheritance', () => {
    expect(
      deriveAttributeImpact({
        axisProductIds: [],
        items: [],
        productTypeIds: [],
        sets: [
          { attributeValueSetId: 'product-set', currentState: 'SET', productId: 'product', variantId: null },
          { attributeValueSetId: 'variant-set', currentState: 'SET', productId: 'product', variantId: 'variant-2' },
        ],
        variants: [
          { productId: 'product', variantId: 'variant-1' },
          { productId: 'product', variantId: 'variant-2' },
        ],
      }),
    ).toMatchObject({
      directProducts: ['product'],
      directVariants: ['variant-2'],
      inheritedVariants: ['variant-1'],
    });
  });
});

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const definitionId = '33333333-3333-4333-8333-333333333333';
const setId = '44444444-4444-4444-8444-444444444444';
const productId = '55555555-5555-4555-8555-555555555555';
const secondProductId = '66666666-6666-4666-8666-666666666666';
const secondSetId = '77777777-7777-4777-8777-777777777777';
const typeId = '88888888-8888-4888-8888-888888888888';
const variantId = '99999999-9999-4999-8999-999999999999';
const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:attribute-unit-change:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'attribute-unit-change-test',
};
const definitionRef = {
  moduleId: 'commerce.catalog',
  resourceId: definitionId,
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;

interface DefinitionFixture {
  allowsNone: number;
  allowsNotApplicable: number;
  allowsUnknown: number;
  applicableLevels: readonly string[];
  attributeDefinitionId: string;
  canonicalUnit: string | null;
  controlledValueKind: string | null;
  currentRevision: number;
  decimalPlaces: number | null;
  maximumValue: string | null;
  meaning: string;
  measuredQuantity: string | null;
  minimumValue: string | null;
  multiplicity: string;
  name: string;
  tenantId: string;
  valueKind: string;
}

const measurementDefinition = (): DefinitionFixture => ({
  allowsNone: 0,
  allowsNotApplicable: 0,
  allowsUnknown: 1,
  applicableLevels: ['PRODUCT'],
  attributeDefinitionId: definitionId,
  canonicalUnit: 'cm',
  controlledValueKind: null,
  currentRevision: 1,
  decimalPlaces: 2,
  maximumValue: null,
  meaning: 'Width of product',
  measuredQuantity: 'length',
  minimumValue: null,
  multiplicity: 'SINGLE',
  name: 'Width',
  tenantId,
  valueKind: 'MEASUREMENT',
});

const textDefinition = (): DefinitionFixture => ({
  ...measurementDefinition(),
  canonicalUnit: null,
  decimalPlaces: null,
  meaning: 'Material of product',
  measuredQuantity: null,
  name: 'Material',
  valueKind: 'TEXT',
});

const valueSet = (product: string, set: string) => ({
  attributeDefinitionId: definitionId,
  attributeValueSetId: set,
  currentRevision: 1,
  currentState: 'SET',
  productId: product,
  tenantId,
  variantId: null,
});

const measurementRevision = (
  set: string,
  options: { readonly amount?: number; readonly evidenceRefs?: readonly string[]; readonly unit?: string } = {},
) => ({
  actingPrincipalId: principalId,
  actionInvocationId: `${set}-initial`,
  attributeValueSetId: set,
  changeKind: 'SET',
  evidenceRefs: [...(options.evidenceRefs ?? ['supplier-sheet'])],
  reason: 'Initial recorded width',
  revision: 1,
  tenantId,
  valueSnapshot: {
    attributeDefinitionRevision: 1,
    classification: null,
    productTypeId: typeId,
    productTypeRevision: 1,
    sourceProductValueRevision: null,
    values: [{ amount: options.amount ?? 80, kind: 'MEASUREMENT', unit: options.unit ?? 'cm' }],
  },
});

const textRevision = (set: string) => ({
  actingPrincipalId: principalId,
  actionInvocationId: `${set}-initial`,
  attributeValueSetId: set,
  changeKind: 'SET',
  evidenceRefs: ['supplier-sheet'],
  reason: 'Initial recorded material',
  revision: 1,
  tenantId,
  valueSnapshot: {
    attributeDefinitionRevision: 1,
    classification: null,
    productTypeId: typeId,
    productTypeRevision: 1,
    sourceProductValueRevision: null,
    values: [{ kind: 'TEXT', text: 'steel' }],
  },
});

const millimetreProposal: AttributeRuleProposal = {
  levels: ['PRODUCT'],
  measurement: { canonicalUnit: 'mm', decimalPlaces: 2, quantity: 'length' },
  multiplicity: 'SINGLE',
  specialStates: ['UNKNOWN'],
};
const inchProposal: AttributeRuleProposal = {
  ...millimetreProposal,
  measurement: { canonicalUnit: 'in', decimalPlaces: 2, quantity: 'length' },
};
const textProposal: AttributeRuleProposal = {
  levels: ['PRODUCT'],
  multiplicity: 'SINGLE',
  specialStates: [],
};

const decodePopulation = Schema.decodeUnknownSync(CartOpenSelectionPopulationEvidenceSchema);
const populationWith = (selectionIds: readonly string[]): CartOpenSelectionPopulationEvidence =>
  decodePopulation({
    complete: true,
    observedAt: '2026-09-18T12:00:00.000Z',
    revisionToken: 'cart-population-1',
    selections: selectionIds.map((selectionId) => ({
      selection: { productRef, variantRef },
      selectionId,
    })),
    tenantId,
  });

type FixtureTable =
  | typeof attributeDefinitionRevisions
  | typeof attributeDefinitions
  | typeof attributeValueItems
  | typeof attributeValueRevisions
  | typeof attributeValueSets
  | typeof productTypeRevisionAttributes
  | typeof productTypes
  | typeof productVariantAxes
  | typeof productVariants;

interface RevisionScenarioOptions {
  readonly definition?: DefinitionFixture;
  readonly missingPort?: boolean;
  readonly populationRead?: Effect.Effect<CartOpenSelectionPopulationEvidence, CartOpenSelectionPopulationUnavailable>;
  readonly revisions?: readonly object[];
  readonly sets?: readonly object[];
}

interface RevisionStores {
  readonly definition: DefinitionFixture;
  readonly definitionRevisions: object[];
  readonly deletes: FixtureTable[];
  readonly items: object[];
  readonly migratedInvocationIds: string[];
  readonly revisions: object[];
  readonly sets: object[];
  readonly updates: [FixtureTable, object][];
}

type FixtureWrite =
  | typeof attributeValueItems.$inferInsert
  | typeof attributeValueRevisions.$inferInsert
  | typeof attributeDefinitionRevisions.$inferInsert
  | readonly (typeof attributeValueItems.$inferInsert)[];

type FixtureUpdate =
  | Partial<typeof attributeValueSets.$inferInsert>
  | Partial<typeof attributeDefinitions.$inferInsert>;

const buildTransaction = (stores: RevisionStores) => {
  let revisionReadIndex = 0;
  const rowsFor = (table: FixtureTable): readonly object[] => {
    if (table === attributeDefinitions) {
      return [stores.definition];
    }
    if (table === attributeValueSets) {
      return stores.sets;
    }
    if (table === attributeValueRevisions) {
      return stores.revisions;
    }
    if (table === attributeValueItems) {
      return stores.items;
    }
    return [];
  };
  const sliceRows = (table: FixtureTable, count: number) =>
    Effect.sync(() => {
      if (table !== attributeValueRevisions) {
        return rowsFor(table).slice(0, count);
      }
      const rows = rowsFor(table).slice(revisionReadIndex, revisionReadIndex + count);
      revisionReadIndex += count;
      return rows;
    });
  const terminal = (table: FixtureTable) =>
    Object.assign(
      Effect.sync(() => rowsFor(table)),
      {
        for: () => ({ limit: (count: number) => sliceRows(table, count) }),
        limit: (count: number) => sliceRows(table, count),
      },
    );
  return {
    delete: (table: FixtureTable) => ({
      where: () => {
        stores.deletes.push(table);
        return Effect.void;
      },
    }),
    insert: (table: FixtureTable) => ({
      values: (row: FixtureWrite) => {
        if (table === attributeValueItems && Array.isArray(row)) {
          stores.items.push(...row);
        } else if (table === attributeValueRevisions || table === attributeDefinitionRevisions) {
          (table === attributeValueRevisions ? stores.revisions : stores.definitionRevisions).push(row);
          if (table === attributeValueRevisions && !Array.isArray(row) && 'actionInvocationId' in row) {
            stores.migratedInvocationIds.push(row.actionInvocationId);
          }
        }
        return Effect.void;
      },
    }),
    select: () => ({ from: (table: FixtureTable) => ({ where: () => terminal(table) }) }),
    update: (table: FixtureTable) => ({
      set: (fields: FixtureUpdate) => ({
        where: () => {
          stores.updates.push([table, fields]);
          return Effect.void;
        },
      }),
    }),
  };
};

const revisionInput = (
  options: {
    readonly expectedRevision?: number;
    readonly proposed?: AttributeRuleProposal;
  } = {},
) => ({
  actionInvocationId: invocationId,
  attributeDefinitionRef: definitionRef,
  effectiveAt: new Date('2026-09-18T00:00:00.000Z'),
  evidence: 'Rule change reviewed',
  evidenceRefs: ['Rule change reviewed'],
  expectedRevision: options.expectedRevision ?? 1,
  principalId,
  proposed: options.proposed ?? millimetreProposal,
  reason: 'Recorded conversion',
  sameMeaning: true as const,
});

const revisionScenario = (options: RevisionScenarioOptions = {}) =>
  Effect.gen(function* revisionScenarioEffect() {
    const stores: RevisionStores = {
      definition: options.definition ?? measurementDefinition(),
      definitionRevisions: [],
      deletes: [],
      items: [],
      migratedInvocationIds: [],
      revisions: [...(options.revisions ?? [measurementRevision(setId)])],
      sets: [...(options.sets ?? [valueSet(productId, setId)])],
      updates: [],
    };
    const transaction = buildTransaction(stores);
    const authoritativeBasis =
      options.missingPort === true
        ? undefined
        : {
            openSelections: {
              read: () => options.populationRead ?? Effect.succeed(populationWith([])),
            } satisfies CartOpenSelectionPopulationPort,
          };
    // @ts-expect-error Only the exercised Drizzle query chains are mocked.
    const persistence = yield* attributePersistenceForScope(transaction, scope, authoritativeBasis);
    return { persistence, stores };
  });

describe('Attribute rule revision value migration (#434)', () => {
  it.effect('converts one recorded measured value exactly and appends a new accepted revision', () =>
    Effect.gen(function* exactConversion() {
      const { persistence, stores } = yield* revisionScenario();
      const result = yield* persistence.reviseDefinitionRules(revisionInput());
      expect(result).toMatchObject({ changed: true, revision: 2 });
      expect(stores.deletes).toContain(attributeValueItems);
      expect(stores.items).toEqual([
        expect.objectContaining({ numericValue: '800', unit: 'mm', valueKind: 'MEASUREMENT' }),
      ]);
      expect(stores.updates).toContainEqual([attributeValueSets, expect.objectContaining({ currentRevision: 2 })]);
      expect(stores.updates).toContainEqual([
        attributeDefinitions,
        expect.objectContaining({ canonicalUnit: 'mm', currentRevision: 2 }),
      ]);
      expect(stores.revisions).toHaveLength(2);
      expect(stores.revisions[0]).toMatchObject({
        revision: 1,
        valueSnapshot: { values: [{ amount: 80, kind: 'MEASUREMENT', unit: 'cm' }] },
      });
      expect(stores.revisions[1]).toMatchObject({
        revision: 2,
        valueSnapshot: {
          attributeDefinitionRevision: 2,
          values: [{ amount: 800, kind: 'MEASUREMENT', unit: 'mm' }],
        },
      });
      expect(stores.definitionRevisions).toHaveLength(1);
      expect(stores.definitionRevisions[0]).toMatchObject({ canonicalUnit: 'mm', name: 'Width', revision: 2 });
    }),
  );

  it.effect('refuses to reinterpret an unproven unit change and returns typed remediation', () =>
    Effect.gen(function* unprovenConversion() {
      const { persistence, stores } = yield* revisionScenario();
      const failure = yield* persistence
        .reviseDefinitionRules(revisionInput({ proposed: inchProposal }))
        .pipe(Effect.flip);
      expect(Schema.is(AttributePersistenceConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({
        conflict: 'REMEDIATION_REQUIRED',
        remediation: { kind: 'REMEDIATION_REQUIRED', subjects: [productId] },
      });
      expect(stores.items).toEqual([]);
      expect(stores.revisions).toHaveLength(1);
      expect(stores.definitionRevisions).toEqual([]);
      expect(stores.updates).toEqual([]);
    }),
  );

  it.effect('atomically converts every exactly convertible shared value and preserves prior snapshots', () =>
    Effect.gen(function* sharedConversion() {
      const { persistence, stores } = yield* revisionScenario({
        revisions: [measurementRevision(setId), measurementRevision(secondSetId, { amount: 90 })],
        sets: [valueSet(productId, setId), valueSet(secondProductId, secondSetId)],
      });
      const result = yield* persistence.reviseDefinitionRules(revisionInput());
      expect(result).toMatchObject({ changed: true, revision: 2 });
      expect(stores.items).toEqual([
        expect.objectContaining({
          attributeValueSetId: setId,
          numericValue: '800',
          unit: 'mm',
        }),
        expect.objectContaining({
          attributeValueSetId: secondSetId,
          numericValue: '900',
          unit: 'mm',
        }),
      ]);
      expect(stores.revisions).toHaveLength(4);
      expect(stores.revisions.slice(0, 2)).toMatchObject([
        { revision: 1, valueSnapshot: { values: [{ amount: 80, kind: 'MEASUREMENT', unit: 'cm' }] } },
        { revision: 1, valueSnapshot: { values: [{ amount: 90, kind: 'MEASUREMENT', unit: 'cm' }] } },
      ]);
      expect(stores.revisions.slice(2)).toMatchObject([
        {
          attributeValueSetId: setId,
          revision: 2,
          valueSnapshot: { attributeDefinitionRevision: 2, values: [{ amount: 800, unit: 'mm' }] },
        },
        {
          attributeValueSetId: secondSetId,
          revision: 2,
          valueSnapshot: { attributeDefinitionRevision: 2, values: [{ amount: 900, unit: 'mm' }] },
        },
      ]);
      expect(new Set(stores.migratedInvocationIds).size).toBe(2);
      expect(stores.migratedInvocationIds).not.toContain(invocationId);
      expect(stores.definitionRevisions).toHaveLength(1);
    }),
  );

  it.effect('writes nothing when any subject in a shared unit change needs remediation', () =>
    Effect.gen(function* sharedRemediation() {
      const { persistence, stores } = yield* revisionScenario({
        revisions: [measurementRevision(setId), measurementRevision(secondSetId, { amount: 90, evidenceRefs: [] })],
        sets: [valueSet(productId, setId), valueSet(secondProductId, secondSetId)],
      });
      const failure = yield* persistence.reviseDefinitionRules(revisionInput()).pipe(Effect.flip);
      expect(failure).toMatchObject({
        conflict: 'REMEDIATION_REQUIRED',
        remediation: { kind: 'INDETERMINATE', subjects: [secondProductId] },
      });
      expect(stores.items).toEqual([]);
      expect(stores.deletes).toEqual([]);
      expect(stores.revisions).toHaveLength(2);
      expect(stores.definitionRevisions).toEqual([]);
      expect(stores.updates).toEqual([]);
    }),
  );

  it.effect('keeps definition identity for a same-meaning TEXT rule revision without rewriting values', () =>
    Effect.gen(function* nonMeasurementRevision() {
      const { persistence, stores } = yield* revisionScenario({
        definition: textDefinition(),
        revisions: [textRevision(setId)],
      });
      const result = yield* persistence.reviseDefinitionRules(revisionInput({ proposed: textProposal }));
      expect(result).toMatchObject({ changed: true, revision: 2 });
      expect(stores.definitionRevisions).toHaveLength(1);
      expect(stores.definitionRevisions[0]).toMatchObject({ applicableLevels: ['PRODUCT'], revision: 2 });
      expect(stores.revisions).toHaveLength(1);
      expect(stores.items).toEqual([]);
    }),
  );

  it.effect('blocks the migration while the injected Cart population holds an impacted open selection', () =>
    Effect.gen(function* openSelectionImpact() {
      const { persistence, stores } = yield* revisionScenario({
        populationRead: Effect.succeed(populationWith(['cart-selection-1'])),
      });
      const failure = yield* persistence.reviseDefinitionRules(revisionInput()).pipe(Effect.flip);
      expect(Schema.is(AttributePersistenceConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'REMEDIATION_REQUIRED' });
      expect(stores.definitionRevisions).toEqual([]);
    }),
  );

  it.effect('fails closed without the injected Cart open-selection owner contract', () =>
    Effect.gen(function* missingPort() {
      const { persistence } = yield* revisionScenario({ missingPort: true });
      const failure = yield* persistence.reviseDefinitionRules(revisionInput()).pipe(Effect.flip);
      expect(Schema.is(AttributePersistenceConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'OPEN_SELECTION_IMPACT_UNAVAILABLE' });
    }),
  );

  it.effect('fails closed when the injected Cart population read is unavailable', () =>
    Effect.gen(function* unavailablePopulation() {
      const { persistence } = yield* revisionScenario({
        populationRead: Effect.fail(
          new CartOpenSelectionPopulationUnavailable({
            code: 'cart_open_selection_population_unavailable',
            reason: 'Cart is unavailable',
          }),
        ),
      });
      const failure = yield* persistence.reviseDefinitionRules(revisionInput()).pipe(Effect.flip);
      expect(Schema.is(AttributePersistenceConflict)(failure)).toBe(true);
      expect(failure).toMatchObject({ conflict: 'OPEN_SELECTION_IMPACT_UNAVAILABLE' });
    }),
  );
});

import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  attributeDefinitions,
  attributeDefinitionRevisions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  controlledAttributeValues,
  controlledAttributeValueRevisions,
  productAttributeApplicability,
  productAttributeApplicabilityRevisions,
  productTypeAssignments,
  productTypeRevisionAttributes,
  productTypeRevisions,
  productTypes,
  productVariants,
  products,
} from '../../src/database/schema.ts';
import { effectiveAttributeValueReadsForScope } from '../../src/persistence/effective-attribute-value-reads.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const definitionId = '55555555-5555-4555-8555-555555555555';
const productSetId = '66666666-6666-4666-8666-666666666666';
const variantSetId = '77777777-7777-4777-8777-777777777777';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:effective-value-test:run:1',
    authMethod: 'system',
    principalId: '99999999-9999-4999-8999-999999999999',
    tenantId,
  }),
  correlationId: 'effective-value-test',
};
const input = {
  attributeDefinitionRef: {
    moduleId: 'commerce.catalog',
    resourceId: definitionId,
    resourceType: 'commerce.catalog.attribute-definition',
    tenantId,
  },
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: productId,
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: variantId,
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
} as const;
interface SetFixture {
  readonly attributeDefinitionId: string;
  readonly attributeValueSetId: string;
  readonly currentRevision: number;
  readonly currentState: 'SET' | 'REMOVED';
  readonly productId: string;
  readonly tenantId: string;
  readonly variantId: string | null;
}
const productSet: SetFixture = {
  attributeDefinitionId: definitionId,
  attributeValueSetId: productSetId,
  currentRevision: 4,
  currentState: 'SET',
  productId,
  tenantId,
  variantId: null,
};
const variantSet: SetFixture = {
  attributeDefinitionId: definitionId,
  attributeValueSetId: variantSetId,
  currentRevision: 2,
  currentState: 'SET',
  productId,
  tenantId,
  variantId,
};

type QueryTable =
  | typeof products
  | typeof productVariants
  | typeof attributeDefinitions
  | typeof attributeDefinitionRevisions
  | typeof productTypeAssignments
  | typeof productTypes
  | typeof productTypeRevisions
  | typeof productTypeRevisionAttributes
  | typeof productAttributeApplicability
  | typeof productAttributeApplicabilityRevisions
  | typeof attributeValueSets
  | typeof attributeValueRevisions
  | typeof attributeValueItems
  | typeof controlledAttributeValues
  | typeof controlledAttributeValueRevisions;

const queryResult = (result: ReturnType<(table: QueryTable) => readonly object[]>) =>
  Object.assign(Effect.succeed(result), { limit: () => Effect.succeed(result), orderBy: () => Effect.succeed(result) });

const valueItemRows = (
  set: SetFixture | undefined,
  value: string | undefined,
  specialState: 'UNKNOWN' | 'NONE' | 'NOT_APPLICABLE' | undefined,
  malformedItem = false,
) =>
  value === undefined && specialState === undefined
    ? []
    : [
        {
          attributeDefinitionId: definitionId,
          attributeValueSetId: malformedItem ? variantSetId : set?.attributeValueSetId,
          ordinal: 0,
          specialState: specialState ?? null,
          tenantId,
          textValue: specialState === undefined ? value : null,
          valueKind: specialState === undefined ? 'TEXT' : 'SPECIAL',
        },
      ];

const serviceWith = (
  sets: readonly SetFixture[],
  texts: Readonly<Record<string, string>>,
  options: {
    readonly applicabilityProductLevel?: boolean;
    readonly applicabilityVariantLevel?: boolean;
    readonly malformedDefinitionRevision?: boolean;
    readonly malformedItem?: boolean;
    readonly malformedRevision?: boolean;
    readonly malformedValueSnapshot?: boolean;
    readonly malformedValueSnapshotSetId?: string;
    readonly missingApplicabilityRevision?: boolean;
    readonly retiredControlledValue?: boolean;
    readonly specialState?: 'UNKNOWN' | 'NONE' | 'NOT_APPLICABLE';
    readonly staleSnapshotDefinitionRevision?: boolean;
    readonly wrongProductSubject?: boolean;
  } = {},
) => {
  const queried: QueryTable[] = [];
  let revisionReads = 0;
  let itemReads = 0;
  const revisionRows = () => {
    const set = sets[revisionReads];
    revisionReads += 1;
    if (set === undefined) {
      return [];
    }
    const currentText = texts[set.attributeValueSetId];
    const revisionValues = [];
    if (options.specialState !== undefined) {
      revisionValues.push({ kind: 'SPECIAL', state: options.specialState });
    } else if (options.retiredControlledValue === true) {
      revisionValues.push({
        kind: 'CONTROLLED',
        valueRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          resourceType: 'commerce.catalog.controlled-attribute-value',
          tenantId,
        },
      });
    } else if (currentText !== undefined) {
      revisionValues.push({ kind: 'TEXT', text: currentText });
    }
    return [
      {
        attributeValueSetId: options.malformedRevision === true ? variantSetId : set.attributeValueSetId,
        changeKind: set.currentState,
        revision: set.currentRevision,
        tenantId,
        valueSnapshot: {
          attributeDefinitionRevision: options.staleSnapshotDefinitionRevision === true ? 1 : 2,
          productTypeId: '88888888-8888-4888-8888-888888888888',
          productTypeRevision: 3,
          sourceProductValueRevision: null,
          values:
            options.malformedValueSnapshot === true || options.malformedValueSnapshotSetId === set.attributeValueSetId
              ? [{ kind: 'TEXT', text: 'wrong' }]
              : revisionValues,
        },
      },
    ];
  };
  const authorityRows = (table: QueryTable): readonly object[] | undefined => {
    if (table === products) {
      return [
        { lifecycleState: 'ACTIVE', productId: options.wrongProductSubject === true ? variantId : productId, tenantId },
      ];
    }
    if (table === productVariants) {
      return [{ lifecycleState: 'ACTIVE', productId, tenantId, variantId }];
    }
    if (table === attributeDefinitions || table === attributeDefinitionRevisions) {
      return [
        {
          allowsNone: 1,
          allowsNotApplicable: 1,
          allowsUnknown: 1,
          applicableLevels: ['PRODUCT', 'VARIANT'],
          canonicalUnit: null,
          controlledValueKind: options.retiredControlledValue === true ? 'GENERAL' : null,
          currentRevision: 2,
          decimalPlaces: null,
          maximumValue: null,
          meaning: 'Product material',
          measuredQuantity: null,
          minimumValue: null,
          multiplicity: 'SINGLE',
          name:
            table === attributeDefinitionRevisions && options.malformedDefinitionRevision === true
              ? 'Other meaning'
              : 'Material',
          valueKind: options.retiredControlledValue === true ? 'CONTROLLED' : 'TEXT',
        },
      ];
    }
    if (table === productAttributeApplicability) {
      return [
        {
          attributeDefinitionId: definitionId,
          currentRevision: 2,
          productId,
          productLevel: options.applicabilityProductLevel ?? true,
          tenantId,
          variantLevel: options.applicabilityVariantLevel ?? true,
        },
      ];
    }
    if (table === productAttributeApplicabilityRevisions) {
      return options.missingApplicabilityRevision === true
        ? []
        : [
            {
              attributeDefinitionId: definitionId,
              productId,
              productLevel: options.applicabilityProductLevel ?? true,
              revision: 2,
              tenantId,
              variantLevel: options.applicabilityVariantLevel ?? true,
            },
          ];
    }
    return undefined;
  };
  const rows = (table: QueryTable) => {
    const authority = authorityRows(table);
    if (authority !== undefined) {
      return authority;
    }
    if (table === productTypeAssignments) {
      return [{ productTypeId: '88888888-8888-4888-8888-888888888888' }];
    }
    if (table === productTypes) {
      return [{ currentRevision: 3 }];
    }
    if (table === productTypeRevisions) {
      return [
        {
          effectiveAt: new Date('1960-01-01T00:00:00.000Z'),
          productTypeRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          revision: 3,
        },
      ];
    }
    if (table === productTypeRevisionAttributes) {
      return [
        { level: 'PRODUCT', requirement: 'OPTIONAL' },
        { level: 'VARIANT', requirement: 'OPTIONAL' },
      ];
    }
    if (table === attributeValueSets) {
      return sets;
    }
    if (table === attributeValueRevisions) {
      return revisionRows();
    }
    if (table === attributeValueItems) {
      const set = sets[itemReads];
      itemReads += 1;
      const value = set === undefined ? undefined : texts[set.attributeValueSetId];
      if (options.retiredControlledValue === true) {
        return [
          {
            attributeDefinitionId: definitionId,
            attributeValueSetId: set?.attributeValueSetId,
            controlledAttributeValueId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            ordinal: 0,
            tenantId,
            valueKind: 'CONTROLLED',
          },
        ];
      }
      return valueItemRows(set, value, options.specialState, options.malformedItem);
    }
    if (table === controlledAttributeValues) {
      return [
        {
          attributeDefinitionId: definitionId,
          controlledAttributeValueId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          currentRevision: 1,
          lifecycleState: 'RETIRED',
          specialization: 'GENERAL',
          tenantId,
        },
      ];
    }
    if (table === controlledAttributeValueRevisions) {
      return [
        {
          attributeDefinitionId: definitionId,
          lifecycleState: 'RETIRED',
          revision: 1,
          specialization: 'GENERAL',
          tenantId,
        },
      ];
    }
    return [];
  };
  const transaction = {
    select: () => ({
      from: (table: QueryTable) => {
        queried.push(table);
        return { where: () => queryResult(rows(table)) };
      },
    }),
  };
  // @ts-expect-error Test transaction implements the exercised query chains only.
  return { queried, service: effectiveAttributeValueReadsForScope(transaction, scope) };
};

describe('private effective attribute value reads', () => {
  it.effect('attests the exact Current definition and all current Product value sets', () =>
    Effect.gen(function* ownerValidity() {
      const reads = yield* serviceWith([productSet], { [productSetId]: 'steel' }).service;
      expect(yield* reads.readDefinitionCurrent(input.attributeDefinitionRef)).toEqual({
        attributeDefinitionId: definitionId,
        complete: true,
        revision: 2,
        tenantId,
      });
      const basis = yield* reads.readProductTypeValidity([productId]);
      expect(basis.complete).toBe(true);
      expect(basis.entries).toMatchObject([
        {
          attributeValueSetId: productSetId,
          confirmsRequiredFact: true,
          currentState: 'SET',
          definitionRevision: 2,
          revision: 4,
          valid: true,
        },
      ]);
    }),
  );

  for (const specialState of ['UNKNOWN', 'NONE', 'NOT_APPLICABLE'] as const) {
    it.effect(`keeps allowed ${specialState} structurally valid without confirming a required fact`, () =>
      Effect.gen(function* specialValue() {
        const reads = yield* serviceWith([productSet], {}, { specialState }).service;
        const basis = yield* reads.readProductTypeValidity([productId]);
        expect(basis.complete).toBe(true);
        expect(basis.entries).toMatchObject([{ confirmsRequiredFact: false, valid: true }]);
      }),
    );
  }

  it.effect('does not attest a mismatched immutable definition revision', () =>
    Effect.gen(function* mismatchedDefinition() {
      const reads = yield* serviceWith([productSet], { [productSetId]: 'steel' }, { malformedDefinitionRevision: true })
        .service;
      expect((yield* reads.readDefinitionCurrent(input.attributeDefinitionRef)).complete).toBe(false);
      expect((yield* reads.readProductTypeValidity([productId])).complete).toBe(false);
    }),
  );
  it.effect('does not attest a Current set that differs from its immutable revision', () =>
    Effect.gen(function* mismatchedValueRevision() {
      const reads = yield* serviceWith([productSet], { [productSetId]: 'steel' }, { malformedValueSnapshot: true })
        .service;
      expect((yield* reads.readProductTypeValidity([productId])).complete).toBe(false);
    }),
  );
  it.effect('does not attest an empty set labelled SET', () =>
    Effect.gen(function* emptySet() {
      const reads = yield* serviceWith([productSet], {}).service;
      expect((yield* reads.readProductTypeValidity([productId])).complete).toBe(false);
    }),
  );
  it.effect('rejects foreign references before querying', () =>
    Effect.gen(function* foreignReferences() {
      const { queried, service } = serviceWith([], {});
      const reads = yield* service;
      const result = yield* reads.resolveVariant({
        ...input,
        variantRef: { ...input.variantRef, tenantId: '22222222-2222-4222-8222-222222222222' },
      });
      expect(result.status).toBe('INVALID_AUTHORITY');
      expect(queried).toEqual([]);
    }),
  );

  it.effect('inherits a persisted Product value and reports its source revision', () =>
    Effect.gen(function* inheritedValue() {
      const reads = yield* serviceWith([productSet], { [productSetId]: 'steel' }).service;
      const result = yield* reads.resolveVariant(input);
      expect(result).toMatchObject({
        productRevision: 4,
        source: { level: 'PRODUCT', revision: 4 },
        status: 'CURRENT',
        values: [{ kind: 'TEXT', text: 'steel' }],
      });
    }),
  );

  it.effect('rejects inheritance when Current Definition drifts from its immutable revision', () =>
    Effect.gen(function* driftedInheritedDefinition() {
      const reads = yield* serviceWith([productSet], { [productSetId]: 'steel' }, { malformedDefinitionRevision: true })
        .service;
      expect((yield* reads.resolveVariant(input)).status).toBe('INVALID_AUTHORITY');
    }),
  );

  it.effect('prefers a persisted Variant override and reports both revisions', () =>
    Effect.gen(function* variantOverride() {
      const reads = yield* serviceWith([productSet, variantSet], {
        [productSetId]: 'steel',
        [variantSetId]: 'aluminium',
      }).service;
      const result = yield* reads.resolveVariant(input);
      expect(result).toMatchObject({
        productRevision: 4,
        source: { level: 'VARIANT', revision: 2 },
        status: 'CURRENT',
        values: [{ kind: 'TEXT', text: 'aluminium' }],
        variantRevision: 2,
      });
    }),
  );

  it.effect('rejects an override when Current Definition drifts from its immutable revision', () =>
    Effect.gen(function* driftedOverrideDefinition() {
      const reads = yield* serviceWith(
        [productSet, variantSet],
        { [productSetId]: 'steel', [variantSetId]: 'aluminium' },
        { malformedDefinitionRevision: true },
      ).service;
      expect((yield* reads.resolveVariant(input)).status).toBe('INVALID_AUTHORITY');
    }),
  );

  it.effect('rejects an inherited Product value that differs from its immutable snapshot', () =>
    Effect.gen(function* driftedProduct() {
      const reads = yield* serviceWith([productSet], { [productSetId]: 'steel' }, { malformedValueSnapshot: true })
        .service;
      expect((yield* reads.resolveVariant(input)).status).toBe('INVALID_AUTHORITY');
    }),
  );

  it.effect('rejects a Variant override that differs from its immutable snapshot', () =>
    Effect.gen(function* driftedVariant() {
      const reads = yield* serviceWith(
        [productSet, variantSet],
        {
          [productSetId]: 'steel',
          [variantSetId]: 'aluminium',
        },
        { malformedValueSnapshotSetId: variantSetId },
      ).service;
      expect((yield* reads.resolveVariant(input)).status).toBe('INVALID_AUTHORITY');
    }),
  );

  it.effect('accepts a valid saved value from an older Definition revision', () =>
    Effect.gen(function* staleDefinition() {
      const reads = yield* serviceWith(
        [productSet],
        { [productSetId]: 'steel' },
        {
          staleSnapshotDefinitionRevision: true,
        },
      ).service;
      expect(yield* reads.resolveVariant(input)).toMatchObject({
        source: { level: 'PRODUCT', revision: 4 },
        status: 'CURRENT',
        values: [{ kind: 'TEXT', text: 'steel' }],
      });
    }),
  );

  it.effect('ignores a sibling Variant set while resolving the requested Variant', () =>
    Effect.gen(function* siblingValue() {
      const sibling = {
        ...variantSet,
        attributeValueSetId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        variantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      };
      const reads = yield* serviceWith([productSet, sibling], { [productSetId]: 'steel' }).service;
      expect(yield* reads.resolveVariant(input)).toMatchObject({
        source: { level: 'PRODUCT', revision: 4 },
        status: 'CURRENT',
        values: [{ kind: 'TEXT', text: 'steel' }],
      });
    }),
  );

  it.effect('requires the exact current Product-local applicability declaration', () =>
    Effect.gen(function* applicability() {
      for (const options of [
        { applicabilityVariantLevel: false },
        { applicabilityProductLevel: false },
        { missingApplicabilityRevision: true },
      ]) {
        const reads = yield* serviceWith([productSet], { [productSetId]: 'steel' }, options).service;
        expect((yield* reads.resolveVariant(input)).status).toBe('INVALID_AUTHORITY');
      }
    }),
  );

  it.effect('rejects a Product row that does not identify the requested Product', () =>
    Effect.gen(function* wrongProduct() {
      const reads = yield* serviceWith([productSet], { [productSetId]: 'steel' }, { wrongProductSubject: true })
        .service;
      expect((yield* reads.resolveVariant(input)).status).toBe('INVALID_AUTHORITY');
    }),
  );

  it.effect('does not expose a retired controlled value as Current', () =>
    Effect.gen(function* retiredControlledValue() {
      const reads = yield* serviceWith([productSet], {}, { retiredControlledValue: true }).service;
      expect((yield* reads.resolveVariant(input)).status).toBe('INVALID_AUTHORITY');
      expect((yield* reads.readProductTypeValidity([productId])).complete).toBe(false);
    }),
  );

  it.effect('returns to Product inheritance after a Variant tombstone', () =>
    Effect.gen(function* removedOverride() {
      const removed = { ...variantSet, currentRevision: 3, currentState: 'REMOVED' as const };
      const reads = yield* serviceWith([productSet, removed], { [productSetId]: 'stainless steel' }).service;
      const result = yield* reads.resolveVariant(input);
      expect(result).toMatchObject({
        source: { level: 'PRODUCT', revision: 4 },
        status: 'CURRENT',
        values: [{ kind: 'TEXT', text: 'stainless steel' }],
        variantRevision: 3,
      });
    }),
  );

  it.effect('returns absence after removal when the Product has no value', () =>
    Effect.gen(function* absentAfterRemoval() {
      const removed = { ...variantSet, currentRevision: 3, currentState: 'REMOVED' as const };
      const reads = yield* serviceWith([removed], {}).service;
      expect(yield* reads.resolveVariant(input)).toMatchObject({ status: 'CURRENT', values: [], variantRevision: 3 });
    }),
  );

  it.effect('rejects a removed set that still carries value items', () =>
    Effect.gen(function* removedWithItems() {
      const removed = { ...variantSet, currentRevision: 3, currentState: 'REMOVED' as const };
      const reads = yield* serviceWith([removed], { [variantSetId]: 'stale value' }).service;
      expect((yield* reads.resolveVariant(input)).status).toBe('INVALID_AUTHORITY');
    }),
  );

  it.effect('rejects ambiguous sets and mismatched revision or item ownership', () =>
    Effect.gen(function* malformedSnapshots() {
      for (const fixture of [
        serviceWith([productSet, { ...productSet, attributeValueSetId: variantSetId }], {}),
        serviceWith([productSet], { [productSetId]: 'steel' }, { malformedRevision: true }),
        serviceWith([productSet], { [productSetId]: 'steel' }, { malformedItem: true }),
      ]) {
        const reads = yield* fixture.service;
        expect((yield* reads.resolveVariant(input)).status).toBe('INVALID_AUTHORITY');
      }
    }),
  );
});

import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { AttributeDefinitionSchema, AttributeValueSchema } from '../../shared/domain/attribute-values.ts';
import { ProductVariantSchema } from '../../shared/domain/product.ts';
import type { VariantAxisValue } from '../../shared/domain/variant-axes.ts';
import { evaluateVariantAxes, sameRef, valueKey } from '../../shared/domain/variant-axes.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const anotherProductRef = { ...productRef, resourceId: '99999999-9999-4999-8999-999999999999' } as const;
const definition = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
  label: 'Color',
  levels: ['VARIANT'],
  meaning: 'Actual color',
  multiplicity: 'SINGLE',
  ref: {
    moduleId: 'commerce.catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.catalog.attribute-definition',
    tenantId,
  },
  specialStates: ['UNKNOWN'],
  valueKind: 'CONTROLLED',
});
const variant = (id: string, owner: typeof productRef | typeof anotherProductRef = productRef, lifecycle = 'ACTIVE') =>
  Schema.decodeUnknownSync(ProductVariantSchema)({
    lifecycle,
    productRef: owner,
    variantId: id,
    variantRef: { moduleId: 'commerce.catalog', resourceId: id, resourceType: 'commerce.catalog.variant', tenantId },
  });
const white = {
  kind: 'CONTROLLED',
  valueRef: {
    moduleId: 'commerce.catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.controlled-attribute-value',
    tenantId,
  },
} as const;
const black = {
  kind: 'CONTROLLED',
  valueRef: { ...white.valueRef, resourceId: '66666666-6666-4666-8666-666666666666' },
} as const;
const values = (actual: typeof white | typeof black) =>
  [{ attributeDefinitionRef: definition.ref, values: [actual] }] as const;
const base = {
  axes: [{ attributeDefinitionRef: definition.ref, definitionRevision: 3 }],
  definitions: [{ definition, revision: 3 }],
  isAllowedValue: () => true,
  isRecordedCombination: () => true,
  productRef: variant('33333333-3333-4333-8333-333333333333').productRef,
  productTypeRules: [{ attributeDefinitionRef: definition.ref, level: 'VARIANT', required: false }] as const,
};

describe('Variant axes and exact combinations', () => {
  it('requires exact recorded-Variant evidence, not a Cartesian product of allowed axis values', () => {
    const lengthDefinition = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
      ...definition,
      label: 'Length',
      meaning: 'Actual length',
      ref: { ...definition.ref, resourceId: '88888888-8888-4888-8888-888888888888' },
    });
    const length80 = { ...white, valueRef: { ...white.valueRef, resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } };
    const length100 = { ...white, valueRef: { ...white.valueRef, resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } };
    const candidate = (id: string, color: typeof white | typeof black, length: typeof length80) => ({
      effectiveAxisValues: [
        { attributeDefinitionRef: definition.ref, values: [color] },
        { attributeDefinitionRef: lengthDefinition.ref, values: [length] },
      ],
      variant: variant(id),
    });
    const recorded = new Map([
      ['33333333-3333-4333-8333-333333333333', [white.valueRef.resourceId, length80.valueRef.resourceId]],
      ['77777777-7777-4777-8777-777777777777', [white.valueRef.resourceId, length100.valueRef.resourceId]],
      ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', [black.valueRef.resourceId, length80.valueRef.resourceId]],
    ]);
    const input = {
      ...base,
      axes: [...base.axes, { attributeDefinitionRef: lengthDefinition.ref, definitionRevision: 3 }],
      definitions: [...base.definitions, { definition: lengthDefinition, revision: 3 }],
      isRecordedCombination: (item: ReturnType<typeof variant>, selections: readonly VariantAxisValue[]) => {
        const expected = recorded.get(item.variantRef.resourceId);
        return (
          expected !== undefined &&
          selections.every((selection, index) => {
            const [value] = selection.values;
            return value?.kind === 'CONTROLLED' && value.valueRef.resourceId === expected[index];
          })
        );
      },
      productTypeRules: [
        ...base.productTypeRules,
        { attributeDefinitionRef: lengthDefinition.ref, level: 'VARIANT', required: false } as const,
      ],
    };
    expect(
      evaluateVariantAxes({
        ...input,
        candidates: [
          candidate('33333333-3333-4333-8333-333333333333', white, length80),
          candidate('77777777-7777-4777-8777-777777777777', white, length100),
          candidate('cccccccc-cccc-4ccc-8ccc-cccccccccccc', black, length80),
        ],
      }).valid,
    ).toBe(true);
    expect(
      evaluateVariantAxes({
        ...input,
        candidates: [candidate('dddddddd-dddd-4ddd-8ddd-dddddddddddd', black, length100)],
      }).issues,
    ).toContainEqual({ kind: 'UNRECORDED_COMBINATION', variantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    expect(
      evaluateVariantAxes({
        ...input,
        candidates: [candidate('33333333-3333-4333-8333-333333333333', black, length100)],
      }).issues,
    ).toContainEqual({ kind: 'UNRECORDED_COMBINATION', variantId: '33333333-3333-4333-8333-333333333333' });
    expect(
      evaluateVariantAxes({
        ...input,
        candidates: [candidate('dddddddd-dddd-4ddd-8ddd-dddddddddddd', black, length100)],
        isRecordedCombination: () => base.definitions.at(3)?.definition.levels.includes('VARIANT'),
      }).issues,
    ).toContainEqual({ kind: 'UNVERIFIABLE_COMBINATION', variantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  });
  it('allows only recorded, distinct active combinations and no Cartesian expansion', () => {
    const result = evaluateVariantAxes({
      ...base,
      candidates: [
        { effectiveAxisValues: values(white), variant: variant('33333333-3333-4333-8333-333333333333') },
        { effectiveAxisValues: values(black), variant: variant('77777777-7777-4777-8777-777777777777') },
      ],
    });
    expect(result).toEqual({ issues: [], valid: true });
  });

  it('rejects an active duplicate regardless of Variant identity and ignores retired history', () => {
    const first = { effectiveAxisValues: values(white), variant: variant('33333333-3333-4333-8333-333333333333') };
    const second = { effectiveAxisValues: values(white), variant: variant('77777777-7777-4777-8777-777777777777') };
    expect(evaluateVariantAxes({ ...base, candidates: [first, second] }).issues).toContainEqual({
      conflictingVariantId: first.variant.variantRef.resourceId,
      kind: 'DUPLICATE_COMBINATION',
      variantId: second.variant.variantRef.resourceId,
    });
    expect(
      evaluateVariantAxes({
        ...base,
        candidates: [
          first,
          { ...second, variant: variant(second.variant.variantRef.resourceId, productRef, 'RETIRED') },
        ],
      }).valid,
    ).toBe(true);
  });

  it('distinguishes missing, invalid, and unverified values', () => {
    const active = variant('33333333-3333-4333-8333-333333333333');
    expect(
      evaluateVariantAxes({ ...base, candidates: [{ effectiveAxisValues: [], variant: active }] }).issues[0]?.kind,
    ).toBe('MISSING_AXIS');
    expect(
      evaluateVariantAxes({
        ...base,
        candidates: [{ effectiveAxisValues: values(white), variant: active }],
        isAllowedValue: () => false,
      }).issues[0]?.kind,
    ).toBe('INVALID_VALUE');
    expect(
      evaluateVariantAxes({
        axes: base.axes,
        candidates: [{ effectiveAxisValues: values(white), variant: active }],
        definitions: base.definitions,
        productRef: base.productRef,
        productTypeRules: base.productTypeRules,
      }).issues[0]?.kind,
    ).toBe('UNVERIFIABLE_VALUE');
    expect(
      evaluateVariantAxes({
        ...base,
        candidates: [
          {
            effectiveAxisValues: [
              { attributeDefinitionRef: definition.ref, values: [{ kind: 'SPECIAL', state: 'UNKNOWN' }] },
            ],
            variant: active,
          },
        ],
      }).issues[0]?.kind,
    ).toBe('INVALID_VALUE');
    expect(
      evaluateVariantAxes({
        ...base,
        candidates: [{ effectiveAxisValues: values(white), variant: active }],
        isAllowedValue: () => base.definitions.at(1)?.definition.levels.includes('VARIANT'),
      }).issues[0]?.kind,
    ).toBe('UNVERIFIABLE_VALUE');
  });

  it('rejects repeated axis records and repeated values rather than treating them as absence or a new combination', () => {
    const active = variant('33333333-3333-4333-8333-333333333333');
    expect(
      evaluateVariantAxes({
        ...base,
        candidates: [{ effectiveAxisValues: [...values(white), ...values(black)], variant: active }],
      }).issues[0]?.kind,
    ).toBe('DUPLICATE_AXIS_VALUE');
    const multiple = { ...definition, multiplicity: 'MULTIPLE' as const };
    expect(
      evaluateVariantAxes({
        ...base,
        candidates: [
          {
            effectiveAxisValues: [{ attributeDefinitionRef: definition.ref, values: [white, white] }],
            variant: active,
          },
        ],
        definitions: [{ definition: multiple, revision: 3 }],
      }).issues[0]?.kind,
    ).toBe('INVALID_VALUE');
  });

  it('compares MULTIPLE values as an order-independent complete set', () => {
    const multiple = { ...definition, multiplicity: 'MULTIPLE' as const };
    const first = variant('33333333-3333-4333-8333-333333333333');
    const second = variant('77777777-7777-4777-8777-777777777777');
    expect(
      evaluateVariantAxes({
        ...base,
        candidates: [
          { effectiveAxisValues: [{ attributeDefinitionRef: definition.ref, values: [white, black] }], variant: first },
          {
            effectiveAxisValues: [{ attributeDefinitionRef: definition.ref, values: [black, white] }],
            variant: second,
          },
        ],
        definitions: [{ definition: multiple, revision: 3 }],
      }).issues,
    ).toContainEqual({
      conflictingVariantId: first.variantRef.resourceId,
      kind: 'DUPLICATE_COMBINATION',
      variantId: second.variantRef.resourceId,
    });
  });

  it('allows an axis-free singleton but detects a second indistinguishable active Variant', () => {
    const first = { effectiveAxisValues: [], variant: variant('33333333-3333-4333-8333-333333333333') };
    expect(evaluateVariantAxes({ ...base, axes: [], candidates: [first] }).valid).toBe(true);
    expect(
      evaluateVariantAxes({
        ...base,
        axes: [],
        candidates: [first, { effectiveAxisValues: [], variant: variant('77777777-7777-4777-8777-777777777777') }],
      }).issues[0]?.kind,
    ).toBe('DUPLICATE_COMBINATION');
  });

  it('keeps combinations Product-scoped and enforces axis applicability', () => {
    const other = variant('77777777-7777-4777-8777-777777777777', anotherProductRef);
    expect(
      evaluateVariantAxes({ ...base, candidates: [{ effectiveAxisValues: values(white), variant: other }] }).issues[0]
        ?.kind,
    ).toBe('WRONG_PRODUCT');
    expect(evaluateVariantAxes({ ...base, candidates: [], productTypeRules: [] }).issues[0]?.kind).toBe(
      'DISALLOWED_AXIS',
    );
  });

  it('pins axis meaning and value rules to an exact Definition revision', () => {
    const candidate = {
      effectiveAxisValues: values(white),
      variant: variant('33333333-3333-4333-8333-333333333333'),
    };
    const changedMeaning = { ...definition, meaning: 'Display color' };
    expect(
      evaluateVariantAxes({
        ...base,
        candidates: [candidate],
        definitions: [{ definition: changedMeaning, revision: 4 }],
      }).issues,
    ).toContainEqual({ attributeDefinitionId: definition.ref.resourceId, kind: 'STALE_DEFINITION' });
    expect(evaluateVariantAxes({ ...base, candidates: [candidate], definitions: [] }).issues).toContainEqual({
      attributeDefinitionId: definition.ref.resourceId,
      kind: 'MISSING_DEFINITION',
    });
  });

  it('compares a Definition reference by full ResourceRef identity, not Tenant and identifier alone', () => {
    expect(sameRef(definition.ref, { ...definition.ref })).toBe(true);
    expect(sameRef(definition.ref, { ...definition.ref, resourceType: 'commerce.catalog.product' })).toBe(false);
    expect(sameRef(definition.ref, { ...definition.ref, resourceId: '77777777-7777-4777-8777-777777777777' })).toBe(
      false,
    );
    // @ts-expect-error A foreign module identity can still share Tenant and identifier.
    expect(sameRef(definition.ref, { ...definition.ref, moduleId: 'commerce.pricing' })).toBe(false);
  });

  it('keys controlled values by full ResourceRef identity, not Tenant and identifier alone', () => {
    expect(valueKey(white)).not.toBe(
      valueKey({ ...white, valueRef: { ...white.valueRef, resourceType: 'commerce.catalog.product' } }),
    );
    expect(valueKey(white)).not.toBe(
      valueKey({ ...white, valueRef: { ...white.valueRef, resourceId: '99999999-9999-4999-8999-999999999999' } }),
    );
    expect(Schema.is(AttributeValueSchema)(white)).toBe(true);
    expect(
      Schema.is(AttributeValueSchema)({ ...white, valueRef: { ...white.valueRef, moduleId: 'commerce.pricing' } }),
    ).toBe(false);
  });

  it('flags a repeated Variant record before treating it as a second combination', () => {
    const repeatedId = '33333333-3333-4333-8333-333333333333';
    const first = { effectiveAxisValues: values(white), variant: variant(repeatedId) };
    const repeated = { effectiveAxisValues: values(black), variant: variant(repeatedId) };
    expect(evaluateVariantAxes({ ...base, candidates: [first, repeated] }).issues).toContainEqual({
      kind: 'DUPLICATE_VARIANT_RECORD',
      variantId: repeatedId,
    });
  });

  it('rejects a Variant whose explicit identity disagrees with its Variant reference', () => {
    const mismatched = Schema.decodeUnknownSync(ProductVariantSchema)({
      lifecycle: 'ACTIVE',
      productRef: base.productRef,
      variantId: '11111111-1111-4111-8111-111111111111',
      variantRef: {
        moduleId: 'commerce.catalog',
        resourceId: '22222222-2222-4222-8222-222222222222',
        resourceType: 'commerce.catalog.variant',
        tenantId,
      },
    });
    expect(
      evaluateVariantAxes({ ...base, candidates: [{ effectiveAxisValues: values(white), variant: mismatched }] })
        .issues,
    ).toContainEqual({ kind: 'WRONG_PRODUCT', variantId: '22222222-2222-4222-8222-222222222222' });
  });
});

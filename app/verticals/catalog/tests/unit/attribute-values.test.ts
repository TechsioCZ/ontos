import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  AttributeDefinitionSchema,
  AttributeValueSchema,
  assessDefinitionRuleChange,
  validateAttributeValues,
} from '../../shared/domain/attribute-values.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ref = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.attribute-definition',
  tenantId,
} as const;
const definition = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
  label: 'Width',
  levels: ['PRODUCT', 'VARIANT'],
  meaning: 'Width of the product itself',
  measurement: { canonicalUnit: 'mm', decimalPlaces: 2, maximum: 1000, minimum: 0, quantity: 'length' },
  multiplicity: 'SINGLE',
  ref,
  specialStates: ['UNKNOWN'],
  valueKind: 'MEASUREMENT',
});
const centimeters = [{ denominator: 1, from: 'cm', numerator: 10, quantity: 'length', to: 'mm' }] as const;

describe('Attribute Definition and per-subject values', () => {
  it('keeps identity distinct from label and measured meaning', () => {
    expect(Schema.is(AttributeDefinitionSchema)({ ...definition, label: 'Product width' })).toBe(true);
    expect(Schema.is(AttributeDefinitionSchema)({ ...definition, measurement: null })).toBe(false);
    expect(Schema.is(AttributeDefinitionSchema)({ ...definition, levels: [] })).toBe(false);
  });

  it('does not merge distinct questions with the same label or change identity on rename', () => {
    const packageWidth = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
      ...definition,
      meaning: 'Width of the shipping package',
      ref: { ...ref, resourceId: '55555555-5555-4555-8555-555555555555' },
    });
    expect(packageWidth.label).toBe(definition.label);
    expect(packageWidth.ref.resourceId).not.toBe(definition.ref.resourceId);
    expect(assessDefinitionRuleChange(definition, packageWidth).kind).toBe('NEW_DEFINITION_REQUIRED');
    expect(assessDefinitionRuleChange(definition, { ...definition, label: 'Product width' }).kind).toBe('UNCHANGED');
  });

  it('validates independent subject answers against one shared definition without mutating either', () => {
    const steel = [{ kind: 'TEXT', text: 'steel' }] as const;
    const wood = [{ kind: 'TEXT', text: 'wood' }] as const;
    const { measurement: _measurement, ...withoutMeasurement } = definition;
    const material = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
      ...withoutMeasurement,
      label: 'Material',
      meaning: 'Material of the product',
      valueKind: 'TEXT',
    });
    expect(validateAttributeValues(material, steel)).toEqual({ normalized: steel, reasons: [], valid: true });
    expect(validateAttributeValues(material, wood)).toEqual({ normalized: wood, reasons: [], valid: true });
    expect(material.label).toBe('Material');
    expect(steel[0].text).toBe('steel');
  });

  it('distinguishes presentation, rule revisions, and genuinely different meaning', () => {
    expect(assessDefinitionRuleChange(definition, { ...definition, label: 'Product width' }).kind).toBe('UNCHANGED');
    expect(assessDefinitionRuleChange(definition, { ...definition, multiplicity: 'MULTIPLE' })).toEqual({
      kind: 'RULE_REVISION',
      reasons: ['Multiplicity changed'],
    });
    expect(
      assessDefinitionRuleChange(definition, {
        ...definition,
        measurement: { canonicalUnit: 'cm', decimalPlaces: 2, maximum: 1000, minimum: 0, quantity: 'length' },
      }).kind,
    ).toBe('RULE_REVISION');
    expect(assessDefinitionRuleChange(definition, { ...definition, meaning: 'Width of shipping package' }).kind).toBe(
      'NEW_DEFINITION_REQUIRED',
    );
    expect(
      assessDefinitionRuleChange(definition, {
        ...definition,
        measurement: { canonicalUnit: 'mm', decimalPlaces: 2, maximum: 1000, minimum: 0, quantity: 'mass' },
      }).kind,
    ).toBe('NEW_DEFINITION_REQUIRED');
  });

  it('normalizes evidenced compatible units without silently changing magnitude', () => {
    expect(validateAttributeValues(definition, [{ amount: 8, kind: 'MEASUREMENT', unit: 'cm' }], centimeters)).toEqual({
      normalized: [{ amount: 80, kind: 'MEASUREMENT', unit: 'mm' }],
      reasons: [],
      valid: true,
    });
    expect(
      validateAttributeValues(definition, [{ amount: 80, kind: 'MEASUREMENT', unit: 'cm' }], centimeters).normalized,
    ).toEqual([{ amount: 800, kind: 'MEASUREMENT', unit: 'mm' }]);
    expect(validateAttributeValues(definition, [{ amount: 8, kind: 'MEASUREMENT', unit: 'cm' }]).valid).toBe(false);
    expect(
      validateAttributeValues(
        definition,
        [{ amount: 8, kind: 'MEASUREMENT', unit: 'cm' }],
        [{ ...centimeters[0], quantity: 'mass' }],
      ).valid,
    ).toBe(false);
    expect(
      validateAttributeValues(
        definition,
        [{ amount: 8, kind: 'MEASUREMENT', unit: 'cm' }],
        [{ ...centimeters[0], numerator: 1 }],
      ).reasons,
    ).toContain('No evidenced compatible unit conversion');
    expect(
      validateAttributeValues(
        definition,
        [{ amount: 8, kind: 'MEASUREMENT', unit: 'inch' }],
        [{ denominator: 10, from: 'inch', numerator: 254, quantity: 'length', to: 'mm' }],
      ).valid,
    ).toBe(false);
  });

  it('checks exact range and decimal precision after conversion, without rounding', () => {
    expect(validateAttributeValues(definition, [{ amount: 0.1, kind: 'MEASUREMENT', unit: 'mm' }]).valid).toBe(true);
    expect(
      validateAttributeValues(definition, [{ amount: 0.001, kind: 'MEASUREMENT', unit: 'cm' }], centimeters).valid,
    ).toBe(true);
    expect(validateAttributeValues(definition, [{ amount: 0.001, kind: 'MEASUREMENT', unit: 'mm' }]).reasons).toContain(
      'Measurement loses required precision',
    );
    expect(
      validateAttributeValues(definition, [{ amount: 1000.01, kind: 'MEASUREMENT', unit: 'mm' }]).reasons,
    ).toContain('Measurement is outside its valid range');
    expect(
      validateAttributeValues(
        definition,
        [{ amount: 8, kind: 'MEASUREMENT', unit: 'cm' }],
        [{ ...centimeters[0], denominator: 0 }],
      ).reasons,
    ).toContain('Invalid unit conversion');
  });

  it('accepts equivalent exact ratios and exponent input but rejects a nearby untrusted ratio', () => {
    const equivalent = [{ ...centimeters[0], denominator: 2, numerator: 20 }];
    expect(
      validateAttributeValues(definition, [{ amount: 1e-3, kind: 'MEASUREMENT', unit: 'cm' }], equivalent),
    ).toEqual({
      normalized: [{ amount: 0.01, kind: 'MEASUREMENT', unit: 'mm' }],
      reasons: [],
      valid: true,
    });
    expect(
      validateAttributeValues(
        definition,
        [{ amount: 1, kind: 'MEASUREMENT', unit: 'cm' }],
        [{ ...centimeters[0], numerator: 10.000000000000002 }],
      ).reasons,
    ).toContain('No evidenced compatible unit conversion');
  });

  it('rejects exact decimal values that cannot be represented safely after scaling', () => {
    const wideDefinition = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
      ...definition,
      measurement: { ...definition.measurement, maximum: 1e20 },
    });
    expect(
      validateAttributeValues(wideDefinition, [{ amount: 1e14, kind: 'MEASUREMENT', unit: 'mm' }]).reasons,
    ).toContain('Measurement exceeds exact numeric precision');
  });

  it('distinguishes absence, explicit special state, zero, and incomplete measurements', () => {
    expect(validateAttributeValues(definition, []).valid).toBe(true);
    expect(validateAttributeValues(definition, [{ amount: 0, kind: 'MEASUREMENT', unit: 'mm' }]).valid).toBe(true);
    expect(validateAttributeValues(definition, [{ kind: 'SPECIAL', state: 'UNKNOWN' }]).valid).toBe(true);
    expect(validateAttributeValues(definition, [{ kind: 'SPECIAL', state: 'NONE' }]).valid).toBe(false);
    expect(Schema.is(AttributeValueSchema)({ amount: 80, kind: 'MEASUREMENT' })).toBe(false);
    expect(Schema.is(AttributeValueSchema)({ amount: 80, kind: 'MEASUREMENT', unit: '' })).toBe(false);
    expect(Schema.is(AttributeValueSchema)({ kind: 'TEXT', text: '' })).toBe(false);
    expect(validateAttributeValues(definition, [null])).toEqual({
      normalized: [],
      reasons: ['Malformed value'],
      valid: false,
    });
  });

  it('enforces single versus multiple values and never mixes a special state with facts', () => {
    const twoWidths = [
      { amount: 80, kind: 'MEASUREMENT', unit: 'mm' },
      { amount: 90, kind: 'MEASUREMENT', unit: 'mm' },
    ] as const;
    expect(validateAttributeValues(definition, twoWidths).reasons).toContain('Single attribute has multiple values');
    expect(validateAttributeValues({ ...definition, multiplicity: 'MULTIPLE' }, twoWidths).valid).toBe(true);
    expect(
      validateAttributeValues({ ...definition, multiplicity: 'MULTIPLE' }, [
        { kind: 'SPECIAL', state: 'UNKNOWN' },
        twoWidths[0],
      ]).reasons,
    ).toContain('A special state cannot coexist with another value');
  });

  it('accepts multiple controlled materials while enforcing kind and Tenant', () => {
    const { measurement: _measurement, ...withoutMeasurement } = definition;
    const material = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
      ...withoutMeasurement,
      multiplicity: 'MULTIPLE',
      valueKind: 'CONTROLLED',
    });
    const first = {
      moduleId: 'commerce.catalog',
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.catalog.controlled-attribute-value',
      tenantId,
    } as const;
    const second = { ...first, resourceId: '44444444-4444-4444-8444-444444444444' } as const;
    expect(
      validateAttributeValues(material, [
        { kind: 'CONTROLLED', valueRef: first },
        { kind: 'CONTROLLED', valueRef: second },
      ]).valid,
    ).toBe(true);
    expect(validateAttributeValues(material, [{ kind: 'TEXT', text: 'wood' }]).valid).toBe(false);
    expect(
      validateAttributeValues(material, [
        { kind: 'CONTROLLED', valueRef: { ...first, tenantId: '99999999-9999-4999-8999-999999999999' } },
      ]).valid,
    ).toBe(false);
  });
});

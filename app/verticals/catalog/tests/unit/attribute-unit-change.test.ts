import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { AttributeDefinitionSchema } from '../../shared/domain/attribute-values.ts';
import type { AttributeDefinition, AttributeValue, UnitConversion } from '../../shared/domain/attribute-values.ts';
import { assessAttributeUnitChange } from '../../shared/domain/attribute-unit-change.ts';
import type { EvidencedAttributeValue } from '../../shared/domain/attribute-unit-change.ts';

const subjectRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;
const current = Schema.decodeUnknownSync(AttributeDefinitionSchema)({
  label: 'Width',
  levels: ['PRODUCT', 'VARIANT'],
  meaning: 'Width of product',
  measurement: { canonicalUnit: 'cm', decimalPlaces: 2, quantity: 'length' },
  multiplicity: 'SINGLE',
  ref: {
    ...subjectRef,
    resourceId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'commerce.catalog.attribute-definition',
  },
  specialStates: ['UNKNOWN'],
  valueKind: 'MEASUREMENT',
});
const proposed = { ...current, measurement: { canonicalUnit: 'mm', decimalPlaces: 2, quantity: 'length' } };
const conversions = [{ denominator: 1, from: 'cm', numerator: 10, quantity: 'length', to: 'mm' }] as const;
const original = { amount: 80, kind: 'MEASUREMENT', unit: 'cm' } as const;
const evidenced = (value: AttributeValue | null, valueOrdinal = 0): EvidencedAttributeValue => ({
  original: value,
  provenance: {
    evidence: 'Supplier technical sheet, revision 4',
    sourceDefinitionRef: current.ref,
    sourceDefinitionRevision: 3,
    sourceUnit: value?.kind === 'MEASUREMENT' ? value.unit : null,
    subjectRef,
    valueOrdinal,
  },
});
const recorded = [evidenced(original)] as const;
const assess = (
  before: AttributeDefinition,
  after: AttributeDefinition,
  values: readonly EvidencedAttributeValue[],
  ratios: readonly UnitConversion[],
) => assessAttributeUnitChange(before, after, subjectRef, 3, values, ratios);

describe('Catalog Attribute unit revision assessment', () => {
  it('converts the same measured meaning exactly without altering the recorded value', () => {
    expect(assess(current, proposed, recorded, conversions)).toEqual({
      converted: [{ amount: 800, kind: 'MEASUREMENT', unit: 'mm' }],
      kind: 'CONVERTIBLE',
      originals: [original],
    });
    expect(original).toEqual({ amount: 80, kind: 'MEASUREMENT', unit: 'cm' });
  });

  it('does not guess absence, provenance, or an unknown unit', () => {
    expect(assess(current, proposed, [], conversions).kind).toBe('INDETERMINATE');
    expect(assess(current, proposed, [evidenced(null)], conversions).kind).toBe('INDETERMINATE');
    expect(assess(current, proposed, [{ ...evidenced(original), provenance: null }], conversions).kind).toBe(
      'INDETERMINATE',
    );
    expect(assess(current, proposed, [evidenced({ ...original, unit: 'unknown' })], conversions).kind).toBe(
      'INDETERMINATE',
    );
  });

  it('binds provenance to the exact subject, definition revision, ordinal, unit and nonblank evidence', () => {
    const proof = recorded[0].provenance;
    if (proof === null) {
      throw new Error('Test setup requires provenance');
    }
    const altered = [
      { ...proof, subjectRef: { ...subjectRef, resourceId: '44444444-4444-4444-8444-444444444444' } },
      { ...proof, sourceDefinitionRef: { ...current.ref, resourceId: '55555555-5555-4555-8555-555555555555' } },
      { ...proof, sourceDefinitionRevision: 2 },
      { ...proof, valueOrdinal: 1 },
      { ...proof, sourceUnit: 'mm' },
      { ...proof, evidence: ' ' },
    ];
    for (const provenance of altered) {
      expect(assess(current, proposed, [{ original, provenance }], conversions).kind).toBe('INDETERMINATE');
    }
  });

  it('preserves an allowed special state and requires remediation when its validity changes', () => {
    const unknown = evidenced({ kind: 'SPECIAL', state: 'UNKNOWN' });
    expect(assess(current, proposed, [unknown], conversions)).toEqual({
      converted: [unknown.original],
      kind: 'CONVERTIBLE',
      originals: [unknown.original],
    });
    expect(assess(current, { ...proposed, specialStates: [] }, [unknown], conversions).kind).toBe(
      'REMEDIATION_REQUIRED',
    );
    expect(assess({ ...current, specialStates: [] }, proposed, [unknown], conversions).kind).toBe('INDETERMINATE');
  });

  it('requires a new definition for a changed measured meaning', () => {
    expect(assess(current, { ...proposed, meaning: 'Width of package' }, recorded, conversions).kind).toBe(
      'NEW_DEFINITION_REQUIRED',
    );
    expect(
      assess(
        current,
        { ...proposed, measurement: { ...proposed.measurement, quantity: 'mass' } },
        recorded,
        conversions,
      ).kind,
    ).toBe('NEW_DEFINITION_REQUIRED');
  });

  it('requires remediation for untrusted ratios and precision loss', () => {
    expect(assess(current, proposed, recorded, []).kind).toBe('REMEDIATION_REQUIRED');
    expect(assess(current, proposed, recorded, [{ ...conversions[0], numerator: 1 }]).kind).toBe(
      'REMEDIATION_REQUIRED',
    );
    const imprecise = { ...proposed, measurement: { ...proposed.measurement, decimalPlaces: 0 } };
    expect(assess(current, imprecise, [evidenced({ ...original, amount: 0.01 })], conversions).kind).toBe(
      'REMEDIATION_REQUIRED',
    );
  });

  it('does not silently choose among multiple values when rules narrow', () => {
    const multiple = { ...current, multiplicity: 'MULTIPLE' as const };
    expect(assess(multiple, proposed, [recorded[0], evidenced({ ...original, amount: 90 }, 1)], conversions).kind).toBe(
      'REMEDIATION_REQUIRED',
    );
  });
});

const textDefinition = (overrides: Partial<AttributeDefinition>): AttributeDefinition =>
  Schema.decodeUnknownSync(AttributeDefinitionSchema)({
    label: 'Material',
    levels: ['PRODUCT'],
    meaning: 'Material of product',
    multiplicity: 'SINGLE',
    ref: {
      ...subjectRef,
      resourceId: '66666666-6666-4666-8666-666666666666',
      resourceType: 'commerce.catalog.attribute-definition',
    },
    specialStates: [],
    valueKind: 'TEXT',
    ...overrides,
  });
const textValue = { kind: 'TEXT', text: 'steel' } as const;

describe('Catalog Attribute non-measurement rule revision', () => {
  it('keeps identity for a same-meaning TEXT rule revision and validates the recorded values', () => {
    const before = textDefinition({ multiplicity: 'MULTIPLE', specialStates: ['UNKNOWN'] });
    const after = textDefinition({ multiplicity: 'MULTIPLE', specialStates: [] });
    expect(assess(before, after, [evidenced(textValue)], [])).toEqual({
      converted: [textValue],
      kind: 'CONVERTIBLE',
      originals: [textValue],
    });
  });

  it('requires explicit remediation when a narrower TEXT rule no longer fits recorded values', () => {
    const multiple = textDefinition({ multiplicity: 'MULTIPLE' });
    const single = textDefinition({ multiplicity: 'SINGLE' });
    const values = [evidenced(textValue), evidenced({ kind: 'TEXT', text: 'wood' }, 1)];
    expect(assess(multiple, single, values, []).kind).toBe('REMEDIATION_REQUIRED');
  });

  it('still requires a new definition when meaning or value kind changes', () => {
    const before = textDefinition({});
    const values = [evidenced(textValue)];
    expect(assess(before, textDefinition({ meaning: 'Different question' }), values, []).kind).toBe(
      'NEW_DEFINITION_REQUIRED',
    );
    expect(assess(before, textDefinition({ valueKind: 'CONTROLLED' }), values, []).kind).toBe(
      'NEW_DEFINITION_REQUIRED',
    );
  });
});

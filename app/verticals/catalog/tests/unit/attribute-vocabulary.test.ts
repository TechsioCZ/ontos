import { describe, expect, it } from 'effect-rstest';
import { DateTime, Schema } from 'effect';

import {
  ControlledAttributeValueSchema,
  ControlledValueReactivationDecisionSchema,
  ControlledValueRenameDecisionSchema,
  SizeEquivalenceAssertionSchema,
  SizeUsageListSchema,
  mayAssignControlledValue,
  mayReactivateControlledValue,
  mayRenameControlledValue,
} from '../../shared/domain/attribute-vocabulary.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const ref = (resourceType: string, resourceId: string, scopedTenantId = tenantId) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId: scopedTenantId,
});
const definitionRef = ref('commerce.catalog.attribute-definition', '22222222-2222-4222-8222-222222222222');
const valueRef = ref('commerce.catalog.controlled-attribute-value', '33333333-3333-4333-8333-333333333333');
const anotherValueRef = ref('commerce.catalog.controlled-attribute-value', '44444444-4444-4444-8444-444444444444');
const productRef = ref('commerce.catalog.product', '55555555-5555-4555-8555-555555555555');
const base = {
  attributeDefinitionRef: definitionRef,
  label: 'M',
  lifecycle: 'ACTIVE',
  ref: valueRef,
  specialization: 'SIZE',
} as const;

describe('Catalog controlled attribute vocabulary', () => {
  it('keeps identity through a reviewed same-meaning rename, but rejects a different meaning', () => {
    const value = Schema.decodeUnknownSync(ControlledAttributeValueSchema)(base);
    const correction = Schema.decodeUnknownSync(ControlledValueRenameDecisionSchema)({
      current: value,
      evidence: 'Reviewed typo/translation',
      proposedLabel: 'Medium',
      sameMeaning: true,
    });
    expect(mayRenameControlledValue(correction)).toBe(true);
    expect(correction.current.ref).toEqual(valueRef);
    expect(mayRenameControlledValue({ ...correction, sameMeaning: false })).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(ControlledValueRenameDecisionSchema)({ ...correction, evidence: ' ' }),
    ).toThrow();
  });

  it('blocks new assignment after retirement without invalidating the existing reference', () => {
    const value = Schema.decodeUnknownSync(ControlledAttributeValueSchema)(base);
    expect(mayAssignControlledValue({ ref: definitionRef }, value)).toBe(true);
    const retired = { ...value, lifecycle: 'RETIRED' as const };
    expect(mayAssignControlledValue({ ref: definitionRef }, retired)).toBe(false);
    expect(retired.ref).toEqual(value.ref);
    expect(mayAssignControlledValue({ ref: { ...definitionRef, tenantId: otherTenantId } }, value)).toBe(false);
    const review = Schema.decodeUnknownSync(ControlledValueReactivationDecisionSchema)({
      currentMeaningConfirmed: true,
      evidence: 'Current review',
      value: retired,
    });
    expect(mayReactivateControlledValue(review)).toBe(true);
    expect(mayReactivateControlledValue({ ...review, currentMeaningConfirmed: false })).toBe(false);
  });

  it('does not merge Color identity from shared labels, group, or preview', () => {
    const color = {
      ...base,
      color: {
        distinctionEvidence: {
          description: 'Physical shade A',
          kind: 'OTHER',
          source: 'Supplier sample',
          sourceScope: '2026 matte range',
        },
        groupName: 'Grey',
        preview: { hex: '#333333', kind: 'HEX' },
      },
      label: 'Anthracite',
      specialization: 'COLOR' as const,
    };
    const first = Schema.decodeUnknownSync(ControlledAttributeValueSchema)(color);
    const second = Schema.decodeUnknownSync(ControlledAttributeValueSchema)({
      ...color,
      color: {
        ...color.color,
        distinctionEvidence: { ...color.color.distinctionEvidence, description: 'Physical shade B' },
      },
      ref: anotherValueRef,
    });
    expect(first.ref).not.toEqual(second.ref);
    expect(first.color?.preview).toEqual(second.color?.preview);
    expect(() =>
      Schema.decodeUnknownSync(ControlledAttributeValueSchema)({
        ...color,
        color: { ...color.color, distinctionEvidence: { ...color.color.distinctionEvidence, sourceScope: ' ' } },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ControlledAttributeValueSchema)({
        ...color,
        color: {
          ...color.color,
          distinctionEvidence: { designation: 'A1', kind: 'SWATCH', source: 'Supplier', sourceScope: 'Range' },
        },
      }),
    ).toThrow();
  });

  it('stores Size order per Product and does not infer measurements from numeric labels', () => {
    const numeric = Schema.decodeUnknownSync(ControlledAttributeValueSchema)({ ...base, label: '80' });
    expect(numeric).not.toHaveProperty('measurement');
    const first = Schema.decodeUnknownSync(SizeUsageListSchema)({
      orderedSizeRefs: [valueRef, anotherValueRef],
      productRef,
    });
    const second = Schema.decodeUnknownSync(SizeUsageListSchema)({
      orderedSizeRefs: [anotherValueRef, valueRef],
      productRef: { ...productRef, resourceId: '66666666-6666-4666-8666-666666666666' },
    });
    expect(first.orderedSizeRefs[0]).toEqual(valueRef);
    expect(second.orderedSizeRefs[1]).toEqual(valueRef);
    expect(() =>
      Schema.decodeUnknownSync(SizeUsageListSchema)({ orderedSizeRefs: [valueRef, valueRef], productRef }),
    ).toThrow();
  });

  it('requires scoped evidence to assert Size equivalence', () => {
    expect(() =>
      Schema.decodeUnknownSync(SizeEquivalenceAssertionSchema)({
        evidence: 'Conversion chart',
        leftSizeRef: valueRef,
        rightSizeRef: anotherValueRef,
        scope: ' ',
      }),
    ).toThrow();
    const assertion = Schema.decodeUnknownSync(SizeEquivalenceAssertionSchema)({
      evidence: 'Published chart',
      leftSizeRef: valueRef,
      rightSizeRef: anotherValueRef,
      scope: 'Manufacturer A, 2026 line',
    });
    expect(assertion.scope).toBe('Manufacturer A, 2026 line');
    const bounded = Schema.decodeUnknownSync(SizeEquivalenceAssertionSchema)({
      ...assertion,
      validFrom: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
      validUntil: DateTime.makeUnsafe('2026-12-31T23:59:59.000Z'),
    });
    expect(bounded.validFrom).toBeDefined();
    expect(() =>
      Schema.decodeUnknownSync(SizeEquivalenceAssertionSchema)({
        ...assertion,
        validUntil: '2026-12-31',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SizeEquivalenceAssertionSchema)({
        ...assertion,
        rightSizeRef: { ...anotherValueRef, tenantId: otherTenantId },
      }),
    ).toThrow();
  });
});

import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { decideSelectionSourceChange } from '../../src/actions/selection-source-change-decision.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-selection-source-changed-v1.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const valueSetRef = {
  moduleId: 'commerce.catalog',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.attribute-value-set',
  tenantId,
} as const;
const changeId = '55555555-5555-4555-8555-555555555555';
const inheritedValuePayload = {
  changeId,
  changeKind: 'OVERRIDE_SET',
  productRef,
  source: { resourceRef: valueSetRef, revision: 2 },
  sourceKind: 'INHERITED_VALUE',
  tenantId,
  variantRef,
} as const;

describe('Selection source change decision gate', () => {
  it('requires a resolved Current change proof before any emission', () => {
    expect(decideSelectionSourceChange()).toMatchObject({ kind: 'UNPROVEN' });
  });

  it('treats an unchanged resolved source level and revision as no change', () => {
    expect(
      decideSelectionSourceChange({
        nextRevision: 2,
        nextSourceLevel: 'VARIANT',
        previousRevision: 2,
        previousSourceLevel: 'VARIANT',
      }),
    ).toMatchObject({ kind: 'UNCHANGED' });
    expect(
      decideSelectionSourceChange({
        nextRevision: 3,
        nextSourceLevel: 'PRODUCT',
        previousRevision: 3,
        previousSourceLevel: 'PRODUCT',
      }),
    ).toMatchObject({ kind: 'UNCHANGED' });
  });

  it('emits only when the resolved Current fact actually moved', () => {
    expect(
      decideSelectionSourceChange({
        nextRevision: 3,
        nextSourceLevel: 'VARIANT',
        previousRevision: 2,
        previousSourceLevel: 'PRODUCT',
      }),
    ).toMatchObject({ kind: 'CHANGED' });
    expect(
      decideSelectionSourceChange({
        nextRevision: null,
        nextSourceLevel: 'ABSENT',
        previousRevision: 4,
        previousSourceLevel: 'VARIANT',
      }),
    ).toMatchObject({ kind: 'CHANGED' });
  });
});

describe('Selection source changed outbox contract', () => {
  it('accepts an exact inherited value source and rejects cross-Tenant identity', () => {
    expect(Schema.decodeUnknownSync(OutboxPayloadSchema)(inheritedValuePayload)).toEqual(inheritedValuePayload);
    expect(() =>
      Schema.decodeUnknownSync(OutboxPayloadSchema)({ ...inheritedValuePayload, tenantId: otherTenantId }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OutboxPayloadSchema)({
        ...inheritedValuePayload,
        variantRef: { ...variantRef, tenantId: otherTenantId },
      }),
    ).toThrow();
  });

  it('bounds a Product Type source to a source revision, never a Variant override', () => {
    const productTypePayload = {
      changeId,
      changeKind: 'SOURCE_REVISED',
      source: {
        resourceRef: {
          moduleId: 'commerce.catalog',
          resourceId: '66666666-6666-4666-8666-666666666666',
          resourceType: 'commerce.catalog.product-type',
          tenantId,
        },
        revision: 5,
      },
      sourceKind: 'PRODUCT_TYPE',
      tenantId,
    } as const;
    expect(Schema.decodeUnknownSync(OutboxPayloadSchema)(productTypePayload)).toEqual(productTypePayload);
    expect(Schema.decodeUnknownSync(OutboxPayloadSchema)({ ...productTypePayload, productRef, variantRef })).toEqual(
      productTypePayload,
    );
    expect(() =>
      Schema.decodeUnknownSync(OutboxPayloadSchema)({ ...productTypePayload, changeKind: 'OVERRIDE_SET' }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(OutboxPayloadSchema)({
        ...productTypePayload,
        source: { resourceRef: valueSetRef, revision: 5 },
      }),
    ).toThrow();
  });

  it('does not carry a Current-at-commit claim', () => {
    expect(Object.keys(inheritedValuePayload)).not.toContain('currentAtCommit');
    const decoded = Schema.decodeUnknownSync(OutboxPayloadSchema)({ ...inheritedValuePayload, currentAtCommit: true });
    expect(Object.keys(decoded)).not.toContain('currentAtCommit');
  });
});

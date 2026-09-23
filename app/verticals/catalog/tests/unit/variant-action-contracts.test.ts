import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { ChangeVariantPayloadSchema } from '../../shared/actions/change-variant.ts';
import { CreateVariantPayloadSchema } from '../../shared/actions/create-variant.ts';
import { GovernVariantAxesPayloadSchema } from '../../shared/actions/govern-variant-axes.ts';
import { ReactivateVariantPayloadSchema } from '../../shared/actions/reactivate-variant.ts';
import { RetireVariantPayloadSchema } from '../../shared/actions/retire-variant.ts';
import { changeVariantAction } from '../../src/actions/change-variant.action.ts';
import { createVariantAction } from '../../src/actions/create-variant.action.ts';
import { governVariantAxesAction } from '../../src/actions/govern-variant-axes.action.ts';
import { reactivateVariantAction } from '../../src/actions/reactivate-variant.action.ts';
import { retireVariantAction } from '../../src/actions/retire-variant.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
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

describe('Variant Action payload contracts', () => {
  it('requires explicit Product and Variant identity plus evidence for creation', () => {
    const decode = Schema.decodeUnknownSync(CreateVariantPayloadSchema);
    expect(
      decode({
        classification: {
          affectsOpenSelection: true,
          evidenceRefs: ['factory-sheet'],
          kind: 'NEW_REALIZATION',
          newVariantRef: variantRef,
          productRef,
          reason: 'Recorded form',
        },
        evidenceRefs: ['factory-sheet'],
        expectedProductRevision: 1,
        productRef,
        reason: 'Recorded form',
        variantRef,
      }).variantRef,
    ).toEqual(variantRef);
    expect(() =>
      decode({
        classification: {
          affectsOpenSelection: true,
          evidenceRefs: ['factory-sheet'],
          kind: 'NEW_REALIZATION',
          newVariantRef: variantRef,
          productRef,
          reason: 'No evidence',
        },
        expectedProductRevision: 1,
        productRef,
        reason: 'No evidence',
        variantRef,
      }),
    ).toThrow();
    expect(() =>
      decode({
        classification: {
          affectsOpenSelection: true,
          evidenceRefs: ['factory-sheet'],
          kind: 'NEW_REALIZATION',
          newVariantRef: variantRef,
          productRef,
          reason: 'Cross tenant',
        },
        evidenceRefs: ['factory-sheet'],
        expectedProductRevision: 1,
        productRef,
        reason: 'Cross tenant',
        variantRef: { ...variantRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      }),
    ).toThrow();
  });

  it('permits identity-preserving corrections only with classification and evidence', () => {
    const decode = Schema.decodeUnknownSync(ChangeVariantPayloadSchema);
    expect(
      decode({
        classification: 'EVIDENCED_RECORD_CORRECTION',
        currentProductRef: productRef,
        evidenceRefs: ['drawing'],
        expectedVariantRevision: 2,
        originalDataErrorEvidenceRef: 'drawing',
        reason: 'Correct wrong record',
        variantRef,
      }).classification,
    ).toBe('EVIDENCED_RECORD_CORRECTION');
    expect(() =>
      decode({
        classification: 'NEW_REALIZATION',
        evidenceRefs: ['drawing'],
        expectedVariantRevision: 2,
        reason: 'New form',
        variantRef,
      }),
    ).toThrow();
    expect(() =>
      decode({
        classification: 'EVIDENCED_RECORD_CORRECTION',
        evidenceRefs: [],
        expectedVariantRevision: 2,
        reason: 'No proof',
        variantRef,
      }),
    ).toThrow();
    expect(
      decode({
        classification: 'SAME_MEANING_RENAME',
        currentProductRef: productRef,
        evidenceRefs: ['name-record'],
        expectedVariantRevision: 2,
        reason: 'Same form, clearer name',
        variantRef,
      }).classification,
    ).toBe('SAME_MEANING_RENAME');
    expect(
      decode({
        classification: 'EVIDENCED_PARENT_CORRECTION',
        currentProductRef: productRef,
        evidenceRefs: ['original-parent-record'],
        expectedVariantRevision: 2,
        reason: 'Wrong parent recorded',
        targetProductRef: { ...productRef, resourceId: '77777777-7777-4777-8777-777777777777' },
        variantRef,
      }).targetProductRef?.resourceId,
    ).toBe('77777777-7777-4777-8777-777777777777');

    expect(
      decode({
        classification: 'EVIDENCED_RECORD_CORRECTION',
        evidenceRefs: ['drawing'],
        expectedVariantRevision: 2,
        reason: 'Legacy request lacks its Current Product evidence',
        variantRef,
      }).currentProductRef,
    ).toBeUndefined();
  });

  it('decodes the legacy Variant-axis wire shape while preserving current evidence fields', () => {
    const decode = Schema.decodeUnknownSync(GovernVariantAxesPayloadSchema);
    const attributeDefinitionRef = {
      moduleId: 'commerce.catalog',
      resourceId: '88888888-8888-4888-8888-888888888888',
      resourceType: 'commerce.catalog.attribute-definition',
      tenantId,
    } as const;
    const current = decode({
      axes: [{ attributeDefinitionRef, definitionRevision: 3, expectedAllowanceRevision: 1 }],
      classification: {
        evidenceRefs: ['axis-review'],
        kind: 'AXIS_ADDITION',
        reason: 'Distinguishes exact forms',
      },
      expectedAxisRevision: 1,
      productRef,
      reason: 'Distinguishes exact forms',
    });
    expect(current.axes[0]?.expectedAllowanceRevision).toBe(1);
    expect(governVariantAxesAction.descriptor.schemaVersion).toBe('1');

    expect(
      decode({
        axes: [{ attributeDefinitionRef, definitionRevision: 3 }],
        expectedAxisRevision: 1,
        productRef,
        reason: 'Legacy request has no decision or allowance revision evidence',
      }),
    ).toMatchObject({ axes: [{ attributeDefinitionRef, definitionRevision: 3 }] });
  });

  it('requires an optimistic revision and identity evidence for reactivation', () => {
    expect(() => Schema.decodeUnknownSync(RetireVariantPayloadSchema)({ reason: 'Retire', variantRef })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ReactivateVariantPayloadSchema)({
        expectedVariantRevision: 1,
        reason: 'Restore',
        variantRef,
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(ReactivateVariantPayloadSchema)({
        evidenceRefs: ['same-identity-proof'],
        expectedVariantRevision: 2,
        reason: 'Restore the same form',
        variantRef,
      }).variantRef,
    ).toEqual(variantRef);
  });

  it('routes all mutations through explicit tenant-scoped, idempotent Action authorization', () => {
    for (const action of [createVariantAction, changeVariantAction, retireVariantAction, reactivateVariantAction]) {
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('forbidden');
      expect(action.descriptor.owningModuleKey).toBe('commerce.catalog');
    }
    expect(changeVariantAction.descriptor.schemaVersion).toBe('2');
  });
});

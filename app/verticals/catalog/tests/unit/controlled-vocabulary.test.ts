import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { ControlledAttributeValueSchema } from '../../shared/domain/attribute-vocabulary.ts';
import {
  ControlledValueAssignmentSchema,
  mayCreateControlledValueAssignment,
  preservesControlledValueAssignment,
} from '../../shared/domain/controlled-vocabulary.ts';
import { CatalogRevisionReferenceSchema } from '../../shared/domain/catalog-revision-reference.ts';

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
const productRef = ref('commerce.catalog.product', '44444444-4444-4444-8444-444444444444');
const revision = { resourceRef: valueRef, revision: 1, revisionId: '55555555-5555-4555-8555-555555555555' };
const decodeAssignment = Schema.decodeUnknownSync(ControlledValueAssignmentSchema);
const decodeRevision = Schema.decodeUnknownSync(CatalogRevisionReferenceSchema);
const value = Schema.decodeUnknownSync(ControlledAttributeValueSchema)({
  attributeDefinitionRef: definitionRef,
  label: 'Steel',
  lifecycle: 'ACTIVE',
  ref: valueRef,
  specialization: 'GENERAL',
});

describe('controlled vocabulary assignment evidence', () => {
  it('admits an active value only when the qualified identity and exact revision match', () => {
    const assignment = decodeAssignment({ subjectRef: productRef, valueRevision: revision });
    expect(mayCreateControlledValueAssignment(assignment, value, decodeRevision(revision))).toBe(true);
    expect(
      mayCreateControlledValueAssignment(assignment, { ...value, lifecycle: 'RETIRED' }, decodeRevision(revision)),
    ).toBe(false);
    expect(mayCreateControlledValueAssignment(assignment, value, decodeRevision({ ...revision, revision: 2 }))).toBe(
      false,
    );
    expect(
      mayCreateControlledValueAssignment(
        assignment,
        value,
        decodeRevision({
          ...revision,
          revisionId: '66666666-6666-4666-8666-666666666666',
        }),
      ),
    ).toBe(false);
  });

  it('rejects cross-tenant, wrong-subject, and wrong-value references', () => {
    expect(() =>
      decodeAssignment({ subjectRef: { ...productRef, tenantId: otherTenantId }, valueRevision: revision }),
    ).toThrow();
    expect(() => decodeAssignment({ subjectRef: definitionRef, valueRevision: revision })).toThrow();
    expect(() =>
      decodeAssignment({ subjectRef: productRef, valueRevision: { ...revision, resourceRef: definitionRef } }),
    ).toThrow();
    expect(() =>
      decodeAssignment({ subjectRef: productRef, valueRevision: { ...revision, revision: 'latest' } }),
    ).toThrow();
  });

  it('retains an accepted reference unchanged even when its value is retired', () => {
    const accepted = decodeAssignment({ subjectRef: productRef, valueRevision: revision });
    expect(preservesControlledValueAssignment(accepted, accepted)).toBe(true);
    expect(
      preservesControlledValueAssignment(
        accepted,
        decodeAssignment({
          subjectRef: productRef,
          valueRevision: { ...revision, revision: 2 },
        }),
      ),
    ).toBe(false);
    expect(
      preservesControlledValueAssignment(
        accepted,
        decodeAssignment({
          subjectRef: { ...productRef, resourceId: '77777777-7777-4777-8777-777777777777' },
          valueRevision: revision,
        }),
      ),
    ).toBe(false);
  });
});

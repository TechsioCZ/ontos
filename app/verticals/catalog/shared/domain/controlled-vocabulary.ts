import { Schema } from 'effect';

import { ControlledAttributeValueSchema } from './attribute-vocabulary.ts';
import {
  CatalogResourceRefSchema,
  CatalogRevisionReferenceSchema,
  sameCatalogRevisionReference,
} from './catalog-revision-reference.ts';

/** An assignment retains the identity and exact revision that justified the choice. */
export const ControlledValueAssignmentSchema = Schema.Struct({
  subjectRef: CatalogResourceRefSchema,
  valueRevision: CatalogRevisionReferenceSchema,
}).check(
  Schema.makeFilter(({ subjectRef, valueRevision }) => {
    if (
      subjectRef.resourceType !== 'commerce.catalog.product' &&
      subjectRef.resourceType !== 'commerce.catalog.variant'
    ) {
      return 'A controlled value can be assigned only to a Product or Variant';
    }
    if (valueRevision.resourceRef.resourceType !== 'commerce.catalog.controlled-attribute-value') {
      return 'Expected a controlled value revision';
    }
    return subjectRef.tenantId === valueRevision.resourceRef.tenantId
      ? undefined
      : 'Assignment and value must belong to the same Tenant';
  }),
);
export type ControlledValueAssignment = typeof ControlledValueAssignmentSchema.Type;

/** A new choice requires a currently active value at precisely the assessed revision. */
export const mayCreateControlledValueAssignment = (
  assignment: ControlledValueAssignment,
  value: typeof ControlledAttributeValueSchema.Type,
  assessedRevision: typeof CatalogRevisionReferenceSchema.Type,
): boolean =>
  Schema.is(ControlledValueAssignmentSchema)(assignment) &&
  Schema.is(ControlledAttributeValueSchema)(value) &&
  Schema.is(CatalogRevisionReferenceSchema)(assessedRevision) &&
  value.lifecycle === 'ACTIVE' &&
  value.ref.moduleId === assignment.valueRevision.resourceRef.moduleId &&
  value.ref.resourceType === assignment.valueRevision.resourceRef.resourceType &&
  value.ref.resourceId === assignment.valueRevision.resourceRef.resourceId &&
  value.ref.tenantId === assignment.valueRevision.resourceRef.tenantId &&
  sameCatalogRevisionReference(assignment.valueRevision, assessedRevision);

/** Retirement never mutates or substitutes an already accepted assignment. */
export const preservesControlledValueAssignment = (
  accepted: ControlledValueAssignment,
  retained: ControlledValueAssignment,
): boolean =>
  Schema.is(ControlledValueAssignmentSchema)(accepted) &&
  Schema.is(ControlledValueAssignmentSchema)(retained) &&
  accepted.subjectRef.moduleId === retained.subjectRef.moduleId &&
  accepted.subjectRef.resourceType === retained.subjectRef.resourceType &&
  accepted.subjectRef.resourceId === retained.subjectRef.resourceId &&
  accepted.subjectRef.tenantId === retained.subjectRef.tenantId &&
  sameCatalogRevisionReference(accepted.valueRevision, retained.valueRevision);

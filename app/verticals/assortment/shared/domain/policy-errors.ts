import { Schema } from 'effect';
import { AssortmentOwnerResourceRefSchema } from './decision-contracts.ts';

const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));

export const AssortmentPolicyConflictKindSchema = Schema.Literals([
  'IDEMPOTENCY_REUSED',
  'BUSINESS_CODE',
  'SEMANTIC_DUPLICATE',
  'STALE_BASIS',
  'LIFECYCLE',
  'CONCURRENT_OVERLAP',
]);
export type AssortmentPolicyConflictKind = typeof AssortmentPolicyConflictKindSchema.Type;

const PersistenceUnavailableFields = {
  code: Schema.Literal('assortment_policy_persistence_unavailable'),
  reason,
};
const PersistenceUnavailableSchema = Schema.TaggedStruct(
  'AssortmentPolicyPersistenceUnavailable',
  PersistenceUnavailableFields,
);
export const AssortmentPolicyPersistenceUnavailable = Schema.TaggedError<typeof PersistenceUnavailableSchema.Type>()(
  'AssortmentPolicyPersistenceUnavailable',
  PersistenceUnavailableFields,
);

const TargetInvariantFields = { reason };
export const AssortmentPolicyTargetInvariant = Schema.TaggedError<Error>()(
  'AssortmentPolicyTargetInvariant',
  TargetInvariantFields,
);

const NotFoundFields = {
  code: Schema.Literal('assortment_policy_not_found'),
  reason,
};
const NotFoundSchema = Schema.TaggedStruct('AssortmentPolicyNotFound', NotFoundFields);
export const AssortmentPolicyNotFound = Schema.TaggedError<typeof NotFoundSchema.Type>()(
  'AssortmentPolicyNotFound',
  NotFoundFields,
);

const ConflictFields = {
  code: Schema.Literal('assortment_policy_conflict'),
  conflict: AssortmentPolicyConflictKindSchema,
  reason,
};
const ConflictSchema = Schema.TaggedStruct('AssortmentPolicyConflict', ConflictFields);
export const AssortmentPolicyConflict = Schema.TaggedError<typeof ConflictSchema.Type>()(
  'AssortmentPolicyConflict',
  ConflictFields,
);

const StaleBasisFields = {
  code: Schema.Literal('assortment_policy_stale_basis'),
  reason,
};
const StaleBasisSchema = Schema.TaggedStruct('AssortmentPolicyStaleBasis', StaleBasisFields);
export const AssortmentPolicyStaleBasis = Schema.TaggedError<typeof StaleBasisSchema.Type>()(
  'AssortmentPolicyStaleBasis',
  StaleBasisFields,
);

const LifecycleConflictFields = {
  code: Schema.Literal('assortment_policy_lifecycle_conflict'),
  reason,
};
const LifecycleConflictSchema = Schema.TaggedStruct('AssortmentPolicyLifecycleConflict', LifecycleConflictFields);
export const AssortmentPolicyLifecycleConflict = Schema.TaggedError<typeof LifecycleConflictSchema.Type>()(
  'AssortmentPolicyLifecycleConflict',
  LifecycleConflictFields,
);

export const AssortmentPolicyAuditEvidenceSchema = Schema.Struct({
  action: Schema.String.check(Schema.isMinLength(1)),
  changed: Schema.Boolean,
  meaningFingerprint: Schema.String.check(Schema.isMinLength(1)),
  operation: Schema.String.check(Schema.isMinLength(1)),
  resourceId: AssortmentOwnerResourceRefSchema.fields.resourceId,
  resourceType: Schema.String.check(Schema.isMinLength(1)),
});

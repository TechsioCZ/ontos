import { Schema } from 'effect';
import {
  CustomerGroupProfileLifecycleSchema,
  CustomerGroupRevisionSchema,
  CustomerGroupTextSchema,
} from './group-contract.ts';

const codedReason = <Code extends string>(code: Code) => ({
  code: Schema.Literal(code),
  reason: CustomerGroupTextSchema,
});

const persistenceUnavailableFields = codedReason('customer_group_persistence_unavailable');
const PersistenceUnavailableSchema = Schema.TaggedStruct(
  'CustomerGroupPersistenceUnavailable',
  persistenceUnavailableFields,
);
export const CustomerGroupPersistenceUnavailable = Schema.TaggedError<
  typeof PersistenceUnavailableSchema.Type
>()('CustomerGroupPersistenceUnavailable', persistenceUnavailableFields);
export type CustomerGroupPersistenceUnavailableError = InstanceType<
  typeof CustomerGroupPersistenceUnavailable
>;

const notFoundFields = codedReason('customer_group_not_found');
const NotFoundSchema = Schema.TaggedStruct('CustomerGroupNotFound', notFoundFields);
export const CustomerGroupNotFound = Schema.TaggedError<typeof NotFoundSchema.Type>()(
  'CustomerGroupNotFound',
  notFoundFields,
);

const profileNotFoundFields = codedReason('customer_group_profile_not_found');
const ProfileNotFoundSchema = Schema.TaggedStruct(
  'CustomerGroupProfileNotFound',
  profileNotFoundFields,
);
export const CustomerGroupProfileNotFound = Schema.TaggedError<typeof ProfileNotFoundSchema.Type>()(
  'CustomerGroupProfileNotFound',
  profileNotFoundFields,
);

const businessCodeConflictFields = codedReason('customer_group_business_code_conflict');
const BusinessCodeConflictSchema = Schema.TaggedStruct(
  'CustomerGroupBusinessCodeConflict',
  businessCodeConflictFields,
);
export const CustomerGroupBusinessCodeConflict = Schema.TaggedError<
  typeof BusinessCodeConflictSchema.Type
>()('CustomerGroupBusinessCodeConflict', businessCodeConflictFields);

const semanticDuplicateFields = codedReason('customer_group_semantic_duplicate');
const SemanticDuplicateSchema = Schema.TaggedStruct(
  'CustomerGroupSemanticDuplicate',
  semanticDuplicateFields,
);
export const CustomerGroupSemanticDuplicate = Schema.TaggedError<
  typeof SemanticDuplicateSchema.Type
>()('CustomerGroupSemanticDuplicate', semanticDuplicateFields);

const revisionConflictFields = {
  ...codedReason('customer_group_revision_conflict'),
  actualRevision: CustomerGroupRevisionSchema,
};
const RevisionConflictSchema = Schema.TaggedStruct(
  'CustomerGroupRevisionConflict',
  revisionConflictFields,
);
export const CustomerGroupRevisionConflict = Schema.TaggedError<
  typeof RevisionConflictSchema.Type
>()('CustomerGroupRevisionConflict', revisionConflictFields);

const definitionChangeRequiresNewGroupFields = codedReason(
  'customer_group_definition_change_requires_new_group',
);
const DefinitionChangeRequiresNewGroupSchema = Schema.TaggedStruct(
  'CustomerGroupDefinitionChangeRequiresNewGroup',
  definitionChangeRequiresNewGroupFields,
);
export const CustomerGroupDefinitionChangeRequiresNewGroup = Schema.TaggedError<
  typeof DefinitionChangeRequiresNewGroupSchema.Type
>()('CustomerGroupDefinitionChangeRequiresNewGroup', definitionChangeRequiresNewGroupFields);

const archivedCorrectionForbiddenFields = codedReason(
  'customer_group_archived_correction_forbidden',
);
const ArchivedCorrectionForbiddenSchema = Schema.TaggedStruct(
  'CustomerGroupArchivedCorrectionForbidden',
  archivedCorrectionForbiddenFields,
);
export const CustomerGroupArchivedCorrectionForbidden = Schema.TaggedError<
  typeof ArchivedCorrectionForbiddenSchema.Type
>()('CustomerGroupArchivedCorrectionForbidden', archivedCorrectionForbiddenFields);

const lifecycleConflictFields = codedReason('customer_group_lifecycle_conflict');
const LifecycleConflictSchema = Schema.TaggedStruct(
  'CustomerGroupLifecycleConflict',
  lifecycleConflictFields,
);
export const CustomerGroupLifecycleConflict = Schema.TaggedError<
  typeof LifecycleConflictSchema.Type
>()('CustomerGroupLifecycleConflict', lifecycleConflictFields);

const inactiveFields = codedReason('customer_group_inactive');
const InactiveSchema = Schema.TaggedStruct('CustomerGroupInactive', inactiveFields);
export const CustomerGroupInactive = Schema.TaggedError<typeof InactiveSchema.Type>()(
  'CustomerGroupInactive',
  inactiveFields,
);

const profileIneligibleFields = {
  ...codedReason('customer_group_profile_ineligible'),
  profileState: CustomerGroupProfileLifecycleSchema,
};
const ProfileIneligibleSchema = Schema.TaggedStruct(
  'CustomerGroupProfileIneligible',
  profileIneligibleFields,
);
export const CustomerGroupProfileIneligible = Schema.TaggedError<
  typeof ProfileIneligibleSchema.Type
>()('CustomerGroupProfileIneligible', profileIneligibleFields);

const membershipOverlapFields = codedReason('customer_group_membership_overlap');
const MembershipOverlapSchema = Schema.TaggedStruct(
  'CustomerGroupMembershipOverlap',
  membershipOverlapFields,
);
export const CustomerGroupMembershipOverlap = Schema.TaggedError<
  typeof MembershipOverlapSchema.Type
>()('CustomerGroupMembershipOverlap', membershipOverlapFields);

const membershipNotFoundFields = codedReason('customer_group_membership_not_found');
const MembershipNotFoundSchema = Schema.TaggedStruct(
  'CustomerGroupMembershipNotFound',
  membershipNotFoundFields,
);
export const CustomerGroupMembershipNotFound = Schema.TaggedError<
  typeof MembershipNotFoundSchema.Type
>()('CustomerGroupMembershipNotFound', membershipNotFoundFields);

const membershipRemovalConflictFields = codedReason('customer_group_membership_removal_conflict');
const MembershipRemovalConflictSchema = Schema.TaggedStruct(
  'CustomerGroupMembershipRemovalConflict',
  membershipRemovalConflictFields,
);
export const CustomerGroupMembershipRemovalConflict = Schema.TaggedError<
  typeof MembershipRemovalConflictSchema.Type
>()('CustomerGroupMembershipRemovalConflict', membershipRemovalConflictFields);

const scopeMismatchFields = codedReason('customer_group_scope_mismatch');
const ScopeMismatchSchema = Schema.TaggedStruct('CustomerGroupScopeMismatch', scopeMismatchFields);
export const CustomerGroupScopeMismatch = Schema.TaggedError<typeof ScopeMismatchSchema.Type>()(
  'CustomerGroupScopeMismatch',
  scopeMismatchFields,
);

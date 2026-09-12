// oxlint-disable-next-line max-classes-per-file -- One owner-local error vocabulary is colocated for exhaustive generated domainErrorSchema unions; expires: 2027-03-01.
import { Schema } from 'effect';

const ErrorReasonSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

export class CustomerPriceGroupScopeMismatch extends Schema.TaggedError<CustomerPriceGroupScopeMismatch>()(
  'CustomerPriceGroupScopeMismatch',
  { code: Schema.Literal('customer_price_group_scope_mismatch'), reason: ErrorReasonSchema },
) {}

export class CustomerPriceGroupRetroactiveScheduleRejected extends Schema.TaggedError<CustomerPriceGroupRetroactiveScheduleRejected>()(
  'CustomerPriceGroupRetroactiveScheduleRejected',
  {
    code: Schema.Literal('customer_price_group_retroactive_schedule_rejected'),
    reason: ErrorReasonSchema,
  },
) {}

export class CustomerPriceGroupProfileNotFound extends Schema.TaggedError<CustomerPriceGroupProfileNotFound>()(
  'CustomerPriceGroupProfileNotFound',
  { code: Schema.Literal('customer_price_group_profile_not_found'), reason: ErrorReasonSchema },
) {}

export class CustomerPriceGroupProfileIneligible extends Schema.TaggedError<CustomerPriceGroupProfileIneligible>()(
  'CustomerPriceGroupProfileIneligible',
  {
    code: Schema.Literal('customer_price_group_profile_ineligible'),
    profileState: Schema.Literals(['ARCHIVED', 'RECONCILIATION_REQUIRED', 'SUSPENDED']),
    reason: ErrorReasonSchema,
  },
) {}

export class CustomerPriceGroupProfileUnavailable extends Schema.TaggedError<CustomerPriceGroupProfileUnavailable>()(
  'CustomerPriceGroupProfileUnavailable',
  {
    code: Schema.Literal('customer_price_group_profile_unavailable'),
    reason: ErrorReasonSchema,
  },
) {}

export class CustomerPriceGroupProfileAssociationMismatch extends Schema.TaggedError<CustomerPriceGroupProfileAssociationMismatch>()(
  'CustomerPriceGroupProfileAssociationMismatch',
  {
    code: Schema.Literal('customer_price_group_profile_association_mismatch'),
    reason: ErrorReasonSchema,
  },
) {}

export class CustomerPriceGroupCatalogRejected extends Schema.TaggedError<CustomerPriceGroupCatalogRejected>()(
  'CustomerPriceGroupCatalogRejected',
  {
    code: Schema.Literal('customer_price_group_catalog_rejected'),
    reason: ErrorReasonSchema,
    reasonCode: Schema.Literals(['INCOMPATIBLE', 'MISSING', 'RETIRED', 'UNUSABLE']),
  },
) {}

export class CustomerPriceGroupCatalogUnavailable extends Schema.TaggedError<CustomerPriceGroupCatalogUnavailable>()(
  'CustomerPriceGroupCatalogUnavailable',
  { code: Schema.Literal('customer_price_group_catalog_unavailable'), reason: ErrorReasonSchema },
) {}

export class CustomerPriceGroupOverlapConflict extends Schema.TaggedError<CustomerPriceGroupOverlapConflict>()(
  'CustomerPriceGroupOverlapConflict',
  { code: Schema.Literal('customer_price_group_overlap_conflict'), reason: ErrorReasonSchema },
) {}

export class CustomerPriceGroupRevisionConflict extends Schema.TaggedError<CustomerPriceGroupRevisionConflict>()(
  'CustomerPriceGroupRevisionConflict',
  {
    code: Schema.Literal('customer_price_group_revision_conflict'),
    currentRevision: RevisionSchema,
    reason: ErrorReasonSchema,
  },
) {}

export class CustomerPriceGroupAssignmentNotFound extends Schema.TaggedError<CustomerPriceGroupAssignmentNotFound>()(
  'CustomerPriceGroupAssignmentNotFound',
  { code: Schema.Literal('customer_price_group_assignment_not_found'), reason: ErrorReasonSchema },
) {}

export class CustomerPriceGroupRemovalConflict extends Schema.TaggedError<CustomerPriceGroupRemovalConflict>()(
  'CustomerPriceGroupRemovalConflict',
  { code: Schema.Literal('customer_price_group_removal_conflict'), reason: ErrorReasonSchema },
) {}

export class CustomerPriceGroupPersistenceUnavailable extends Schema.TaggedError<CustomerPriceGroupPersistenceUnavailable>()(
  'CustomerPriceGroupPersistenceUnavailable',
  {
    code: Schema.Literal('customer_price_group_persistence_unavailable'),
    reason: ErrorReasonSchema,
  },
) {}

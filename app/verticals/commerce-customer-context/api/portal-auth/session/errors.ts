import { Schema } from 'effect';

const CommercePortalAuthSessionInvalidRequestFields = {
  reason: Schema.String,
} as const;
const CommercePortalAuthSessionInvalidRequestSchema = Schema.TaggedStruct(
  'CommercePortalAuthSessionInvalidRequest',
  CommercePortalAuthSessionInvalidRequestFields,
);
const CommercePortalAuthSessionInvalidRequestValue = Schema.TaggedError<
  typeof CommercePortalAuthSessionInvalidRequestSchema.Type
>()('CommercePortalAuthSessionInvalidRequest', CommercePortalAuthSessionInvalidRequestFields);
export type CommercePortalAuthSessionInvalidRequest = InstanceType<typeof CommercePortalAuthSessionInvalidRequestValue>;
export { CommercePortalAuthSessionInvalidRequestValue as CommercePortalAuthSessionInvalidRequest };

/** A provider/database read or write failed. The caller must not retry an unknown effect blindly. */
const CommercePortalAuthSessionUnavailableFields = {
  operation: Schema.String,
  reason: Schema.String,
} as const;
const CommercePortalAuthSessionUnavailableSchema = Schema.TaggedStruct(
  'CommercePortalAuthSessionUnavailable',
  CommercePortalAuthSessionUnavailableFields,
);
const CommercePortalAuthSessionUnavailableValue = Schema.TaggedError<
  typeof CommercePortalAuthSessionUnavailableSchema.Type
>()('CommercePortalAuthSessionUnavailable', CommercePortalAuthSessionUnavailableFields);
export type CommercePortalAuthSessionUnavailable = InstanceType<typeof CommercePortalAuthSessionUnavailableValue>;
export { CommercePortalAuthSessionUnavailableValue as CommercePortalAuthSessionUnavailable };

const CommercePortalAuthSessionRotationRejectedFields = {
  reason: Schema.String,
} as const;
const CommercePortalAuthSessionRotationRejectedSchema = Schema.TaggedStruct(
  'CommercePortalAuthSessionRotationRejected',
  CommercePortalAuthSessionRotationRejectedFields,
);
const CommercePortalAuthSessionRotationRejectedValue = Schema.TaggedError<
  typeof CommercePortalAuthSessionRotationRejectedSchema.Type
>()('CommercePortalAuthSessionRotationRejected', CommercePortalAuthSessionRotationRejectedFields);
export type CommercePortalAuthSessionRotationRejected = InstanceType<
  typeof CommercePortalAuthSessionRotationRejectedValue
>;
export { CommercePortalAuthSessionRotationRejectedValue as CommercePortalAuthSessionRotationRejected };

const CommercePortalAuthSessionRefreshConflictFields = {
  reason: Schema.String,
} as const;
const CommercePortalAuthSessionRefreshConflictSchema = Schema.TaggedStruct(
  'CommercePortalAuthSessionRefreshConflict',
  CommercePortalAuthSessionRefreshConflictFields,
);
const CommercePortalAuthSessionRefreshConflictValue = Schema.TaggedError<
  typeof CommercePortalAuthSessionRefreshConflictSchema.Type
>()('CommercePortalAuthSessionRefreshConflict', CommercePortalAuthSessionRefreshConflictFields);
export type CommercePortalAuthSessionRefreshConflict = InstanceType<
  typeof CommercePortalAuthSessionRefreshConflictValue
>;
export { CommercePortalAuthSessionRefreshConflictValue as CommercePortalAuthSessionRefreshConflict };

const CommercePortalAuthSessionEvidenceRejectedFields = {
  reason: Schema.String,
} as const;
const CommercePortalAuthSessionEvidenceRejectedSchema = Schema.TaggedStruct(
  'CommercePortalAuthSessionEvidenceRejected',
  CommercePortalAuthSessionEvidenceRejectedFields,
);
const CommercePortalAuthSessionEvidenceRejectedValue = Schema.TaggedError<
  typeof CommercePortalAuthSessionEvidenceRejectedSchema.Type
>()('CommercePortalAuthSessionEvidenceRejected', CommercePortalAuthSessionEvidenceRejectedFields);
export type CommercePortalAuthSessionEvidenceRejected = InstanceType<
  typeof CommercePortalAuthSessionEvidenceRejectedValue
>;
export { CommercePortalAuthSessionEvidenceRejectedValue as CommercePortalAuthSessionEvidenceRejected };

/** Internal provider bridge failure. Raw Better Auth errors are retained only as non-enumerable cause. */
const CommercePortalAuthProviderUnavailableFields = {
  operation: Schema.String,
  reason: Schema.String,
} as const;
const CommercePortalAuthProviderUnavailableSchema = Schema.TaggedStruct(
  'CommercePortalAuthProviderUnavailable',
  CommercePortalAuthProviderUnavailableFields,
);
const CommercePortalAuthProviderUnavailableValue = Schema.TaggedError<
  typeof CommercePortalAuthProviderUnavailableSchema.Type
>()('CommercePortalAuthProviderUnavailable', CommercePortalAuthProviderUnavailableFields);
export type CommercePortalAuthProviderUnavailable = InstanceType<typeof CommercePortalAuthProviderUnavailableValue>;
export { CommercePortalAuthProviderUnavailableValue as CommercePortalAuthProviderUnavailable };

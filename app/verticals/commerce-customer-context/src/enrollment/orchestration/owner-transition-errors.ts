import { Schema } from 'effect';

const ownerEffectErrorFields = {
  code: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200)),
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500)),
} as const;

const CommerceEnrollmentOwnerEffectIndeterminateSchema = Schema.TaggedStruct(
  'CommerceEnrollmentOwnerEffectIndeterminate',
  ownerEffectErrorFields,
);
export const CommerceEnrollmentOwnerEffectIndeterminate = Schema.TaggedError<
  typeof CommerceEnrollmentOwnerEffectIndeterminateSchema.Type
>()('CommerceEnrollmentOwnerEffectIndeterminate', ownerEffectErrorFields);

const CommerceEnrollmentOwnerEffectRejectedSchema = Schema.TaggedStruct(
  'CommerceEnrollmentOwnerEffectRejected',
  ownerEffectErrorFields,
);
export const CommerceEnrollmentOwnerEffectRejected = Schema.TaggedError<
  typeof CommerceEnrollmentOwnerEffectRejectedSchema.Type
>()('CommerceEnrollmentOwnerEffectRejected', ownerEffectErrorFields);

const CommerceEnrollmentOwnerEffectUnavailableSchema = Schema.TaggedStruct(
  'CommerceEnrollmentOwnerEffectUnavailable',
  ownerEffectErrorFields,
);
export const CommerceEnrollmentOwnerEffectUnavailable = Schema.TaggedError<
  typeof CommerceEnrollmentOwnerEffectUnavailableSchema.Type
>()('CommerceEnrollmentOwnerEffectUnavailable', ownerEffectErrorFields);

export type CommerceEnrollmentOwnerEffectError =
  | InstanceType<typeof CommerceEnrollmentOwnerEffectRejected>
  | InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>
  | InstanceType<typeof CommerceEnrollmentOwnerEffectIndeterminate>;

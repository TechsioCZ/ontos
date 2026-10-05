import { Schema } from 'effect';

/** Evidence health is not a fourth business outcome, nor a proven negative promise. */
export const AvailabilityDecisionOutcomeSchema = Schema.Literals(['AVAILABLE', 'UNAVAILABLE', 'INDETERMINATE']);

const AvailabilityEvidenceOwnerSchema = Schema.Literals([
  'CATALOG',
  'COMMERCE_PURCHASING_CONTEXT',
  'ASSORTMENT',
  'INVENTORY',
  'AVAILABILITY_POLICY',
]);

export const AvailabilityOwnerEvidenceUnavailable = Schema.TaggedError<Error>()(
  'AvailabilityOwnerEvidenceUnavailable',
  {
    owner: AvailabilityEvidenceOwnerSchema,
  },
);
export type AvailabilityOwnerEvidenceUnavailableError = InstanceType<typeof AvailabilityOwnerEvidenceUnavailable>;

export const AvailabilityOwnerEvidenceUnverifiable = Schema.TaggedError<Error>()(
  'AvailabilityOwnerEvidenceUnverifiable',
  {
    owner: AvailabilityEvidenceOwnerSchema,
  },
);
export type AvailabilityOwnerEvidenceUnverifiableError = InstanceType<typeof AvailabilityOwnerEvidenceUnverifiable>;

export type AvailabilityOwnerFailure =
  | AvailabilityOwnerEvidenceUnavailableError
  | AvailabilityOwnerEvidenceUnverifiableError;

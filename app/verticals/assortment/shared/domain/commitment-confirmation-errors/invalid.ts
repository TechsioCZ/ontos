import { Schema } from 'effect';

export class AssortmentCommitmentConfirmationInvalid extends Schema.TaggedError<AssortmentCommitmentConfirmationInvalid>()(
  'AssortmentCommitmentConfirmationInvalid',
  { code: Schema.Literal('assortment_confirmation_invalid'), reason: Schema.String },
) {}

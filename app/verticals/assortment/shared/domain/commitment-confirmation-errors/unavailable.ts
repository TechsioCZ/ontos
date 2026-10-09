import { Schema } from 'effect';

export class AssortmentCommitmentConfirmationUnavailable extends Schema.TaggedError<AssortmentCommitmentConfirmationUnavailable>()(
  'AssortmentCommitmentConfirmationUnavailable',
  { code: Schema.Literal('assortment_confirmation_unavailable'), reason: Schema.String },
) {}

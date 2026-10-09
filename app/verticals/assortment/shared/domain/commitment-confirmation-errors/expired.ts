import { Schema } from 'effect';

export class AssortmentCommitmentConfirmationExpired extends Schema.TaggedError<AssortmentCommitmentConfirmationExpired>()(
  'AssortmentCommitmentConfirmationExpired',
  { code: Schema.Literal('assortment_confirmation_expired'), reason: Schema.String },
) {}

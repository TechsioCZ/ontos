import { Schema } from 'effect';

export class AssortmentCommitmentConfirmationScopeMismatch extends Schema.TaggedError<AssortmentCommitmentConfirmationScopeMismatch>()(
  'AssortmentCommitmentConfirmationScopeMismatch',
  { code: Schema.Literal('assortment_confirmation_scope_mismatch'), reason: Schema.String },
) {}

import { Schema } from 'effect';

export class CommercePortalAuthVerificationClientUnavailable extends Schema.TaggedError<CommercePortalAuthVerificationClientUnavailable>()(
  'CommercePortalAuthVerificationClientUnavailable',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}

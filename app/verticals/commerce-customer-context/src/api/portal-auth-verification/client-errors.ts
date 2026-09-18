import { Schema } from 'effect';

export class CommercePortalAuthVerificationClientUnavailable extends Schema.TaggedError<CommercePortalAuthVerificationClientUnavailable>()(
  'CommercePortalAuthVerificationClientUnavailable',
  { reason: Schema.String },
) {}

import { Schema } from 'effect';

export class AssignablePrincipalsUnavailable extends Schema.TaggedError<AssignablePrincipalsUnavailable>()(
  'AssignablePrincipalsUnavailable',
  { reason: Schema.String },
) {}

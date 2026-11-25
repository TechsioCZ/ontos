import { Schema } from 'effect';

/** A fact the enrollment depends on could not be read or written: nothing was committed. */
export class SymmyRouteEnrollmentUnavailable extends Schema.TaggedError<SymmyRouteEnrollmentUnavailable>()(
  'SymmyRouteEnrollmentUnavailable',
  { cause: Schema.optional(Schema.Defect()), reason: Schema.String },
) {}

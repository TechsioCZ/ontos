import { Schema } from 'effect';

/**
 * The caller kind the execution identity implies is not among the requirement's permitted callers.
 * The call executor answers it as `Forbidden`; Core never substitutes another caller kind.
 */
export class CallerNotPermitted extends Schema.TaggedError<CallerNotPermitted>()('CallerNotPermitted', {
  wanted: Schema.Literals(['none', 'person', 'registered', 'workload']),
}) {}

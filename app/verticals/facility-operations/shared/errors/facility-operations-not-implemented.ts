import { Schema } from 'effect';

/** Typed stand-in for command logic that lands in the next task. Removed once every command is implemented. */
export class FacilityOperationsNotImplemented extends Schema.TaggedError<FacilityOperationsNotImplemented>()(
  'FacilityOperationsNotImplemented',
  {
    code: Schema.Literal('facility_operations_not_implemented'),
    reason: Schema.String,
  },
) {}

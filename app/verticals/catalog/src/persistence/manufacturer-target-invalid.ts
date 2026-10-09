import { Schema } from 'effect';

export class ManufacturerTargetInvalid extends Schema.TaggedError<ManufacturerTargetInvalid>()(
  'ManufacturerTargetInvalid',
  { reason: Schema.String },
) {}

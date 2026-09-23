import { Schema } from 'effect';

export class ManufacturerTargetAbsent extends Schema.TaggedError<ManufacturerTargetAbsent>()(
  'ManufacturerTargetAbsent',
  {},
) {}

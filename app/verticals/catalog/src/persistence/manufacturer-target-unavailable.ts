import { Schema } from 'effect';

export class ManufacturerTargetUnavailable extends Schema.TaggedError<ManufacturerTargetUnavailable>()(
  'ManufacturerTargetUnavailable',
  {},
) {}

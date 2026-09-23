import { Schema } from 'effect';

export class ManufacturerTargetForbidden extends Schema.TaggedError<ManufacturerTargetForbidden>()(
  'ManufacturerTargetForbidden',
  {},
) {}

// Adapted generated Action contract error.
import { Schema } from 'effect';

export class OccupancyNotFound extends Schema.TaggedError<OccupancyNotFound>()('OccupancyNotFound', {
  code: Schema.Literal('occupancy_not_found'),
  reason: Schema.String,
}) {}

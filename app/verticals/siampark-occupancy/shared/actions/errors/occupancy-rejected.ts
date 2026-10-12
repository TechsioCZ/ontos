// Adapted generated Action contract error.
import { Schema } from 'effect';

export class OccupancyRejected extends Schema.TaggedError<OccupancyRejected>()('OccupancyRejected', {
  code: Schema.Literal('occupancy_rejected'),
  reason: Schema.String,
}) {}

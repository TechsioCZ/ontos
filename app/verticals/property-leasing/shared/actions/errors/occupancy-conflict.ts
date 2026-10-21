// Adapted generated Action contract error.
import { Schema } from 'effect';

export class OccupancyConflict extends Schema.TaggedError<OccupancyConflict>()('OccupancyConflict', {
  code: Schema.Literal('occupancy_conflict'),
  reason: Schema.String,
}) {}

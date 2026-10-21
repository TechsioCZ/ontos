// Adapted generated Action contract error.
import { Schema } from 'effect';

export class OccupancyPersistenceUnavailable extends Schema.TaggedError<OccupancyPersistenceUnavailable>()(
  'OccupancyPersistenceUnavailable',
  { code: Schema.Literal('occupancy_persistence_unavailable'), reason: Schema.String },
) {}

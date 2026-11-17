/** What the stage warm-up gate has read of its declared set, and the failure for having read less than all of it. */
import { Schema } from 'effect';

/** Every persona that completed, and how much of the declared set the gate has read so far. */
export interface WarmupCoverage {
  readonly coveredPersonas: readonly string[];
  readonly declaredDestinations: number;
  readonly visitedDestinations: number;
}

/**
 * The budget expired before every declared persona and destination had been read, so the only stage-side gate against
 * a visible UUID, internal key or digest did not run over its declared set. It used to be a warning and exit 0.
 */
export class StageWarmupIncompleteError extends Schema.TaggedError<StageWarmupIncompleteError>()(
  'StageWarmupIncompleteError',
  {
    declaredDestinations: Schema.Number,
    declaredPersonas: Schema.Number,
    durationMs: Schema.Number,
    uncoveredPersonas: Schema.Array(Schema.String),
    visitedDestinations: Schema.Number,
  },
) {}

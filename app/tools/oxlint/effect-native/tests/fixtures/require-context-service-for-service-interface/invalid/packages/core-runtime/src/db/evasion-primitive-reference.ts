// expect-count: 1
import { Context, Effect } from 'effect';

/** A `Context.Reference` over a primitive carries no contract, yet it blanks per-contract matching. */
export class VerboseLogging extends Context.Reference<VerboseLogging>()(
  '@app/core-runtime/db/VerboseLogging',
  { defaultValue: () => false },
) {}

export interface AuditTrailRepository {
  readonly append: (entry: string) => Effect.Effect<void, Error>;
}

export const append = (repository: AuditTrailRepository): Effect.Effect<void, Error> =>
  repository.append('entry');

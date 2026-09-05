import { Effect } from 'effect';

/** `scripts/` is out of scope: operational scripts are migrated separately (audit B3). */
export interface ScaffoldWriterService {
  readonly write: (path: string) => Effect.Effect<void, Error>;
}

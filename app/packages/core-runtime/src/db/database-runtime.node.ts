import { Effect } from 'effect';

import type { DatabaseRuntime } from './database-runtime.ts';

/** Node reads every identity's URL key from the process environment and the app `.env`. */
export const databaseRuntime: DatabaseRuntime = Object.freeze<DatabaseRuntime>({
  runtimeDatabaseProvider: (base) => Effect.succeed(base),
});

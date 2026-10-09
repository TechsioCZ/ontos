import { Effect } from 'effect';

import type { DatabaseRuntime } from './database-runtime.ts';

/** Node reads `DATABASE_URL` from the process environment and the app `.env`. */
export const databaseRuntime: DatabaseRuntime = Object.freeze<DatabaseRuntime>({
  runtimeDatabaseProvider: Effect.succeed,
});

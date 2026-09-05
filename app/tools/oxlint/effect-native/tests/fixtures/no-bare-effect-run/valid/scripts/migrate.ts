import { Effect } from 'effect';

declare const migration: Effect.Effect<void>;

/** Operational scripts are B3 territory; one process-exit adapter at the executable edge. */
Effect.runPromise(migration).catch(() => process.exit(1));

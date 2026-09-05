import { Effect } from 'effect';

class ScriptFailure {}
declare const run: () => Promise<void>;

// Operational scripts are migrated separately (audit B3) and are out of scope here.
export const program = Effect.tryPromise({ try: run, catch: () => new ScriptFailure() });

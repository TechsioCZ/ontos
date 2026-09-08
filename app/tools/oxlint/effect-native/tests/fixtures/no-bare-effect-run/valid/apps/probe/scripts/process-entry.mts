import { Effect } from 'effect';
// Workspace-local scripts are governed by B3, not the library rule.
await Effect.runPromise(Effect.succeed(1));

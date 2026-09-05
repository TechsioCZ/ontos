// expect-count: 3
// Evasion: the module-level run is wrapped in an immediately invoked async arrow.
import { Effect } from 'effect';

declare const program: Effect.Effect<void>;

void (async () => {
  await Effect.runPromise(program);
})();

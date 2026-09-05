// expect-count: 3
// Evasion: the module-level run is a bare member reference handed to a callback slot.
import { Effect } from 'effect';

declare const programs: ReadonlyArray<Effect.Effect<void>>;

programs.forEach(Effect.runPromise);

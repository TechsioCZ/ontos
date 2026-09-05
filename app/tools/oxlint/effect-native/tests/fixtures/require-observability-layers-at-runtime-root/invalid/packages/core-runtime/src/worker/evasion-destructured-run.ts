// expect-count: 3
// Evasion: module-level process entry through a destructured `runPromise` import.
import { runPromise } from 'effect/Effect';

declare const program: never;

void runPromise(program);

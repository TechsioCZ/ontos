// expect-count: 3
// Point-free module-level run through `pipe` — same root, same missing observability.
import { Effect, pipe } from 'effect';

declare const program: Effect.Effect<void>;

void pipe(program, Effect.runPromise);

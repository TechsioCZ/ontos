// A leaf module: it runs an Effect inside a function and is not a runtime root. A6 asks nothing of it.
import { Effect } from 'effect';

export const adapt = (program: Effect.Effect<void>): Promise<void> => Effect.runPromise(program);

export const traced = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.withSpan('leaf.operation'), Effect.annotateLogs({ module: 'lib' }));

// expect-count: 4
import { NodeRuntime } from '@effect/platform-node';
import { Effect } from 'effect';

export const library = () => NodeRuntime.runMain(program.pipe(Effect.provide(live)));
Effect.flatMap(program, () => NodeRuntime.runMain(program.pipe(Effect.provide(live))));
NodeRuntime.runMain(Effect.suspend(() => program.pipe(Effect.provide(live))));
NodeRuntime.runMain(
  Effect.gen(function* serviceBody() {
    yield* program.pipe(Effect.provide(live));
  }),
);

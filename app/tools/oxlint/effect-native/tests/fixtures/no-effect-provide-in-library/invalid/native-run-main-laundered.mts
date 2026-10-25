// expect-count: 3
import { NodeRuntime } from '@effect/platform-node';
import { Effect } from 'effect';

NodeRuntime.runMain(Effect.succeed(program.pipe(Effect.provide(live))));
NodeRuntime.runMain(Effect.all([program.pipe(Effect.provide(live))]));
NodeRuntime.runMain(Effect.succeed({ ready: Effect.provide(program, live) }));

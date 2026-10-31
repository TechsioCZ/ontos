// expect-count: 2
import { NodeRuntime } from '@effect/platform-node';
import { Effect } from 'effect';

NodeRuntime.runMain(program.pipe(Effect.provide(live)));
Effect.runFork(program.pipe(Effect.provide(live)));

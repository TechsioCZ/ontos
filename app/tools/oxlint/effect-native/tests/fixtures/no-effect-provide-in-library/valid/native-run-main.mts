import { NodeRuntime, NodeRuntime as Runtime } from '@effect/platform-node';
import * as Platform from '@effect/platform-node';
import * as NativeRuntime from '@effect/platform-node/NodeRuntime';
import { runMain as start } from '@effect/platform-node/NodeRuntime';
import { Effect, Layer, pipe } from 'effect';

declare const program: Effect.Effect<void>;
declare const live: Layer.Layer<never>;

if (import.meta.main) {
  NodeRuntime.runMain(program.pipe(Effect.provide(live)));
}
Runtime.runMain(Effect.provide(program, live));
Platform.NodeRuntime.runMain(program.pipe(Effect.provide(live)));
NativeRuntime.runMain(program.pipe(Effect.provide(live)));
start(program.pipe(Effect.provide(live)));
program.pipe(Effect.provide(live), Runtime.runMain);
pipe(program, Effect.provide(live), start);

const main = () => NativeRuntime.runMain(program.pipe(Effect.provide(live)));
main();
(() => NodeRuntime.runMain(program.pipe(Effect.provide(live))))();

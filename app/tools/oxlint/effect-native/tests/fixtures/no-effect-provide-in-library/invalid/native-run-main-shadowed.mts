// expect-count: 4
import { NodeRuntime } from '@effect/platform-node';
import * as Platform from '@effect/platform-node';
import * as NativeRuntime from '@effect/platform-node/NodeRuntime';
import { runMain as start } from '@effect/platform-node/NodeRuntime';
import { Effect } from 'effect';

{
  const NodeRuntime = { runMain: (value: unknown) => value };
  NodeRuntime.runMain(program.pipe(Effect.provide(live)));
}
{
  const Platform = { NodeRuntime: { runMain: (value: unknown) => value } };
  Platform.NodeRuntime.runMain(program.pipe(Effect.provide(live)));
}
{
  const NativeRuntime = { runMain: (value: unknown) => value };
  NativeRuntime.runMain(program.pipe(Effect.provide(live)));
}
{
  const start = (value: unknown) => value;
  start(program.pipe(Effect.provide(live)));
}

// expect-count: 6
import { NodeRuntime as FakeRuntime } from './fake-runtime.ts';
import * as FakePlatform from '@effect/platform-node-lookalike';
import { runMain as fakeStart } from './NodeRuntime.ts';
import type { NodeRuntime as TypeRuntime } from '@effect/platform-node';
import { type runMain as typeStart } from '@effect/platform-node/NodeRuntime';
import { Effect } from 'effect';

FakeRuntime.runMain(program.pipe(Effect.provide(live)));
FakePlatform.NodeRuntime.runMain(program.pipe(Effect.provide(live)));
fakeStart(program.pipe(Effect.provide(live)));
TypeRuntime.runMain(program.pipe(Effect.provide(live)));
typeStart(program.pipe(Effect.provide(live)));
const unrelated = { runMain: (value: unknown) => value };
unrelated.runMain(program.pipe(Effect.provide(live)));

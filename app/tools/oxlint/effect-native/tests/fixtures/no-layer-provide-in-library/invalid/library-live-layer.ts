// expect-count: 5
import { Effect, Layer } from 'effect';

import { ContextAccess, ContextAccessLive } from './context-access.ts';
import { ModuleStateGate, ModuleStateGateLive } from './module-state-gate.ts';
import { Gateway, makeGateway } from './gateway.ts';

// A1: a library Live layer that provides its own dependency hides `ModuleStateGate` from `RIn`.
export const GatewayLive = Layer.effect(
  Gateway,
  ModuleStateGate.pipe(Effect.map(makeGateway)),
).pipe(Layer.provide(ModuleStateGateLive));

// A1: a stack of provides at the bottom of a library runtime module.
export const RuntimeLive = Layer.effect(Gateway, Effect.succeed(makeGateway)).pipe(
  Layer.provide(ModuleStateGateLive),
  Layer.provide(ContextAccessLive),
  Layer.provideMerge(Layer.succeed(ContextAccess, ContextAccessLive)),
);

// A1: the `Layer.fresh` workaround the audit calls out is driven by the provide above it.
export const makeRuntimeLive = (contextAccessLayer: Layer.Layer<ContextAccess>) =>
  RuntimeLive.pipe(Layer.provide(contextAccessLayer), Layer.fresh);

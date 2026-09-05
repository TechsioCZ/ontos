// The A1 target shape: dependencies stay in `RIn`, nothing is provided locally.
import { Effect, Layer } from 'effect';

import { ModuleStateGate } from './module-state-gate.ts';
import { Gateway, makeGateway } from './gateway.ts';

export const GatewayLive: Layer.Layer<Gateway, never, ModuleStateGate> = Layer.effect(
  Gateway,
  ModuleStateGate.pipe(Effect.map(makeGateway)),
);

// Every other `Layer` combinator remains available inside libraries.
export const GraphLive = Layer.mergeAll(GatewayLive, Layer.succeed(Gateway, makeGateway));
export const ScopedLive = Layer.scoped(Gateway, Effect.succeed(makeGateway));
export const MergedLive = Layer.merge(GraphLive, ScopedLive);
export const FreshLive = Layer.fresh(GraphLive);
export const EmptyLive = Layer.empty;

// D tier: `Layer.orDie` at a deliberate startup boundary is explicitly preserved by the audit.
export const StartupLive = Layer.orDie(GraphLive);

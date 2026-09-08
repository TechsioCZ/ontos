// Declared browser runtime root with full observability, written with generics, JSX and `satisfies`.
import { NodeSdk, OtelLogger } from '@effect/opentelemetry';
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const uiLayer: Layer.Layer<never>;

const observability = Layer.mergeAll(
  OtelLogger.layer,
  NodeSdk.layer(() => ({ resource: { serviceName: 'web' } })),
) satisfies Layer.Layer<never>;

export const runtime = ManagedRuntime.make(
  Layer.provide(uiLayer, observability),
);

export const bounded = <A,>(program: Effect.Effect<A>) =>
  Effect.withMinimumLogLevel(program, 'Info');

export async function* drain(): AsyncGenerator<number> {
  yield 1;
}

export const Panel = () => <section>{`ontos`}</section>;

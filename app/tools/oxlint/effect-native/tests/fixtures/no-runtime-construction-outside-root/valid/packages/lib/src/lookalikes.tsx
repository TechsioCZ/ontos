import { Effect, Layer, ManagedRuntime } from 'effect';

declare const target: Layer.Layer<never>;

// Not effect's namespaces.
const Runtimes = { make: <A,>(a: A): A => a };
const layers = { launch: <A,>(a: A): A => a };

export const notEffect = Runtimes.make(target);
export const notLayer = layers.launch(target);

export const shadowed = (() => {
  // A local shadow named `ManagedRuntime` is not the effect import.
  const ManagedRuntime = { make: <A,>(a: A): A => a };
  return ManagedRuntime.make(target);
})();

export const shadowedParam = (Layer: { launch: <A>(a: A) => A }): unknown => Layer.launch(target);

// Members that are not runtime construction.
export const alive = ManagedRuntime.isManagedRuntime(target);
export const made = Layer.effect(Symbol.for('x') as never, Effect.succeed(1));
export const other = Effect.gen(function* () {
  return yield* Effect.succeed(1);
});

// Property keys and JSX attributes named like the members.
export const config = { make: true, launch: 'now', runtime: 'edge' } as const;
export const read = config.make;
export const Element = () => <div data-launch="launch" title={String(config.runtime)} />;

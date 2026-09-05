// Same member names on things that are not effect's `Effect`/`Cause`.
import { Cause, Effect, Layer } from 'effect';

declare const cause: Cause.Cause<never>;
declare const layer: Layer.Layer<never>;

// Not effect's Cause namespace.
const Causes = { hasDies: (_: unknown): boolean => false };

export const notEffectCause = Causes.hasDies(cause);

export const shadowed = ((): boolean => {
  // A local shadow named `Cause` is not the effect import.
  const Cause = { hasDies: (_: unknown): boolean => true };
  return Cause.hasDies(cause);
})();

export const parameterShadow = (Effect: { readonly catchDefect: <A>(a: A) => A }): unknown =>
  Effect.catchDefect(cause);

// `Layer.catchCause` is layer composition, not a request-path defect seam.
export const recovered = layer.pipe(Layer.catchCause(() => layer));

export const key = { hasDies: true, catchDefect: true } as const;
export const property = key.hasDies;
export const Element = (): JSX.Element => <div data-seam="Cause.hasDies">{String(property)}</div>;

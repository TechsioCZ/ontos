import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;

// A `typeof` type query is a type-level reference, not a call.
export type OrDieSignature = typeof Layer.orDie;
export type OrDieArgs = Parameters<typeof Layer.orDieWith>;

export const transparent = Base.pipe(Layer.provide(Base));

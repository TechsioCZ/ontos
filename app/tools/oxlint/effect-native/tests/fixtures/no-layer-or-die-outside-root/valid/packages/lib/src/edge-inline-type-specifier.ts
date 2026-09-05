import { type Layer, Effect } from 'effect';
import { type orDie, provide } from 'effect/Layer';

declare const Base: Layer.Layer<never>;
declare const Other: Layer.Layer<never>;

// Inline `type` specifiers are erased; the value imports beside them are not `orDie`.
export type Signature = typeof orDie;
export type Namespaced = typeof Layer.orDie;
export const transparent = Base.pipe(provide(Other));
export const logged = Effect.logError('composition failed');

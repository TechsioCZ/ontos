// D tier: deliberate startup orDie with typed logging; A4: preserve the original cause.
import { Effect, Layer } from 'effect';
declare const layer: Layer.Layer<never, unknown>;
export const startup = layer.pipe(Layer.tapErrorCause(Effect.logError), Layer.orDie);
export function shadow(Cause: {hasDies: (cause: unknown) => boolean}, cause: unknown) { const C = Cause; return C.hasDies(cause); }

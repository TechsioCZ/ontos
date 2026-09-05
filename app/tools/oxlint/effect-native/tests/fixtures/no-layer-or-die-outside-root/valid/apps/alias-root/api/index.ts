import { Effect, Layer } from 'effect';
declare const source: Layer.Layer<never, unknown>;
const die = (Layer.orDie satisfies typeof Layer.orDie);
const startupDie = (die as typeof die);
export const layer = source.pipe(Layer.tapErrorCause(Effect.logError), startupDie);

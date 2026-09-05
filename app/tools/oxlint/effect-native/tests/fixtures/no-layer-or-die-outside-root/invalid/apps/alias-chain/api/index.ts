// expect-count: 1
import { Effect, Layer } from 'effect';
declare const source: Layer.Layer<never, unknown>;
const die = Layer.orDie;
const startupDie = die;
export const layer = source.pipe(startupDie, Layer.tapErrorCause(Effect.logError), startupDie);

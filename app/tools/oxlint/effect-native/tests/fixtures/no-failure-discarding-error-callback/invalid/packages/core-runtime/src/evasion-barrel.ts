// expect-count: 2
// Root-barrel namespace import: `Barrel.Effect.mapError`.
import * as EffectBarrel from 'effect';

class Unavailable {}
declare const load: EffectBarrel.Effect.Effect<number, Error>;

export const mapped = load.pipe(EffectBarrel.Effect.mapError(() => new Unavailable()));
export const dataFirst = EffectBarrel.Effect.catchAll(load, () => EffectBarrel.Effect.succeed(0));

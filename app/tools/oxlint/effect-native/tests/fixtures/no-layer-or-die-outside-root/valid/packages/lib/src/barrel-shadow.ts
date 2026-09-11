import { Layer } from '@modern-js/bff-effect/effect-edge';

declare const target: Layer.Layer<never>;

export const build = (Layer: { orDie: <A>(value: A) => A }): unknown => Layer.orDie(target);

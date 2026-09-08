import { Layer } from '@modern-js/plugin-bff/effect-edge';

declare const target: Layer.Layer<never>;

export const build = (Layer: { orDie: <A>(value: A) => A }): unknown => Layer.orDie(target);

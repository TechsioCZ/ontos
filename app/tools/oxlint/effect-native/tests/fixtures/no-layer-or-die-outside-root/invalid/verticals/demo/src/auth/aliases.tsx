// expect-count: 5
import { Layer as L } from 'effect';
import * as LayerNs from 'effect/Layer';
import * as EffectNs from 'effect';
import { orDie as die } from 'effect/Layer';

declare const Base: L.Layer<never>;
declare const pipe: <A>(a: A, ...fs: ReadonlyArray<(a: never) => never>) => A;

export const aliased = Base.pipe(L.orDie);
export const namespaced = LayerNs.orDie(Base);
export const rootNamespaced = EffectNs.Layer.orDie(Base);
export const direct = pipe(Base, die);
export const computed = LayerNs['orDie'](Base);

export const Element = () => <div>{String(aliased)}</div>;

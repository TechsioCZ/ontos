// expect-count: 5
import { Layer as L } from 'effect';
import * as LayerNs from 'effect/Layer';
import * as EffectNs from 'effect';
import { fresh as freshLayer } from 'effect/Layer';

declare const Base: L.Layer<never>;
declare const pipe: <A>(a: A, ...fs: ReadonlyArray<(a: never) => never>) => A;

export const aliased = Base.pipe(L.fresh);
export const namespaced = LayerNs.fresh(Base);
export const rootNamespaced = EffectNs.Layer.fresh(Base);
export const direct = pipe(Base, freshLayer);
export const computed = LayerNs['fresh'](Base);

export const Element = () => <div>{String(aliased)}</div>;

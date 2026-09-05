import { Layer } from 'effect';
import * as EffectNs from 'effect';

declare const Base: Layer.Layer<never>;

// Destructuring blessed members off the namespace is fine — only `fresh` is banned.
const { mergeAll, provide } = Layer;
const { Layer: RootLayer } = EffectNs;

export const composed = mergeAll(Base, RootLayer.empty);
export const provided = Base.pipe(provide(Base));

// `fresh` destructured from something that is not the effect Layer module.
const cache = { fresh: (value: unknown): unknown => value };
const { fresh } = cache;
export const cached = fresh(Base);

// A dynamic import of an unrelated module.
export async function other(): Promise<unknown> {
  const mod = await import('./local-cache.ts');
  return mod.fresh(Base);
}

import { Layer } from 'effect';

declare const target: unknown;
interface Freshener { fresh: (value: unknown) => unknown }

export function inCatch(): unknown {
  try { return null; } catch (Layer) { return (Layer as Freshener).fresh(target); }
}

export function inLoop(items: readonly Freshener[]): unknown[] {
  const out: unknown[] = [];
  for (const Layer of items) out.push(Layer.fresh(target));
  return out;
}

export const inClassShadow = (() => {
  class Layer { static fresh(value: unknown): unknown { return value; } }
  return Layer.fresh(target);
})();

// The real import is still used, for a blessed member.
export const composed = Layer.merge;

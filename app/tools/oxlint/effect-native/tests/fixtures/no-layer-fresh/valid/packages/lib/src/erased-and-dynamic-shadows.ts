import { fresh } from 'effect/Layer';
import type * as TypeLayer from 'effect/Layer';
export type Fresh = typeof fresh;
export type TypedFresh = typeof TypeLayer.fresh;

const Layer = await import('effect/Layer');
export function unrelated(Layer: { fresh(): number }) {
  return Layer.fresh();
}
void Layer;

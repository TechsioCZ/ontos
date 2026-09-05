// expect-count: 5
import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;

export class Holder {
  readonly instance = Layer.fresh(Base);
  static readonly shared = Layer['fresh'](Base);
  static { void Layer.fresh(Base); }
  // A method literally named `fresh` is not a reference to the effect member.
  fresh() { return this.instance; }
}

export async function* stream() {
  yield Layer.fresh?.(Base);
}

export const nested = () => () => () => <div>{String(Layer.fresh(Base))}</div>;

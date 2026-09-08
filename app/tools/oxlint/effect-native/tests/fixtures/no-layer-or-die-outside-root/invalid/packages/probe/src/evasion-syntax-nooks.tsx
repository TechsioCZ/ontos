// expect-count: 10
import { Layer } from 'effect';

declare const Base: Layer.Layer<never>;
declare const dec: (value: unknown) => (target: unknown, context: unknown) => void;
declare const toDefect: (cause: unknown) => unknown;

class Runtime {
  static readonly live = Base.pipe(Layer.orDie);
  readonly boundary = Layer.orDie(Base);
  static {
    void Layer['orDie'](Base);
  }
  async *stream() {
    yield Layer?.orDie?.(Base);
  }
  @dec(Layer.orDie(Base))
  accessor tagged = 1;
  make(build = Layer.orDieWith(toDefect)) {
    return build;
  }
  get lazy() {
    return () => () => Layer.orDie(Base);
  }
}

const template = `${String(Layer.orDie(Base))}`;
const casted = Layer.orDie(Base) as unknown as string;

export const Element = () => (
  <div title={String(Layer.orDie(Base))}>
    {template}
    {casted}
    {String(new Runtime())}
  </div>
);

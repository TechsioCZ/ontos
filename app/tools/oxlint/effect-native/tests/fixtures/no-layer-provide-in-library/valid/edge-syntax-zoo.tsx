// Pathological syntax with no `effect` import at all: decorators, private fields, async generators,
// template literals, `satisfies`, JSX. Nothing here is the effect `Layer` module.
import { Layer } from './canvas/layer.ts';

const decorate = (): ClassDecorator => () => undefined;

@decorate()
class Board {
  static readonly styles = Layer['provide'](`grid`);
  readonly #overlay = Layer?.provideMerge('overlay');
  async *frames(): AsyncGenerator<string> {
    yield Layer.provide('frame');
  }
  get label(): string {
    return `${this.#overlay}`;
  }
}

export const View = (): JSX.Element => <div data-styles={Board.styles satisfies string}>board</div>;

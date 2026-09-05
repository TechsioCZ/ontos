// expect-count: 2
// Robustness: decorators and async generators must parse and must not hide the anti-pattern.
import { Layer } from 'effect';

import { DepLive, GatewayLive } from './gateway.ts';

const trace = (): MethodDecorator => () => undefined;

class RuntimeHost {
  @trace()
  build() {
    return GatewayLive.pipe(Layer.provide(DepLive));
  }

  async *stream(): AsyncGenerator<unknown> {
    yield GatewayLive.pipe(Layer.provideMerge(DepLive));
  }
}

export { RuntimeHost };

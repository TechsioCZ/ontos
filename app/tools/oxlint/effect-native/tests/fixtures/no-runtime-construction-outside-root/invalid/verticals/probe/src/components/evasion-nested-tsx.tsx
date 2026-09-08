// expect-count: 4
// Regression probe: deeply nested positions in a TSX file (generic arrow, async generator, class
// property, decorator argument, JSX expression container) must all still report.
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const BrowserLive: Layer.Layer<never>;
declare function inject(value: unknown): ClassDecorator;

export const wrap = <T,>(value: T): T => value;

@inject(wrap(() => ManagedRuntime.make(BrowserLive)))
export class Host {
  readonly runtime = ManagedRuntime.make(BrowserLive);

  async *stream(): AsyncGenerator<unknown> {
    yield Layer.toRuntime(BrowserLive);
  }
}

export const Panel = () => (
  <>
    <section title={`${String(ManagedRuntime.make(BrowserLive))}`}>
      {String(Effect.succeed(1))}
    </section>
  </>
);

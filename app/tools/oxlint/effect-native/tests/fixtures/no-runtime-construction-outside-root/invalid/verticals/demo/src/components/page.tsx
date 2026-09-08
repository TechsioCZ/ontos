// expect-count: 2
// A browser component outside `src/runtime/**` must not own a runtime (A1 + A9 adapter seam).
import { Effect, Layer, ManagedRuntime } from 'effect';

declare const BrowserLive: Layer.Layer<never>;

const { make } = ManagedRuntime;
const componentRuntime = make(BrowserLive);

export const Page = () => {
  const label = String(Layer.toRuntime);
  return <div title={label}>{String(componentRuntime.runSync(Effect.succeed('ok')))}</div>;
};

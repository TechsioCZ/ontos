// expect-count: 3
// Evasion: optional chaining on a static class member inside a TSX module.
import { Layer, ManagedRuntime } from 'effect';

declare const uiLayer: Layer.Layer<never>;

export class Host {
  static readonly runtime = ManagedRuntime?.make(uiLayer);

  render() {
    return <div data-runtime={String(Host.runtime)}>ontos</div>;
  }
}

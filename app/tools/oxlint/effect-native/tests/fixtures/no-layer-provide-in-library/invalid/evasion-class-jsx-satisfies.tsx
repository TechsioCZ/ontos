// expect-count: 6
// Robustness: class members, nested arrow bodies, optional + computed access, `as`/`satisfies`
// expressions and JSX expression containers must not hide the anti-pattern.
import { Layer as L, pipe } from 'effect';

import { DepLive, Gateway, GatewayLive } from './gateway.ts';

type GatewayGraph = L.Layer<Gateway>;

class Composer {
  static readonly live = GatewayLive.pipe(L.provide(DepLive));
  readonly merged = pipe(GatewayLive, L.provideMerge(DepLive));
  readonly build = () => () => GatewayLive.pipe(L?.['provide'](DepLive));
}

export const cast = GatewayLive.pipe(L.provide(DepLive)) as GatewayGraph;
export const checked = GatewayLive.pipe(L.provideMerge(DepLive)) satisfies GatewayGraph;

export const Panel = (): JSX.Element => (
  <section data-live={String(GatewayLive.pipe(L.provide(DepLive)) !== undefined)}>
    {String(new Composer().merged !== undefined)}
  </section>
);

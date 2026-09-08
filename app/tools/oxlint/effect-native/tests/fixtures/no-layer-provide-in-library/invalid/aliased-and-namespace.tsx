// expect-count: 3
import { Effect as Fx, Layer as L } from 'effect';
import * as LayerModule from 'effect/Layer';

import { Repository, RepositoryLive } from './repository.ts';
import { Widget, WidgetLive, makeWidget } from './widget.ts';

// Aliased named import still resolves to the effect `Layer` module.
export const WidgetServiceLive = L.effect(Widget, Fx.succeed(makeWidget)).pipe(
  L.provide(RepositoryLive),
);

// Namespace import of the `effect/Layer` submodule.
export const RepositoryServiceLive = LayerModule.effect(Repository, Fx.succeed(makeWidget)).pipe(
  LayerModule.provide(WidgetLive),
  LayerModule.provideMerge(RepositoryLive),
);

export const Panel = (): JSX.Element => <section data-layer="widget">panel</section>;

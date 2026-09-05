// Application composition root (`rootFiles`): composing the whole graph here is the A1 target.
import { Layer } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/http';

import { Api } from './api.ts';
import { ActionRuntimeLive, CorePersistenceLive, ReadRuntimeLive } from './runtime.ts';

const apiHandlersLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(Layer.mergeAll(ActionRuntimeLive, ReadRuntimeLive)),
  Layer.provide(CorePersistenceLive),
);

export const ApiLive = apiHandlersLive.pipe(Layer.provideMerge(CorePersistenceLive));

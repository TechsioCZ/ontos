// expect-count: 2
import { Effect, Layer } from '@modern-js/plugin-bff/effect-edge';
import * as Edge from '@modern-js/plugin-bff/effect-edge';

declare const CorePersistenceLive: Layer.Layer<never>;
declare const ActionRuntimeLive: Layer.Layer<never>;
declare const ReadRuntimeLive: Layer.Layer<never>;
declare const ApiLayer: Layer.Layer<never>;

// The Modern.js edge barrel re-exports Effect verbatim, so this is still `Layer.orDie`.
const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);
const readRuntimeLive = Edge.Layer.orDie(ReadRuntimeLive);

export const layer = ApiLayer.pipe(
  Layer.provide(Layer.mergeAll(actionRuntimeLive, readRuntimeLive)),
  Layer.tapErrorCause(Effect.logError),
  Layer.orDie,
);

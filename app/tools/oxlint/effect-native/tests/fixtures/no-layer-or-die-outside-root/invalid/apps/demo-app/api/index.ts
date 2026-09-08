// expect-count: 3
import { Layer } from 'effect';

declare const CorePersistenceLive: Layer.Layer<never>;
declare const ActionRuntimeLive: Layer.Layer<never>;
declare const ApiKeyServiceLive: Layer.Layer<never>;
declare const TenantModuleStateServiceLive: Layer.Layer<never>;
declare const HttpApiBuilderLayer: Layer.Layer<never>;

// Startup root: only the final, outermost `Layer.orDie` is allowed.
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(
  Layer.provide(CorePersistenceLive),
  Layer.orDie,
);
const apiKeyServiceLive = ApiKeyServiceLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);
const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);

export const layer = HttpApiBuilderLayer.pipe(
  Layer.provide(Layer.mergeAll(tenantModuleStateServiceLive, apiKeyServiceLive, actionRuntimeLive)),
  Layer.orDie,
);

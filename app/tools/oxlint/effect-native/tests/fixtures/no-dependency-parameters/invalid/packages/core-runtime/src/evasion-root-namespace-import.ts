// expect-count: 2
import * as Effect from "effect";

interface AuthenticationService {
  readonly verify: () => void;
}
interface TenantModuleStateService {
  readonly states: readonly string[];
}

// 1-2: whole Layers, reached through a root namespace import of `effect`.
export const makeApiRuntime = (
  authenticationLayer: Effect.Layer.Layer<AuthenticationService>,
  moduleStateLayer: Effect.Layer.Layer<TenantModuleStateService>,
) => [authenticationLayer, moduleStateLayer];

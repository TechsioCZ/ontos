// expect-count: 5
import { Layer as EffectLayer } from "effect";
import * as Layer from "effect/Layer";

interface AuthenticationService {
  readonly verify: () => void;
}
interface TenantModuleStateService {
  readonly states: readonly string[];
}
declare const tenantModuleStateServiceLive: Layer.Layer<TenantModuleStateService>;

// 1-3: whole Layers handed in positionally (A1 evidence).
export const makeShellAuthenticationApiRuntime = (
  authenticationLayer: Layer.Layer<AuthenticationService>,
  moduleStateLayer: Layer.Layer<TenantModuleStateService> = tenantModuleStateServiceLive,
  aliasedLayer: EffectLayer.Layer<AuthenticationService>,
) => [authenticationLayer, moduleStateLayer, aliasedLayer];

// 4: rest parameter of layers.
export function composeAll(...layers: Layer.Layer<AuthenticationService>[]) {
  return layers;
}

// 5: the service type itself, via a method signature.
export interface ShellApi {
  register(authentication: AuthenticationService): void;
}

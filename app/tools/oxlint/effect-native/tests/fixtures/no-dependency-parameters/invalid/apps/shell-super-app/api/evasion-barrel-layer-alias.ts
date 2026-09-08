// expect-count: 2
import { Layer as Lyr } from "@modern-js/plugin-bff/effect-edge";

interface AuthenticationService {
  readonly verify: () => void;
}
interface TenantModuleStateService {
  readonly states: readonly string[];
}

// 1-2: the same A1 shape as `apps/shell-super-app/api/index.ts:1694`, with the re-export
// barrel's `Layer` bound under a local alias.
export const makeShellAuthenticationApiRuntime = (
  authenticationLayer: Lyr.Layer<AuthenticationService>,
  moduleStateLayer: Lyr.Layer<TenantModuleStateService>,
) => [authenticationLayer, moduleStateLayer];

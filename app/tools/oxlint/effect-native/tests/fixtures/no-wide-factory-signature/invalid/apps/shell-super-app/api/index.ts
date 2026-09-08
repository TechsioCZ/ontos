// expect-count: 2
import { Effect, Layer } from 'effect';

/** B4 evidence: eight positional parameters, six of them defaulted layers and flags. */
export const makeShellAuthenticationApiRuntime = (
  authenticationLayer: Layer.Layer<AuthenticationService>,
  issuerDependencies: GatewayIssuerDependencies,
  moduleStateLayer: Layer.Layer<TenantModuleStateService> = tenantModuleStateServiceLive,
  loadInstalledModuleCatalog?: Effect.Effect<InstalledModuleCatalog>,
  enableInstalledOutboxMatcher = false,
  contextAccessLayer: Layer.Layer<ContextAccess> = ContextAccessLive,
  resourceGateways: ShellResourceGateways = unavailableResourceGateways,
  scopedModuleStateFactory: ShellScopedModuleStateFactory = (transaction) =>
    makeTenantModuleStateService({ executor: transaction }),
) => ({
  authenticationLayer,
  contextAccessLayer,
  enableInstalledOutboxMatcher,
  issuerDependencies,
  loadInstalledModuleCatalog,
  moduleStateLayer,
  resourceGateways,
  scopedModuleStateFactory,
});

export const shellResources = {
  /** Object-literal method: same positional wiring, one level deeper. */
  createResourceGateway(moduleKey: string, tenant: string, principal: string, clock: ClockService) {
    return { clock, moduleKey, principal, tenant };
  },
  /** Allowed: within the limit and no option bag. */
  createResourceKey(moduleKey: string, tenant: string) {
    return `${moduleKey}:${tenant}`;
  },
};

export const apiRuntime = makeShellAuthenticationApiRuntime(authenticationServiceLive, gatewayIssuerLiveDependencies);

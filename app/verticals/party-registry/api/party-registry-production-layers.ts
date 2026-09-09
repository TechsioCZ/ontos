import {
  ActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  CoreSearchProjectionStoreLive,
  CoreSearchQueryRuntimeLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { Layer } from '@modern-js/plugin-bff/effect-edge';
import { FetchHttpClient } from 'effect/unstable/http';

import { AresSubjectServiceLive } from '../src/integrations/ares/ares-subject.service.ts';
import { PartySearchProjectionGatewayLive } from '../src/search/parties.provider.ts';

const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const readRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive)),
  OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive))),
);
export const partyRegistryReadRuntimeLive = ReadRuntimeLive.pipe(Layer.provide(readRuntimeDependenciesLive));

const actionRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ActionRepositoryLive,
  ActionPermissionLive,
  ContextAccessLive,
  moduleStateGateLive,
  ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive)),
  OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive))),
);
export const partyRegistryActionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(actionRuntimeDependenciesLive));

export const partyRegistryAresSubjectServiceLive = AresSubjectServiceLive.pipe(Layer.provide(FetchHttpClient.layer));

const coreSearchQueryRuntimeLive = CoreSearchQueryRuntimeLive.pipe(
  Layer.provide(CoreSearchProjectionStoreLive),
  Layer.provide(CorePersistenceLive),
);
export const partyRegistrySearchProjectionGatewayLive = PartySearchProjectionGatewayLive.pipe(
  Layer.provide(coreSearchQueryRuntimeLive),
);

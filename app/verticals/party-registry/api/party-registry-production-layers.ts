import {
  ContextAccessLive,
  CorePersistenceLive,
  CoreSearchProjectionStoreLive,
  CoreSearchQueryRuntimeLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  makeActionRuntimeLive,
} from '@app/core-runtime';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { Layer } from '@modern-js/bff-effect/effect-edge';
import { FetchHttpClient } from 'effect/unstable/http';

import { AresSubjectServiceLive } from '../src/integrations/ares/ares-subject.service.ts';
import { PartySearchProjectionGatewayLive } from '../src/search/parties.provider.ts';
import { ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';

const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const readRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive)),
  OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive))),
);
export const partyRegistryReadRuntimeLive = ReadRuntimeLive.pipe(Layer.provide(readRuntimeDependenciesLive));

const nativeCompositionSourceLive = ActiveApplicationCompositionSourceLive.pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
    ),
  ),
);
const activeApplicationCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(nativeCompositionSourceLive),
);
const actionRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  activeApplicationCompositionLive,
  ActionRepositoryLive,
  ActionPermissionLive,
  ContextAccessLive,
  moduleStateGateLive,
  ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive)),
  OperationalScopeResolverLive.pipe(Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive))),
);
export const partyRegistryActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
  Layer.provide(actionRuntimeDependenciesLive),
);

export const partyRegistryAresSubjectServiceLive = AresSubjectServiceLive.pipe(Layer.provide(FetchHttpClient.layer));

const coreSearchQueryRuntimeLive = CoreSearchQueryRuntimeLive.pipe(
  Layer.provide(CoreSearchProjectionStoreLive),
  Layer.provide(CorePersistenceLive),
);
export const partyRegistrySearchProjectionGatewayLive = PartySearchProjectionGatewayLive.pipe(
  Layer.provide(coreSearchQueryRuntimeLive),
);

import { partyRegistryBackendRegistration } from '../vertical.runtime-declaration.ts';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import {
  ContextAccessLive,
  CorePersistenceLive,
  CoreSearchProjectionStoreLive,
  CoreSearchQueryRuntimeLive,
  makeReadRuntimeLive,
  TenantModuleStateServiceLive,
  makeActionRuntimeLive,
} from '@app/core-runtime';
import type {
  ActionRuntime,
  DatabaseConfig,
  DatabaseConnectionError,
  DatabaseIdentityEnrollmentContext,
  ReadRuntime,
} from '@app/core-runtime';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import type {
  AccessDecisionGate,
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  DecisionCheck,
  LegalEntityCandidates,
} from '@app/core-runtime/access/enforcement';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { Layer } from '@modern-js/bff-effect/effect-edge';
import type { Crypto } from 'effect';
import { FetchHttpClient } from 'effect/http';

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
type PartyRegistryAccessRequirements =
  | AccessDecisionGate
  | AccessDecisionLog
  | AccessIntent
  | AccessPrincipalKindSource
  | Crypto.Crypto
  | DatabaseConfig
  | DatabaseIdentityEnrollmentContext
  | DecisionCheck
  | LegalEntityCandidates;

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
export const partyRegistryReadRuntimeLive: Layer.Layer<
  ReadRuntime,
  DatabaseConnectionError,
  PartyRegistryAccessRequirements
> = makeReadRuntimeLive(ultramodernDeliveryUnit, partyRegistryBackendRegistration).pipe(
  Layer.provide(readRuntimeDependenciesLive),
  Layer.provide(activeApplicationCompositionLive),
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
export const partyRegistryOwnerActionApprovalsLive = makeOwnerActionApprovalsLive(
  ultramodernDeliveryUnit,
  partyRegistryBackendRegistration,
).pipe(Layer.provide(actionRuntimeDependenciesLive));
export const partyRegistryActionRuntimeLive: Layer.Layer<
  ActionRuntime,
  DatabaseConnectionError,
  PartyRegistryAccessRequirements
> = makeActionRuntimeLive(ultramodernDeliveryUnit, partyRegistryBackendRegistration).pipe(
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

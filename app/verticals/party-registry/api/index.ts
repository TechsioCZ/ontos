import {
  ActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  CoreSearchQueryRuntimeLive,
  DatabaseConfigLive,
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
import {
  defineEffectBff,
  Effect,
  HttpApiBuilder,
  HttpRouter,
  Layer,
} from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeLayer,
} from '@modern-js/plugin-bff/effect-edge';
import { FetchHttpClient } from 'effect/unstable/http';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';

import {
  partyRegistryApi,
  partyRegistryAppIdFromString,
  partyRegistryOperationContexts,
  partyRegistryUnitIdFromString,
} from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { AresSubjectServiceLive } from '../src/integrations/ares/ares-subject.service.ts';
import { PartySearchProjectionGatewayLive } from '../src/search/parties.provider.ts';
import { ActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
// <generated-governed-http-handler-imports>
import { aresLookupReadApiLive } from './ares-lookup-read-server.ts';
import { counterpartiesReadApiLive } from './counterparties-search-server.ts';
import { counterpartyReadReadApiLive } from './counterparty-read-read-server.ts';
import { counterpartyRoleHistoryReadApiLive } from './counterparty-role-history-read-server.ts';
import { duplicateCandidateDetailReadApiLive } from './duplicate-candidate-detail-read-server.ts';
import { organizationEngagementProfileReadApiLive } from './organization-engagement-profile-read-server.ts';
import { partiesReadApiLive } from './parties-search-server.ts';
import { partyContactPointDetailReadApiLive } from './party-contact-point-detail-read-server.ts';
import { partyContactPointsReadApiLive } from './party-contact-points-read-server.ts';
import { partyCorrectionReadApiLive } from './party-correction-read-server.ts';
import { partyDetailReadApiLive } from './party-detail-read-server.ts';
import { partyMatchDecisionReadApiLive } from './party-match-decision-read-server.ts';
import { partyMatchReadApiLive } from './party-match-read-server.ts';
import { partyMergeReadinessReadApiLive } from './party-merge-readiness-read-server.ts';
import { partyOfficialIdentifierDetailReadApiLive } from './party-official-identifier-detail-read-server.ts';
import { partyOfficialIdentifierHistoryReadApiLive } from './party-official-identifier-history-read-server.ts';
import { partyRelationshipDetailReadApiLive } from './party-relationship-detail-read-server.ts';
import { personEngagementProfileReadApiLive } from './person-engagement-profile-read-server.ts';
// </generated-governed-http-handler-imports>
import { engagementProfileApiHandlersLive } from './engagement-profile-server.ts';
import {
  partyRegistryCommandRecoveryLive,
  partyRegistryCommandsLive,
} from './party-command-server.ts';
import {
  operationAttributes,
  partyRegistryCorsAllowedHeaders,
  partyRegistryCorsAllowedMethods,
  partyRegistryCorsAllowedOrigins,
  resolvePartyRegistryShellOrigin,
} from './read-server-support.ts';

export const partyRegistryFoundationLive = HttpApiBuilder.group(
  partyRegistryApi,
  'foundation',
  (handlers) =>
    handlers.handle('readiness', () =>
      Effect.withSpan(
        Effect.succeed({
          checks: {
            api: 'ready' as const,
            moduleFederation: 'ready' as const,
            ssr: 'ready' as const,
            translations: 'ready' as const,
          },
          marker: {
            ...ultramodernApiMarker,
            appId: partyRegistryAppIdFromString(ultramodernApiMarker.appId),
            unitId: partyRegistryUnitIdFromString(ultramodernApiMarker.unitId),
          },
          status: 'ready' as const,
          versionSkew: 'none' as const,
        }),
        'ultramodern.api.partyRegistry.readiness',
        {
          attributes: { ...operationAttributes(partyRegistryOperationContexts.readiness) },
          kind: 'server',
        },
      ),
    ),
);

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  let configuredShellOrigin: unknown;
  try {
    configuredShellOrigin = ULTRAMODERN_SHELL_ORIGIN;
  } catch {
    configuredShellOrigin = undefined;
  }
  return resolvePartyRegistryShellOrigin(
    Schema.is(Schema.String)(configuredShellOrigin) ? configuredShellOrigin : undefined,
  );
};
const shellOrigin = readShellOrigin();

const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(
  Layer.provide(CorePersistenceLive),
);
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const readRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive)),
  OperationalScopeResolverLive.pipe(
    Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
  ),
);
const readRuntimeLive = ReadRuntimeLive.pipe(Layer.provide(readRuntimeDependenciesLive));
const governedReadRuntimeLive = readRuntimeLive;
const actionRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ActionRepositoryLive,
  ActionPermissionLive,
  ContextAccessLive,
  moduleStateGateLive,
  ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive)),
  OperationalScopeResolverLive.pipe(
    Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
  ),
);
const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(actionRuntimeDependenciesLive));
const aresSubjectServiceLive = AresSubjectServiceLive.pipe(Layer.provide(FetchHttpClient.layer));
const coreSearchQueryRuntimeLive = CoreSearchQueryRuntimeLive.pipe(
  Layer.provide(CorePersistenceLive),
);
const searchProjectionGatewayLive = PartySearchProjectionGatewayLive.pipe(
  Layer.provide(coreSearchQueryRuntimeLive),
);
const gatewayAssertionRedemptionLive = GatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
);
const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

export const makePartyRegistryApiRuntime = (): EffectBffDefinition<typeof partyRegistryApi> &
  EffectBffRuntime<typeof partyRegistryApi> => {
  const apiHandlersLive = Layer.mergeAll(
    partyRegistryFoundationLive,
    partyRegistryCommandsLive.pipe(Layer.provide(actionRuntimeLive)),
    partyRegistryCommandRecoveryLive.pipe(Layer.provide(actionRuntimeLive)),
    engagementProfileApiHandlersLive.pipe(Layer.provide(actionRuntimeLive)),
    // <generated-governed-http-handler-layers>
    counterpartyReadReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    counterpartyRoleHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    duplicateCandidateDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    organizationEngagementProfileReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    partyContactPointDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    partyContactPointsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    partyCorrectionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    partyDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    partyMatchDecisionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    partyMatchReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    partyMergeReadinessReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    partyOfficialIdentifierDetailReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    partyOfficialIdentifierHistoryReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
    ),
    partyRelationshipDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    personEngagementProfileReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    aresLookupReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
      Layer.provide(aresSubjectServiceLive),
    ),
    partiesReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
      Layer.provide(searchProjectionGatewayLive),
    ),
    counterpartiesReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
      Layer.provide(searchProjectionGatewayLive),
    ),
    // </generated-governed-http-handler-layers>
  ).pipe(
    Layer.provide(Layer.mergeAll(ActionPrincipalVerifierLive, gatewayAssertionRedemptionLive)),
  );
  const layer = HttpApiBuilder.layer(partyRegistryApi).pipe(
    Layer.provide(apiHandlersLive),
    Layer.provide(DatabaseConfigLive),
    Layer.provide(runtimeObservabilityLive),
    Layer.merge(
      HttpRouter.cors({
        allowedHeaders: [...partyRegistryCorsAllowedHeaders],
        allowedMethods: [...partyRegistryCorsAllowedMethods],
        allowedOrigins: [...partyRegistryCorsAllowedOrigins(shellOrigin)],
        maxAge: 600,
      }),
    ),
    Layer.orDie,
  ) satisfies EffectRuntimeLayer;
  return defineEffectBff({ api: partyRegistryApi, layer });
};

const apiRuntime = makePartyRegistryApiRuntime();

export default apiRuntime;

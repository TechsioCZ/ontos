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
import { Logger, References, Schema, Tracer } from 'effect';

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
import { aresLookupReadApiLive } from './ares-lookup-read-server.ts';
import { counterpartiesReadApiLive } from './counterparties-search-server.ts';
import { counterpartyReadReadApiLive } from './counterparty-read-read-server.ts';
import { counterpartyRoleHistoryReadApiLive } from './counterparty-role-history-read-server.ts';
import { duplicateCandidateDetailReadApiLive } from './duplicate-candidate-detail-read-server.ts';
import { engagementProfileApiHandlersLive } from './engagement-profile-server.ts';
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
    engagementProfileApiHandlersLive.pipe(
      Layer.provide(actionRuntimeLive),
      Layer.provide(readRuntimeLive),
    ),
    partyDetailReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    partyMatchReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    partyMatchDecisionReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    duplicateCandidateDetailReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    partyOfficialIdentifierDetailReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    partyOfficialIdentifierHistoryReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    partyContactPointsReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    partyContactPointDetailReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    partyRelationshipDetailReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    counterpartyReadReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    counterpartyRoleHistoryReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    partyCorrectionReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    partyMergeReadinessReadApiLive.pipe(Layer.provide(readRuntimeLive)),
    aresLookupReadApiLive.pipe(
      Layer.provide(readRuntimeLive),
      Layer.provide(aresSubjectServiceLive),
    ),
    partiesReadApiLive.pipe(
      Layer.provide(readRuntimeLive),
      Layer.provide(searchProjectionGatewayLive),
    ),
    counterpartiesReadApiLive.pipe(
      Layer.provide(readRuntimeLive),
      Layer.provide(searchProjectionGatewayLive),
    ),
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

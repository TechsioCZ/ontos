import { DatabaseConfigLive } from '@app/core-runtime';
import type {
  ActionRuntime,
  GatewayAssertionRedemptionService,
  ReadRuntime,
} from '@app/core-runtime';
import { HttpRouter, Layer } from '@modern-js/plugin-bff/effect-edge';
import { assembleEffectBffRuntime } from '@app/shared-contracts/server/effect-bff-runtime';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeLayer,
} from '@modern-js/plugin-bff/effect-edge';
import { Logger, References, Schema, Tracer } from 'effect';

import { partyRegistryApi } from '../shared/api.ts';
import type { PartySearchProjectionGateway } from '../shared/domain/search-projection-gateway.ts';
import type { AresSubjectService } from '../src/integrations/ares/ares-subject.service.ts';
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
  partyRegistryCorsAllowedHeaders,
  partyRegistryCorsAllowedMethods,
  partyRegistryCorsAllowedOrigins,
  resolvePartyRegistryShellOrigin,
} from './read-server-support.ts';
import { partyRegistryFoundationLive } from './party-registry-foundation.ts';
import {
  partyRegistryActionRuntimeLive,
  partyRegistryAresSubjectServiceLive,
  partyRegistryReadRuntimeLive,
  partyRegistrySearchProjectionGatewayLive,
} from './party-registry-production-layers.ts';

export { partyRegistryFoundationLive } from './party-registry-foundation.ts';

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

const gatewayAssertionRedemptionLive = GatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);
const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

const productionReadRuntimeLive = partyRegistryReadRuntimeLive.pipe(
  Layer.provide(DatabaseConfigLive),
);
const productionSearchProjectionGatewayLive = partyRegistrySearchProjectionGatewayLive.pipe(
  Layer.provide(DatabaseConfigLive),
);
const productionActionRuntimeLive = partyRegistryActionRuntimeLive.pipe(
  Layer.provide(DatabaseConfigLive),
);

type PartyRegistryApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  aresSubjectService: Layer.Layer<
    AresSubjectService,
    Layer.Error<typeof partyRegistryAresSubjectServiceLive>
  >,
  searchProjectionGateway: Layer.Layer<
    PartySearchProjectionGateway,
    Layer.Error<typeof productionSearchProjectionGatewayLive>
  >,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof gatewayAssertionRedemptionLive>
  >,
];

export const makePartyRegistryApiRuntime = (
  ...args: PartyRegistryApiRuntimeArguments
): EffectBffDefinition<typeof partyRegistryApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof partyRegistryApi, EffectRuntimeLayer> => {
  const [
    readRuntime,
    aresSubjectService,
    searchProjectionGateway,
    actionRuntime,
    gatewayAssertionRedemption,
  ] = args;
  const actionPrincipalVerifierLive = ActionPrincipalVerifierLive.pipe(
    Layer.provide(actionRuntime),
  );
  const apiHandlersLive = Layer.mergeAll(
    partyRegistryFoundationLive,
    partyRegistryCommandsLive.pipe(Layer.provide(actionRuntime)),
    partyRegistryCommandRecoveryLive.pipe(Layer.provide(actionRuntime)),
    engagementProfileApiHandlersLive.pipe(Layer.provide(actionRuntime), Layer.provide(readRuntime)),
    partyDetailReadApiLive.pipe(Layer.provide(readRuntime)),
    partyMatchReadApiLive.pipe(Layer.provide(readRuntime)),
    partyMatchDecisionReadApiLive.pipe(Layer.provide(readRuntime)),
    duplicateCandidateDetailReadApiLive.pipe(Layer.provide(readRuntime)),
    partyOfficialIdentifierDetailReadApiLive.pipe(Layer.provide(readRuntime)),
    partyOfficialIdentifierHistoryReadApiLive.pipe(Layer.provide(readRuntime)),
    partyContactPointsReadApiLive.pipe(Layer.provide(readRuntime)),
    partyContactPointDetailReadApiLive.pipe(Layer.provide(readRuntime)),
    partyRelationshipDetailReadApiLive.pipe(Layer.provide(readRuntime)),
    counterpartyReadReadApiLive.pipe(Layer.provide(readRuntime)),
    counterpartyRoleHistoryReadApiLive.pipe(Layer.provide(readRuntime)),
    partyCorrectionReadApiLive.pipe(Layer.provide(readRuntime)),
    partyMergeReadinessReadApiLive.pipe(Layer.provide(readRuntime)),
    aresLookupReadApiLive.pipe(Layer.provide(readRuntime), Layer.provide(aresSubjectService)),
    partiesReadApiLive.pipe(Layer.provide(readRuntime), Layer.provide(searchProjectionGateway)),
    counterpartiesReadApiLive.pipe(
      Layer.provide(readRuntime),
      Layer.provide(searchProjectionGateway),
    ),
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(runtimeObservabilityLive),
    Layer.orDie,
  );
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...partyRegistryCorsAllowedHeaders],
    allowedMethods: [...partyRegistryCorsAllowedMethods],
    allowedOrigins: [...partyRegistryCorsAllowedOrigins(shellOrigin)],
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: partyRegistryApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

const apiRuntime = makePartyRegistryApiRuntime(
  productionReadRuntimeLive,
  partyRegistryAresSubjectServiceLive,
  productionSearchProjectionGatewayLive,
  productionActionRuntimeLive,
  gatewayAssertionRedemptionLive,
);

export default apiRuntime;

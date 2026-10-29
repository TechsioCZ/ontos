import {
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  PARTY_REGISTRY_REQUEST_IDENTITY,
} from '@app/party-registry-identity-contracts';
import { NodeCrypto } from '@effect/platform-node';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { DatabaseIdentityEnrollmentContext, makeDatabaseConfigLive } from '@app/core-runtime';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import type { ActionRuntime, ReadRuntime, GatewayAssertionRedemptionService } from '@app/core-runtime';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime, EffectRuntimeLayer } from '@modern-js/bff-effect/effect-edge';
import { Logger, References, Schema, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { partyRegistryApi } from '../shared/api.ts';
import type { PartySearchProjectionGateway } from '../shared/domain/search-projection-gateway.ts';
import type { AresSubjectService } from '../src/integrations/ares/ares-subject.service.ts';
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
import { customerListReadApiLive } from './customer-list-read-server.ts';
import { duplicateCandidateDetailReadApiLive } from './duplicate-candidate-detail-read-server.ts';
import { duplicateCandidateListReadApiLive } from './duplicate-candidate-list-read-server.ts';
import { executePrivacyMeasureActionApiLive } from './execute-privacy-measure-action-server.ts';
import { guestPartyResolutionReadApiLive } from './guest-party-resolution-read-server.ts';
import { privacyMeasureExecutionReadApiLive } from './privacy-measure-execution-read-server.ts';
// </generated-governed-http-handler-imports>
import { engagementProfileApiHandlersLive } from './engagement-profile-server.ts';
import { organizationEngagementProfileReadApiLive } from './organization-engagement-profile-read-server.ts';
import { partiesReadApiLive } from './parties-search-server.ts';
import { partyRegistryCommandRecoveryLive, partyRegistryCommandsLive } from './party-command-server.ts';
import { partyContactPointDetailReadApiLive } from './party-contact-point-detail-read-server.ts';
import { partyContactPointsReadApiLive } from './party-contact-points-read-server.ts';
import { partyCorrectionReadApiLive } from './party-correction-read-server.ts';
import { partyDetailReadApiLive } from './party-detail-read-server.ts';
import { partyMatchDecisionReadApiLive } from './party-match-decision-read-server.ts';
import { partyMatchReadApiLive } from './party-match-read-server.ts';
import { partyMergeReadinessReadApiLive } from './party-merge-readiness-read-server.ts';
import { partyOfficialIdentifierDetailReadApiLive } from './party-official-identifier-detail-read-server.ts';
import { partyOfficialIdentifierHistoryReadApiLive } from './party-official-identifier-history-read-server.ts';
import { partyRegistryFoundationLive } from './party-registry-foundation.ts';
import {
  partyRegistryActionRuntimeLive,
  partyRegistryAresSubjectServiceLive,
  partyRegistryReadRuntimeLive,
  partyRegistrySearchProjectionGatewayLive,
} from './party-registry-production-layers.ts';
import { partyRelationshipDetailReadApiLive } from './party-relationship-detail-read-server.ts';
import { personEngagementProfileReadApiLive } from './person-engagement-profile-read-server.ts';
import {
  partyRegistryCorsAllowedHeaders,
  partyRegistryCorsAllowedMethods,
  partyRegistryCorsAllowedOrigins,
  resolvePartyRegistryShellOrigin,
} from './read-server-support.ts';

export { partyRegistryFoundationLive } from './party-registry-foundation.ts';

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  const configuredShellOrigin = (() => {
    try {
      return ULTRAMODERN_SHELL_ORIGIN;
    } catch {
      return null;
    }
  })();
  return resolvePartyRegistryShellOrigin(
    Schema.is(Schema.String)(configuredShellOrigin) ? configuredShellOrigin : undefined,
  );
};
const shellOrigin = readShellOrigin();

const partyRegistryDatabaseConfigLive = makeDatabaseConfigLive(PARTY_REGISTRY_REQUEST_IDENTITY);
const partyRegistryDatabaseIdentityEnrollmentLive = Layer.succeed(
  DatabaseIdentityEnrollmentContext,
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
);

const gatewayAssertionRedemptionLive = GatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(partyRegistryDatabaseConfigLive),
);
const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

const productionReadRuntimeLive = partyRegistryReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(partyRegistryDatabaseConfigLive, partyRegistryDatabaseIdentityEnrollmentLive, NodeCrypto.layer),
  ),
);
const productionSearchProjectionGatewayLive = partyRegistrySearchProjectionGatewayLive.pipe(
  Layer.provide(Layer.merge(partyRegistryDatabaseConfigLive, partyRegistryDatabaseIdentityEnrollmentLive)),
);
const productionActionRuntimeLive = partyRegistryActionRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(partyRegistryDatabaseConfigLive, partyRegistryDatabaseIdentityEnrollmentLive, NodeCrypto.layer),
  ),
);

type PartyRegistryApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  aresSubjectService: Layer.Layer<AresSubjectService, Layer.Error<typeof partyRegistryAresSubjectServiceLive>>,
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
    governedReadRuntimeLive,
    aresSubjectService,
    searchProjectionGateway,
    governedActionRuntimeLive,
    gatewayAssertionRedemption,
  ] = args;
  const actionPrincipalVerifierLive = ActionPrincipalVerifierLive.pipe(Layer.provide(governedActionRuntimeLive));
  const apiHandlersLive = Layer.mergeAll(
    partyRegistryFoundationLive,
    partyRegistryCommandsLive,
    partyRegistryCommandRecoveryLive,
    engagementProfileApiHandlersLive,
    // <generated-governed-http-handler-layers>
    aresLookupReadApiLive,
    counterpartiesReadApiLive,
    counterpartyReadReadApiLive,
    counterpartyRoleHistoryReadApiLive,
    customerListReadApiLive,
    duplicateCandidateDetailReadApiLive,
    duplicateCandidateListReadApiLive,
    executePrivacyMeasureActionApiLive,
    guestPartyResolutionReadApiLive,
    organizationEngagementProfileReadApiLive,
    partiesReadApiLive,
    partyContactPointDetailReadApiLive,
    partyContactPointsReadApiLive,
    partyCorrectionReadApiLive,
    partyDetailReadApiLive,
    partyMatchDecisionReadApiLive,
    partyMatchReadApiLive,
    partyMergeReadinessReadApiLive,
    partyOfficialIdentifierDetailReadApiLive,
    partyOfficialIdentifierHistoryReadApiLive,
    partyRelationshipDetailReadApiLive,
    personEngagementProfileReadApiLive,
    privacyMeasureExecutionReadApiLive,
    // </generated-governed-http-handler-layers>
  );
  const requestServicesLive = Layer.mergeAll(
    governedReadRuntimeLive,
    governedActionRuntimeLive,
    aresSubjectService,
    searchProjectionGateway,
    actionPrincipalVerifierLive,
    gatewayAssertionRedemption,
  ).pipe(
    Layer.provideMerge(runtimeObservabilityLive),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(
      ActiveApplicationCompositionSourceLive.pipe(
        Layer.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
          ),
        ),
      ),
    ),
    Layer.orDie,
  );
  const resolvedApiHandlersLive = apiHandlersLive.pipe(Layer.provide(RequestSchemaProblemLive));
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...partyRegistryCorsAllowedHeaders],
    allowedMethods: [...partyRegistryCorsAllowedMethods],
    allowedOrigins: [...partyRegistryCorsAllowedOrigins(shellOrigin)],
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: partyRegistryApi,
    handlers: resolvedApiHandlersLive,
    services: requestServicesLive,
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

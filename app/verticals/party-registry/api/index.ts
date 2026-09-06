import {
  ActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  CoreSearchQueryRuntimeLive,
  makeReadRuntimeLive,
} from '@app/core-runtime';
import type { ActionRuntime, ReadRuntime } from '@app/core-runtime';
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
import { Schema } from 'effect';

import { partyRegistryApi, partyRegistryOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import type { PartySearchProjectionGateway } from '../shared/domain/search-projection-gateway.ts';
import { AresSubjectServiceLive } from '../src/integrations/ares/ares-subject.service.ts';
import type { AresSubjectService } from '../src/integrations/ares/ares-subject.service.ts';
import { PartySearchProjectionGatewayLive } from '../src/search/parties.provider.ts';
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

const foundationLive = HttpApiBuilder.group(partyRegistryApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({
      checks: {
        api: 'ready' as const,
        moduleFederation: 'ready' as const,
        ssr: 'ready' as const,
        translations: 'ready' as const,
      },
      marker: ultramodernApiMarker,
      status: 'ready' as const,
      versionSkew: 'none' as const,
    }).pipe(
      Effect.withSpan('ultramodern.api.partyRegistry.readiness', {
        attributes: operationAttributes(partyRegistryOperationContexts.readiness),
        kind: 'server',
      }),
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

export const makePartyRegistryApiRuntime = (
  readRuntime: Layer.Layer<ReadRuntime>,
  aresSubjectService: Layer.Layer<AresSubjectService>,
  searchProjectionGateway: Layer.Layer<PartySearchProjectionGateway>,
  actionRuntime: Layer.Layer<ActionRuntime>,
): EffectBffDefinition<typeof partyRegistryApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof partyRegistryApi, EffectRuntimeLayer> => {
  const apiHandlersLive = Layer.mergeAll(
    foundationLive,
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
  );
  const layer = HttpApiBuilder.layer(partyRegistryApi).pipe(
    Layer.provide(apiHandlersLive),
    Layer.merge(
      HttpRouter.cors({
        allowedHeaders: [...partyRegistryCorsAllowedHeaders],
        allowedMethods: [...partyRegistryCorsAllowedMethods],
        allowedOrigins: [...partyRegistryCorsAllowedOrigins(shellOrigin)],
        maxAge: 600,
      }),
    ),
  ) satisfies EffectRuntimeLayer;
  return defineEffectBff({ api: partyRegistryApi, layer });
};

const readRuntimeLive = makeReadRuntimeLive(ContextAccessLive).pipe(
  Layer.provide(CorePersistenceLive),
  Layer.orDie,
);
const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);
const aresSubjectServiceLive = AresSubjectServiceLive.pipe(Layer.provide(FetchHttpClient.layer));
const coreSearchQueryRuntimeLive = CoreSearchQueryRuntimeLive.pipe(
  Layer.provide(CorePersistenceLive),
  Layer.orDie,
);
const searchProjectionGatewayLive = PartySearchProjectionGatewayLive.pipe(
  Layer.provide(coreSearchQueryRuntimeLive),
);

const apiRuntime = makePartyRegistryApiRuntime(
  readRuntimeLive,
  aresSubjectServiceLive,
  searchProjectionGatewayLive,
  actionRuntimeLive,
);

export default apiRuntime;

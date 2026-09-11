import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';

import {
  partyRegistryApi,
  partyRegistryAppIdFromString,
  partyRegistryOperationContexts,
  partyRegistryUnitIdFromString,
} from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { operationAttributes } from './read-server-support.ts';

export const partyRegistryFoundationLive = HttpApiBuilder.group(partyRegistryApi, 'foundation', (handlers) =>
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
        attributes: {
          ...operationAttributes(partyRegistryOperationContexts.readiness),
        },
        kind: 'server',
      },
    ),
  ),
);

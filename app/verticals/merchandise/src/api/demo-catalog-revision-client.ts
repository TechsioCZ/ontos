import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect, Redacted } from 'effect';

import { DemoCatalogRevisionApi } from '../../shared/apis/demo-catalog-revision.ts';
import type { DemoCatalogRevisionRequest } from '../../shared/apis/demo-catalog-revision.ts';

export const executeDemoCatalogRevisionWithAuthorization = (
  payload: DemoCatalogRevisionRequest,
  credential: string,
  requestCorrelation: string,
  options: { readonly baseUrl?: string | URL; readonly compositionRevision?: string } = {},
) =>
  makeGovernedEffectBffClient(
    {
      api: DemoCatalogRevisionApi,
      credential: Redacted.make(credential),
      defaultApiPrefix: '/merchandise-api',
      requestCorrelation,
    },
    { ...options, requestCache: 'no-store' },
  ).pipe(Effect.flatMap((client) => client.demoCatalogRevision.execute({ payload })));

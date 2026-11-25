import { makeGovernedEffectBffClient } from '@app/shared-contracts/client-runtime';
import { Effect } from 'effect';
import type { Redacted } from 'effect';

import { DemoOrderExportApi } from '../../shared/apis/demo-order-export.ts';
import type { DemoOrderExportRequest } from '../../shared/apis/demo-order-export.ts';

export const executeDemoOrderExportWithAuthorization = (
  payload: DemoOrderExportRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl?: string | URL; readonly compositionRevision?: string } = {},
) =>
  makeGovernedEffectBffClient(
    {
      api: DemoOrderExportApi,
      credential,
      defaultApiPrefix: '/merchandise-api',
      requestCorrelation,
    },
    { ...options, requestCache: 'no-store' },
  ).pipe(Effect.flatMap((client) => client.demoOrderExport.execute({ payload })));

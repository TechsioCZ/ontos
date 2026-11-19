// @rstest-environment happy-dom
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { assertLiveChangeReload } from '@app/shared-contracts/testing/live-change-reload';

import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { aiActivityData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';

const reads: RecordsRequest[] = [];
const emptyActivity = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  aiActivity: [],
  availablePrincipals: [],
  canWrite: true,
  indicators: {
    active: 0,
    byDepartment: [],
    byRole: { ACCOUNTANT: 0, SALES_HEAD: 0, SALES_REP: 0, SUPPORT: 0, WAREHOUSE: 0 },
    total: 0,
  },
  items: [],
  revision: 1,
});

const OwnerRecordsApi = RecordsApi.prefix('/workforce-api');
const network = browserNetwork(
  shellGatewayIssuer({ workforce: '/workforce-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return emptyActivity;
        }),
      ),
    ),
  ),
);

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect('aiActivityData reloads for every app', () =>
    assertLiveChangeReload({
      input: 'company-a',
      reads: () => reads.length,
      reloadsOn: ['workforce', 'crm', 'merchandise'],
      store: aiActivityData,
    }),
  );
});

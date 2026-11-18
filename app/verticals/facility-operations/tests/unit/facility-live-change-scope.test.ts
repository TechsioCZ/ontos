// @rstest-environment happy-dom
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { assertPageDataAppList } from '@app/shared-contracts/testing/page-data-app-list';

import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { agendaRecordsData } from '../../src/ui/use-agenda.ts';

const reads: RecordsRequest[] = [];
const emptyRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  access: [],
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  agendas: {},
});
const OwnerRecordsApi = RecordsApi.prefix('/facility-operations-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'facility-operations': '/facility-operations-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return emptyRecords;
        }),
      ),
    ),
  ),
);

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect('agendaRecordsData reloads only for its app list', () =>
    assertPageDataAppList({
      expectedApps: ['facility-operations'],
      input: ['assets'],
      reads: () => reads.length,
      store: agendaRecordsData,
    }),
  );
});

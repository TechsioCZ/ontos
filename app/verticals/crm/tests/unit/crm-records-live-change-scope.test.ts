// @rstest-environment happy-dom
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { assertPageDataAppList } from '@app/shared-contracts/testing/page-data-app-list';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { initialCrmState } from '../../shared/domain/state.ts';
import { crmRecordsData } from '../../src/crm/records.ts';

const reads: RecordsRequest[] = [];
const emptyRecords = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assignmentCandidates: [],
  departedPrincipalIds: [],
  now: '2026-11-18T12:00:00.000Z',
  revision: 7,
  state: initialCrmState,
  viewer: {
    assign: true,
    principalId: '20000000-0000-4000-8000-000000000002',
    readAll: true,
    readAssigned: false,
    writeAll: true,
    writeAssigned: false,
  },
});

const OwnerRecordsApi = RecordsApi.prefix('/crm-api');
const network = browserNetwork(
  shellGatewayIssuer({ crm: '/crm-api' }).application,
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
  suite.effect('crmRecordsData reloads only for its app list', () =>
    assertPageDataAppList({
      expectedApps: ['crm', 'shell'],
      input: {},
      reads: () => reads.length,
      store: crmRecordsData,
    }),
  );
});

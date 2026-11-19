// @rstest-environment happy-dom
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { assertLiveChangeReload } from '@app/shared-contracts/testing/live-change-reload';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { allRecordsInput, pipelineRecords } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-records.ts';

const reads: RecordsRequest[] = [];
const emptyList = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  canWrite: true,
  indicators: {
    byStage: [],
    lostCount: 0,
    openCount: 0,
    openValueMinor: 0,
    weightedValueMinor: 0,
    winRate: null,
    wonCount: 0,
    wonValueMinor: 0,
  },
  items: [],
  revision: 7,
});

const OwnerRecordsApi = RecordsApi.prefix('/sales-pipeline-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'sales-pipeline': '/sales-pipeline-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return emptyList;
        }),
      ),
    ),
  ),
);

const input = allRecordsInput('company-a');

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect('pipelineRecords reloads on a live change of the data it reads and ignores an unrelated app', () =>
    assertLiveChangeReload({
      ignores: 'tax',
      input,
      reads: () => reads.length,
      reloadsOn: ['sales-pipeline'],
      store: pipelineRecords,
    }),
  );
});

// @rstest-environment happy-dom
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';
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

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  window.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  reads.length = 0;
  pipelineRecords.invalidate();
});

it.live('live changes of apps the pipeline records do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* pinTestDocument;
    yield* pipelineRecords.preload(input);
    const unsubscribe = pipelineRecords.subscribe(() => {
      pipelineRecords.snapshot(input);
    }, input);
    expect(reads).toHaveLength(1);
    dispatchChange(['merchandise']);
    yield* Effect.sleep('10 millis');
    expect(reads).toHaveLength(1);
    unsubscribe();
  }).pipe(Effect.provide(network)),
);

it.live('a live change of sales-pipeline reloads the mounted pipeline records', () =>
  Effect.gen(function* ownChange() {
    yield* pinTestDocument;
    yield* pipelineRecords.preload(input);
    const unsubscribe = pipelineRecords.subscribe(() => {
      pipelineRecords.snapshot(input);
    }, input);
    dispatchChange(['sales-pipeline']);
    yield* waitUntil(() => reads.length === 2);
    expect(reads).toHaveLength(2);
    unsubscribe();
  }).pipe(Effect.provide(network)),
);

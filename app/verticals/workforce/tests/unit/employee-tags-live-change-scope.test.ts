// @rstest-environment happy-dom
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { RecordsApi, RecordsResponseSchema } from '@app/tagging/contracts/records';
import type { RecordsRequest } from '@app/tagging/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { assertLiveChangeReload } from '@app/shared-contracts/testing/live-change-reload';

import { employeeTagsData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';

const TaggingRecordsApi = RecordsApi.prefix('/tagging-api');
const emptyTags = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assignments: [],
  canWrite: true,
  indicators: { assignmentCount: 0, tagCount: 0 },
  revision: 1,
  tags: [],
});

const reads: RecordsRequest[] = [];
const network = browserNetwork(
  shellGatewayIssuer({ tagging: '/tagging-api' }).application,
  serveApi(
    TaggingRecordsApi,
    HttpApiBuilder.group(TaggingRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return emptyTags;
        }),
      ),
    ),
  ),
);

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect('employeeTagsData reloads on a live change of the data it reads and ignores an unrelated app', () =>
    assertLiveChangeReload({
      ignores: 'tax',
      input: 'company-a',
      reads: () => reads.length,
      reloadsOn: ['tagging'],
      store: employeeTagsData,
    }),
  );
});

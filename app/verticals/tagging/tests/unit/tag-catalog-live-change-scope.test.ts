// @rstest-environment happy-dom
import { assertPageDataAppList } from '@app/shared-contracts/testing/page-data-app-list';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { tagCatalogData } from '../../src/tags/tag-catalog.ts';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';

const response = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assignments: [],
  canWrite: true,
  indicators: { assignmentCount: 0, tagCount: 0 },
  revision: 1,
  tags: [],
});

const reads: unknown[] = [];
const OwnerApi = RecordsApi.prefix('/tagging-api');
const network = browserNetwork(
  shellGatewayIssuer({ tagging: '/tagging-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return response;
        }),
      ),
    ),
  ),
);

it.live('tagCatalogData reloads only for its app list', () =>
  assertPageDataAppList({
    expectedApps: ['tagging'],
    input: 'all',
    reads: () => reads.length,
    store: tagCatalogData,
  }).pipe(Effect.provide(network)),
);

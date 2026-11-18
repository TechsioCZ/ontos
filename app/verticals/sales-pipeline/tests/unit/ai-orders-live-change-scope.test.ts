// @rstest-environment happy-dom
import { assertPageDataAppList } from '@app/shared-contracts/testing/page-data-app-list';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { aiOrders } from '../../src/routes/[lang]/prodej/schvalovani-ai/page.tsx';
import { RecordsApi, RecordsResponseSchema } from '@app/merchandise/apis/records';

const response = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '11111111-1111-4111-8111-111111111111',
  },
  aiChanges: { batches: [], changes: [], log: [] },
  canWrite: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
  movements: [],
  orders: [],
  products: [],
  revision: 3,
});

const reads: unknown[] = [];
const OwnerApi = RecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
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

it.live('aiOrders reloads only for its app list', () =>
  assertPageDataAppList({
    expectedApps: ['merchandise', 'sales-pipeline'],
    input: 'company-a',
    reads: () => reads.length,
    store: aiOrders,
  }).pipe(Effect.provide(network)),
);

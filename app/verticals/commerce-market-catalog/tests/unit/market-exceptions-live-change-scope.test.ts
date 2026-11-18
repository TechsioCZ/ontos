// @rstest-environment happy-dom
import { assertPageDataAppList } from '@app/shared-contracts/testing/page-data-app-list';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { marketExceptionsData } from '../../src/market-admin/page-data.ts';
import { RecordsApi, RecordsResponseSchema } from '@app/merchandise/apis/records';

const legalEntityId = '33333333-3333-4333-8333-333333333333';
const marketId = '30000000-0000-4000-8000-000000000001';
const tenantId = '11111111-1111-4111-8111-111111111111';

const response = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: { principalId: '20000000-0000-4000-8000-000000000002', tenantId },
  canWrite: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
  marketExceptions: { items: [], marketId, total: 0 },
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

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect('marketExceptionsData reloads only for its app list', () =>
    assertPageDataAppList({
      expectedApps: ['commerce-market-catalog', 'merchandise'],
      input: { legalEntityId, marketId, offset: 0, tenantId },
      reads: () => reads.length,
      store: marketExceptionsData,
    }),
  );
});

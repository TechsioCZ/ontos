// @rstest-environment happy-dom
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import {
  RecordsApi as MerchandiseApi,
  RecordsResponseSchema as MerchandiseResponse,
} from '@app/merchandise/apis/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { aiOrders, preloadPage } from '../../src/routes/[lang]/prodej/schvalovani-ai/page.tsx';
import { allRecordsInput, pipelineRecords } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-records.ts';

const actorPrincipalRef = {
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const opportunities = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef,
  aiChanges: { batches: [], changes: [], log: [] },
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
  revision: 17,
});
const orders = Schema.decodeUnknownSync(MerchandiseResponse)({
  actorPrincipalRef,
  aiChanges: { batches: [], changes: [], log: [] },
  canWrite: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 0, stockValueMinor: 0 },
  movements: [],
  orders: [],
  products: [],
  revision: 23,
});
const OpportunityOwner = RecordsApi.prefix('/sales-pipeline-api');
const OrderOwner = MerchandiseApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api', 'sales-pipeline': '/sales-pipeline-api' }).application,
  serveApi(
    OpportunityOwner,
    HttpApiBuilder.group(OpportunityOwner, 'records', (group) =>
      group.handle('execute', () => Effect.succeed(opportunities)),
    ),
  ),
  serveApi(
    OrderOwner,
    HttpApiBuilder.group(OrderOwner, 'records', (group) => group.handle('execute', () => Effect.succeed(orders))),
  ),
);

it.live('opening approvals prepares opportunity and order data in the selected company before rendering', () =>
  Effect.gen(function* prepareBothProposalOwners() {
    yield* pinTestDocument;
    const legalEntityId = 'approval-opening-company';
    yield* Effect.promise(() =>
      preloadPage({
        context: { legalEntityId, principalId: actorPrincipalRef.principalId, tenantId: actorPrincipalRef.tenantId },
        routeParams: {},
        search: '',
      }),
    );
    expect(pipelineRecords.snapshot(allRecordsInput(legalEntityId))).toMatchObject({
      state: 'ready',
      value: { aiChanges: { batches: [], changes: [], log: [] }, revision: 17 },
    });
    expect(aiOrders.snapshot(legalEntityId)).toMatchObject({
      state: 'ready',
      value: { batches: [], changes: [], log: [], revision: 23 },
    });
    expect(aiOrders.snapshot('another-company').state).toBe('pending');
  }).pipe(Effect.provide(network)),
);

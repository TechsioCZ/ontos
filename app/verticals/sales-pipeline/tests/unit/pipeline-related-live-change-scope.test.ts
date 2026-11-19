// @rstest-environment happy-dom
import { assertLiveChangeReload } from '@app/shared-contracts/testing/live-change-reload';
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { pinDocumentNavigationModules } from '@app/shared-contracts';
import {
  RecordsApi as TaskRecordsApi,
  RecordsResponseSchema as TaskResponseSchema,
} from '@app/work-tasks/contracts/records';
import { RecordsApi as AgreementsRecordsApi } from '@app/legal-agreements/contracts/records';
import {
  RecordsApi as MerchandiseRecordsApi,
  RecordsResponseSchema as MerchandiseResponseSchema,
} from '@app/merchandise/apis/records';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import { opportunityRelatedData } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-related.ts';

const tasks = Schema.decodeUnknownSync(TaskResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  assignablePrincipals: [],
  canWrite: true,
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: {
      moduleId: 'work.tasks',
      resourceId: 'default',
      resourceType: 'work.tasks.task-collection',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    title: 'Tasks',
  },
  indicators: { open: 0, openByAssignee: [], overdue: 0 },
  items: [],
  lookupAccess: { contracts: 'denied', customers: 'denied', opportunities: 'denied', properties: 'denied' },
  principalNames: [],
  referenceDate: '2026-11-04',
  revision: 1,
});

const merchandise = Schema.decodeUnknownSync(MerchandiseResponseSchema)({
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
const TasksApi = TaskRecordsApi.prefix('/work-tasks-api');
const AgreementsApi = AgreementsRecordsApi.prefix('/legal-agreements-api');
const OrdersApi = MerchandiseRecordsApi.prefix('/merchandise-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'legal-agreements': '/legal-agreements-api',
    merchandise: '/merchandise-api',
    'work-tasks': '/work-tasks-api',
  }).application,
  serveApi(
    TasksApi,
    HttpApiBuilder.group(TasksApi, 'records', (group) => group.handle('execute', () => Effect.sync(() => tasks))),
  ),
  serveApi(
    AgreementsApi,
    HttpApiBuilder.group(AgreementsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return { contracts: [], documents: [], revision: 1 };
        }),
      ),
    ),
  ),
  serveApi(
    OrdersApi,
    HttpApiBuilder.group(OrdersApi, 'records', (group) =>
      group.handle('execute', () => Effect.sync(() => merchandise)),
    ),
  ),
);

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect(
    'opportunityRelatedData reloads on a live change of the data it reads and ignores an unrelated app',
    () =>
      Effect.gen(function* relatedApps() {
        pinDocumentNavigationModules(['work.tasks', 'demo.merchandise', 'legal.agreements'], document);
        yield* assertLiveChangeReload({
          ignores: 'tax',
          input: {
            counterpartyId: '30000000-0000-4000-8000-000000000001',
            opportunity: Schema.decodeUnknownSync(
              Schema.Struct({ id: OpportunitySchema.fields.id, partyId: OpportunitySchema.fields.partyId }),
            )({ id: '10000000-0000-4000-8000-000000000001', partyId: '10000000-0000-4000-8000-000000000002' }),
            revision: 7,
            scope: 'company-a',
          },
          reads: () => reads.length,
          reloadsOn: ['legal-agreements', 'merchandise', 'work-tasks'],
          store: opportunityRelatedData,
        });
      }),
  );
});

// @rstest-environment happy-dom

import { pinDocumentNavigationModules } from '@app/shared-contracts';
import { pinTestDocument, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { text, unmountAll } from '@app/admin-ui/testing/module-ui';
import { HttpApiBuilder, HttpRouter } from '@modern-js/bff-effect/effect-edge';
import {
  RecordsApi as AgreementsApi,
  RecordsResponseSchema as AgreementsResponse,
  RecordsForbiddenProblemSchema,
} from '@app/legal-agreements/contracts/records';
import type { RecordsRequest as AgreementRequest } from '@app/legal-agreements/contracts/records';
import { RecordsApi as TasksApi, RecordsResponseSchema as TasksResponse } from '@app/work-tasks/contracts/records';
import type { RecordsRequest as TaskRequest } from '@app/work-tasks/contracts/records';
import {
  RecordsApi as MerchandiseApi,
  RecordsResponseSchema as MerchandiseResponse,
} from '@app/merchandise/contracts/records';
import type { RecordsRequest as OrderRequest } from '@app/merchandise/contracts/records';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import {
  ApplyCommandActionApi,
  ApplyCommandActionForbiddenProblemSchema,
} from '../../shared/apis/apply-command-action.ts';
import { applyCommandActionSchemaErrorLive } from '../../api/apply-command-action-problems.ts';
import { mountInRoute } from '../support/module-ui.ts';
import { Deferred, Effect, Fiber, FiberSet, Layer, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import {
  opportunityRelatedData,
  preloadOpportunityDetails,
  useOpportunityRelated,
} from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-related.ts';
import { preloadPage as preloadPipelinePage } from '../../src/routes/[lang]/prodej/prilezitosti/page.tsx';
import { applyPipelineCommand } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-api.ts';
import { pipelineRecords, initialRecordsInput } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-records.ts';

const context = { legalEntityId: 'company-a', principalId: 'principal-a', tenantId: 'tenant-a' };
const scope = pageDataScopeKey(context, 'demo.sales-pipeline') ?? '';
const opportunity = Schema.decodeSync(OpportunitySchema)({
  amountMinor: 100,
  createdAt: '2026-11-03T00:00:00Z',
  currency: 'CZK',
  expectedCloseDate: '2026-11-03',
  id: '10000000-0000-4000-8000-000000000001',
  lines: [],
  partyId: '10000000-0000-4000-8000-000000000002',
  probability: 10,
  stage: 'LEAD',
  stageHistory: [],
  title: 'Visible case',
  updatedAt: '2026-11-03T00:00:00Z',
});

const tenantId = '20000000-0000-4000-8000-000000000001';
const actorPrincipalRef = { principalId: '20000000-0000-4000-8000-000000000002', tenantId };
const customerId = '10000000-0000-4000-8000-000000000003';
const row = { counterpartyId: customerId, opportunity };
const input = { ...row, revision: 7, scope };
const contracts = Schema.decodeUnknownSync(AgreementsResponse)({
  contracts: [
    {
      contractRef: {
        moduleId: 'legal.agreements',
        resourceId: '10000000-0000-4000-8000-000000000004',
        resourceType: 'legal.agreements.contract',
        tenantId,
      },
      counterpartyRef: {
        moduleId: 'party.registry',
        resourceId: customerId,
        resourceType: 'party.registry.counterparty',
        tenantId,
      },
      endDate: null,
      expiringSoon: false,
      hasSuccessorDraft: false,
      isExpired: false,
      kind: 'OTHER',
      lifecycleState: 'ACTIVE',
      note: null,
      occupancyRef: null,
      propertyRef: null,
      renewalNoticeDate: null,
      signatureState: 'NOT_SENT',
      startDate: '2026-11-03',
      subject: 'Visible contract',
      supersedesContractRef: null,
      unitRef: null,
    },
  ],
  documents: [],
  revision: 7,
});
const collectionRef = {
  moduleId: 'work.tasks',
  resourceId: 'default',
  resourceType: 'work.tasks.task-collection',
  tenantId,
};
const tasks = Schema.decodeUnknownSync(TasksResponse)({
  actorPrincipalRef,
  assignablePrincipals: [],
  canWrite: true,
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: collectionRef,
    title: 'Tasks',
  },
  indicators: { open: 1, openByAssignee: [], overdue: 0 },
  items: [
    {
      collectionRef,
      contextRefs: [],
      createdAt: '2026-11-03T00:00:00Z',
      opportunityId: opportunity.id,
      priority: 'NORMAL',
      ref: {
        moduleId: 'work.tasks',
        resourceId: '10000000-0000-4000-8000-000000000005',
        resourceType: 'work.tasks.task',
        tenantId,
      },
      state: 'NEW',
      title: 'Visible task',
      updatedAt: '2026-11-03T00:00:00Z',
    },
  ],
  principalNames: [],
  referenceDate: '2026-11-03',
  revision: 7,
});
const orders = Schema.decodeUnknownSync(MerchandiseResponse)({
  actorPrincipalRef,
  canWrite: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 100, orderCount: 1, productCount: 0, stockValueMinor: 0 },
  movements: [],
  orders: [
    {
      createdAt: '2026-11-03T00:00:00Z',
      id: 'order-a',
      lines: [
        { productId: 'product-a', productName: 'Product A', quantity: 1, sku: 'A', unitPriceMinor: 100, vatRate: 0 },
      ],
      number: 'Order A',
      partyId: opportunity.partyId,
      status: 'NEW',
      totalMinor: 100,
      totalVatMinor: 0,
      updatedAt: '2026-11-03T00:00:00Z',
    },
  ],
  products: [],
  revision: 7,
});
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef,
  canWrite: true,
  indicators: {
    byStage: [],
    lostCount: 0,
    openCount: 1,
    openValueMinor: 100,
    weightedValueMinor: 10,
    winRate: null,
    wonCount: 0,
    wonValueMinor: 0,
  },
  items: [Schema.encodeSync(OpportunitySchema)(opportunity)],
  revision: 7,
});
const forbidden = RecordsForbiddenProblemSchema.make({
  detail: 'Records denied',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/records-forbidden',
});
const commandForbidden = ApplyCommandActionForbiddenProblemSchema.make({
  code: 'action_permission_denied',
  detail: 'Command denied',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/action-forbidden',
});
const contractReads: AgreementRequest[] = [];
const taskReads: TaskRequest[] = [];
const orderReads: OrderRequest[] = [];
const recordsReads: RecordsRequest[] = [];
let contractAnswer: Effect.Effect<typeof contracts, typeof forbidden> = Effect.succeed(contracts);
let recordsAnswer: Effect.Effect<typeof records, typeof forbidden> = Effect.succeed(records);
const Agreements = AgreementsApi.prefix('/legal-agreements-api');
const Tasks = TasksApi.prefix('/work-tasks-api');
const Merchandise = MerchandiseApi.prefix('/merchandise-api');
const Pipeline = RecordsApi.prefix('/sales-pipeline-api');
const Commands = ApplyCommandActionApi.prefix('/sales-pipeline-api');
const applications = [
  shellGatewayIssuer({
    'legal-agreements': '/legal-agreements-api',
    merchandise: '/merchandise-api',
    'sales-pipeline': '/sales-pipeline-api',
    'work-tasks': '/work-tasks-api',
  }).application,
  serveApi(
    Agreements,
    HttpApiBuilder.group(Agreements, 'records', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          contractReads.push(payload);
          return contractAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    Tasks,
    HttpApiBuilder.group(Tasks, 'records', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          taskReads.push(payload);
          return tasks;
        }),
      ),
    ),
  ),
  serveApi(
    Merchandise,
    HttpApiBuilder.group(Merchandise, 'records', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          orderReads.push(payload);
          return orders;
        }),
      ),
    ),
  ),
  serveApi(
    Pipeline,
    HttpApiBuilder.group(Pipeline, 'records', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          recordsReads.push(payload);
          return recordsAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    Commands,
    HttpApiBuilder.group(Commands, 'applyCommandAction', (g) =>
      g.handle('execute', () => Effect.fail(commandForbidden)),
    ).pipe(Layer.provide(applyCommandActionSchemaErrorLive)),
  ),
] as const;

type BrowserRequest = Parameters<
  NonNullable<Window['happyDOM']['settings']['fetch']['interceptor']>['beforeAsyncRequest']
>[0];
const forwardBrowserRequest = (
  handler: (request: Request) => Promise<Response>,
  { request, window: sourceWindow }: BrowserRequest,
) =>
  Effect.gen(function* forward() {
    const head = { headers: [...request.headers], method: request.method, signal: request.signal };
    const forwarded =
      request.method === 'GET' || request.method === 'HEAD'
        ? new Request(request.url, head)
        : new Request(request.url, { ...head, body: yield* Effect.promise(() => request.arrayBuffer()) });
    const response = yield* Effect.promise(() => handler(forwarded));
    const bytes = yield* Effect.promise(() => response.arrayBuffer());
    return new sourceWindow.Response(bytes, {
      headers: [...response.headers],
      status: response.status,
      statusText: response.statusText,
    });
  });
// Preserve abort signals across the in-process HTTP hop so the real handler observes cancellation.
const network = Layer.effectDiscard(
  Effect.gen(function* browserTransport() {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(Layer.mergeAll(...applications), { disableLogger: true })),
      (value) => Effect.promise(() => value.dispose()),
    );
    const run = yield* FiberSet.makeRuntimePromise();
    const settings = window.happyDOM.settings.fetch;
    const previous = settings.interceptor;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        settings.interceptor = { beforeAsyncRequest: (request) => run(forwardBrowserRequest(server.handler, request)) };
      }),
      () =>
        Effect.sync(() => {
          settings.interceptor = previous;
        }),
    );
  }),
);
afterEach(unmountAll);
beforeEach(() => {
  contractReads.length = 0;
  taskReads.length = 0;
  orderReads.length = 0;
  recordsReads.length = 0;
  opportunityRelatedData.invalidate();
  pipelineRecords.invalidate();
  contractAnswer = Effect.succeed(contracts);
  recordsAnswer = Effect.succeed(records);
  pinDocumentNavigationModules(['work.tasks', 'demo.merchandise', 'legal.agreements'], document);
});
const Detail = () => {
  const related = useOpportunityRelated(opportunity, row.counterpartyId, context, 7);
  return createElement(
    'p',
    null,
    [
      related.tasks.status === 'ready' ? related.tasks.items[0]?.title : related.tasks.status,
      related.contracts.status === 'ready' ? related.contracts.items[0]?.subject : related.contracts.status,
      related.orders.status === 'ready' ? related.orders.items[0]?.number : related.orders.status,
    ].join('|'),
  );
};
it.live('renders the opportunity task, customer contract and case order from the warmed related-data hook', () =>
  Effect.gen(function* relatedHook() {
    yield* pinTestDocument;
    yield* preloadOpportunityDetails(context, [row], 7);
    expect(contractReads).toHaveLength(1);
    expect(taskReads).toHaveLength(2);
    expect(orderReads).toHaveLength(1);
    yield* mountInRoute(createElement(Detail));
    expect(text()).toContain('Visible task|Visible contract|Order A');
    expect(contractReads).toHaveLength(1);
    expect(taskReads).toHaveLength(2);
    expect(orderReads).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);
it.live('separates tenant, principal, company, module, revision and exact customer link', () =>
  Effect.gen(function* test() {
    yield* pinTestDocument;
    yield* preloadOpportunityDetails(context, [row], 7);
    for (const next of [
      { ...context, tenantId: 'other' },
      { ...context, principalId: 'other' },
      { ...context, legalEntityId: 'other' },
    ]) {
      yield* preloadOpportunityDetails(next, [row], 7);
    }
    yield* opportunityRelatedData.read({ ...input, scope: pageDataScopeKey(context, 'other.module') ?? '' });
    yield* opportunityRelatedData.read({ ...input, revision: 8 });
    yield* opportunityRelatedData.read({ ...input, counterpartyId: 'different-customer' });
    expect(contractReads).toHaveLength(7);
    expect(opportunityRelatedData.snapshot(input).state).toBe('ready');
  }).pipe(Effect.provide(network)),
);
it.live('does not prefetch with absent or incomplete identity', () =>
  Effect.gen(function* test() {
    yield* pinTestDocument;
    yield* preloadOpportunityDetails(undefined, [row], 7);
    yield* preloadOpportunityDetails({ ...context, principalId: '' }, [row], 7);
    expect(contractReads).toHaveLength(0);
    expect(taskReads).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);
it.live('keeps independent successful sections but never reuses a denial as success', () =>
  Effect.gen(function* test() {
    yield* pinTestDocument;
    contractAnswer = Effect.fail(forbidden);
    yield* preloadOpportunityDetails(context, [row], 7);
    const failed = opportunityRelatedData.snapshot(input);
    expect(failed.state).toBe('failed');
    if (failed.state === 'failed') {
      expect(failed.error.value.contracts.status).toBe('unavailable');
      expect(failed.error.value.tasks.status).toBe('ready');
      expect(failed.error.value.orders.status).toBe('ready');
    }
    contractAnswer = Effect.succeed(contracts);
    yield* opportunityRelatedData.read(input);
    expect(contractReads).toHaveLength(2);
    expect(opportunityRelatedData.snapshot(input).state).toBe('ready');
  }).pipe(Effect.provide(network)),
);
it.live('limits background work to two rows and cancels both active and queued work', () =>
  Effect.gen(function* test() {
    yield* pinTestDocument;
    const started = yield* Deferred.make<boolean>();
    const cancelled = yield* Deferred.make<boolean>();
    let active = 0;
    let stopped = 0;
    contractAnswer = Effect.gen(function* blocked() {
      active += 1;
      if (active === 2) {
        yield* Deferred.succeed(started, true);
      }
      return yield* Effect.never;
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.gen(function* cancelledRequest() {
          stopped += 1;
          if (stopped === 2) {
            yield* Deferred.succeed(cancelled, true);
          }
        }),
      ),
    );
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ...row,
      opportunity: {
        ...opportunity,
        id: Schema.decodeSync(OpportunitySchema.fields.id)(
          `10000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
        ),
      },
    }));
    const fiber = yield* Effect.forkChild(preloadOpportunityDetails(context, rows, 7));
    yield* Deferred.await(started);
    expect(active).toBe(2);
    yield* Fiber.interrupt(fiber);
    yield* Deferred.await(cancelled);
    expect(stopped).toBe(2);
    expect(contractReads).toHaveLength(2);
    expect(orderReads).toHaveLength(0);
  }).pipe(Effect.provide(network)),
);
it.live('invalidates related records even when an opportunity command is refused', () =>
  Effect.gen(function* test() {
    yield* pinTestDocument;
    yield* preloadOpportunityDetails(context, [row], 7);
    yield* applyPipelineCommand({ _tag: 'ArchiveOpportunity', id: opportunity.id }, 7).pipe(Effect.ignore);
    expect(opportunityRelatedData.snapshot(input).state).toBe('pending');
  }).pipe(Effect.provide(network)),
);
it.live('preserves a cold URL record and does not return last-authorized rows after a denied refresh', () =>
  Effect.gen(function* test() {
    yield* pinTestDocument;
    const initial = initialRecordsInput({ context, routeParams: {}, search: `?opportunityId=${opportunity.id}` });
    expect(Option.isSome(initial)).toBe(true);
    if (Option.isNone(initial)) {
      return;
    }
    recordsAnswer = Effect.succeed(records);
    yield* Effect.promise(() =>
      preloadPipelinePage({ context, routeParams: {}, search: `?opportunityId=${opportunity.id}` }),
    );
    yield* pipelineRecords.read(initial.value);
    expect(recordsReads).toHaveLength(1);
    const ready = pipelineRecords.snapshot(initial.value);
    expect(ready.state).toBe('ready');
    if (ready.state === 'ready') {
      expect(ready.value.items[0]?.id).toBe(opportunity.id);
    }
    recordsAnswer = Effect.fail(forbidden);
    yield* pipelineRecords.refresh(initial.value);
    expect(pipelineRecords.snapshot(initial.value).state).toBe('failed');
  }).pipe(Effect.provide(network)),
);

it.live('does not invent a successful contract section before the independent customer reference exists', () =>
  Effect.gen(function* noCustomerReference() {
    yield* pinTestDocument;
    const counterpartyId = new Map<string, string>().get(opportunity.partyId);
    yield* preloadOpportunityDetails(context, [{ counterpartyId, opportunity }], 7);
    const partial = opportunityRelatedData.snapshot({ ...input, counterpartyId });
    expect(partial.state).toBe('failed');
    if (partial.state === 'failed') {
      expect(partial.error.value.contracts.status).toBe('unavailable');
      expect(partial.error.value.orders.status).toBe('ready');
      expect(partial.error.value.tasks.status).toBe('ready');
    }
    expect(contractReads).toHaveLength(0);
    yield* opportunityRelatedData.read(input);
    expect(contractReads).toHaveLength(1);
    expect(orderReads[0]).toEqual({
      view: { limit: 0, orderOpportunityId: opportunity.id, ordersLimit: 250 },
    });
    expect(taskReads.slice(0, 2)).toEqual([{ opportunityId: opportunity.id }, { partyId: opportunity.partyId }]);
  }).pipe(Effect.provide(network)),
);

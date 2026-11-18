// @rstest-environment happy-dom
import { moduleChangeEvent, pageDataPending } from '@app/shared-contracts/page-data';
import { pinTestDocument, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { InvoiceSchema, RecordsApi as FinanceRecordsApi } from '@app/finance-billing/contracts/records';
import { RecordsApi as PropertyRecordsApi } from '@app/property-portfolio/contracts/records';
import { RecordsApi as AgreementRecordsApi } from '@app/legal-agreements/contracts/records';
import type { RecordsRequestSchema as WorkRecordsRequestSchema } from '@app/work-tasks/contracts/records';
import {
  TaskSchema,
  RecordsApi as WorkRecordsApi,
  RecordsResponseSchema as WorkResponseSchema,
  RecordsForbiddenProblemSchema,
} from '@app/work-tasks/contracts/records';
import type { InProcessApplication } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpRouter, HttpServerRequest } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Fiber, FiberSet, Layer, Option, Result, Schema } from 'effect';
import { afterAll, beforeEach, expect, it } from 'effect-rstest';
import type { CounterpartyReadRequestSchema } from '../../../party-registry/shared/apis/counterparty-read.ts';
import {
  CounterpartyReadApi,
  CounterpartyReadResponseSchema,
  CounterpartyReadForbiddenProblemSchema,
} from '../../../party-registry/shared/apis/counterparty-read.ts';
import { CustomerListApi } from '../../../party-registry/shared/apis/customer-list.ts';
import type { LeaseInvoicesRequestSchema } from '../../../finance-billing/shared/apis/lease-invoices.ts';
import {
  LeaseInvoicesApi,
  LeaseInvoicesResponseSchema,
  LeaseInvoicesForbiddenProblemSchema,
} from '../../../finance-billing/shared/apis/lease-invoices.ts';
import { RecordsApi, OccupancySchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import {
  leaseInputOf,
  leaseRecords,
  leaseOccupant,
  preloadLeaseOccupants,
  prepareLeasePage,
  renderedLeaseOccupantRows,
} from '../../src/routes/[lang]/najmy/lease-occupant.ts';
import {
  invoicesForLease,
  leaseInvoicesExact,
  leaseRelatedView,
  leaseTaskKey,
  leaseTasks,
  preloadLeaseRelated,
} from '../../src/routes/[lang]/najmy/lease-related.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const id = (index: number) => `76000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const context = { legalEntityId: id(90), principalId: id(91), tenantId };
const input = leaseInputOf(context);
const row = (index: number, guest = false) =>
  Schema.decodeSync(OccupancySchema)({
    contractRef: null,
    customerCounterpartyRef: guest
      ? null
      : {
          moduleId: 'party.registry',
          resourceId: id(index + 10),
          resourceType: 'party.registry.counterparty',
          tenantId,
        },
    endDate: null,
    externalBookingCorrelation: null,
    guestPartyRef: guest
      ? { moduleId: 'party.registry', resourceId: id(index + 20), resourceType: 'party.registry.party', tenantId }
      : null,
    kind: guest ? 'SHORT_STAY' : 'LONG_TERM_LEASE',
    note: null,
    occupancyRef: {
      moduleId: 'property.leasing',
      resourceId: id(index),
      resourceType: 'property.leasing.occupancy',
      tenantId,
    },
    peopleCount: null,
    startDate: '2026-10-01',
    state: 'ACTIVE',
    unitRef: {
      moduleId: 'property.portfolio',
      resourceId: id(index + 30),
      resourceType: 'property.portfolio.unit',
      tenantId,
    },
  });

const instant = '2026-10-01T09:00:00.000Z';
const records = Schema.decodeSync(RecordsResponseSchema)({
  occupancies: Array.from({ length: 6 }, (_, index) => row(index + 1)),
  revision: 7,
});
const canonicalRecords = () => {
  const snapshot = leaseRecords.snapshot(input);
  return snapshot.state === 'ready' ? snapshot.value.records : records;
};
const detail = (index: number, revision = 7) => ({
  ...input,
  record: canonicalRecords().occupancies[index - 1] ?? row(index),
  revision,
});
const task = (index: number) =>
  Schema.decodeSync(TaskSchema)({
    collectionRef: {
      moduleId: 'work.tasks',
      resourceId: 'collection-1',
      resourceType: 'work.tasks.task-collection',
      tenantId,
    },
    contextRefs: [row(index).unitRef],
    createdAt: instant,
    priority: 'NORMAL',
    ref: { moduleId: 'work.tasks', resourceId: `task-${index}`, resourceType: 'work.tasks.task', tenantId },
    state: 'NEW',
    title: `Unit task ${index}`,
    updatedAt: instant,
  });
const tasks = Array.from({ length: 6 }, (_, index) => task(index + 1));
const invoice = Schema.decodeSync(InvoiceSchema)({
  accountingCorrelation: 'invoice-correlation',
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: id(11),
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: instant,
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: 'Invoice1',
  dueDate: '2026-10-31',
  issueDate: '2026-10-01',
  occupancyRef: row(1).occupancyRef,
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: { moduleId: 'finance.billing', resourceId: 'invoice-1', resourceType: 'finance.billing.invoice', tenantId },
  totalMinor: 10_000,
  unitRef: row(1).unitRef,
  updatedAt: instant,
});
const workResponse = Schema.decodeUnknownSync(Schema.toType(WorkResponseSchema))({
  actorPrincipalRef: { principalId: context.principalId, tenantId },
  assignablePrincipals: [],
  canWrite: true,
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: task(1).collectionRef,
    title: 'Tasks',
  },
  indicators: { open: 6, openByAssignee: [], overdue: 0 },
  items: tasks,
  principalNames: [],
  referenceDate: '2026-10-01',
  revision: 17,
});
const emptyInvoices = Schema.decodeUnknownSync(LeaseInvoicesResponseSchema)({ invoices: [], revision: 23 });
const counterpartyResponse = Schema.decodeUnknownSync(CounterpartyReadResponseSchema)({
  counterpartyRef: row(1).customerCounterpartyRef,
  createdAt: instant,
  currentRoles: [],
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: context.legalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  party: {
    archived: false,
    canonicalPartyRef: {
      moduleId: 'party.registry',
      resourceId: id(21),
      resourceType: 'party.registry.party',
      tenantId,
    },
    displayName: 'Tenant',
    partyType: 'PERSON',
    storedPartyRef: { moduleId: 'party.registry', resourceId: id(21), resourceType: 'party.registry.party', tenantId },
  },
});
const problem = {
  detail: 'Read denied',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/forbidden',
} as const;
let workAnswer: Effect.Effect<typeof workResponse, typeof RecordsForbiddenProblemSchema.Type> =
  Effect.succeed(workResponse);
let invoiceAnswer: Effect.Effect<typeof emptyInvoices, typeof LeaseInvoicesForbiddenProblemSchema.Type> =
  Effect.succeed(emptyInvoices);
let counterpartyAnswer: Effect.Effect<typeof counterpartyResponse, typeof CounterpartyReadForbiddenProblemSchema.Type> =
  Effect.succeed(counterpartyResponse);
let recordsAnswer = records;
interface ReceivedReads {
  counterparty: (typeof CounterpartyReadRequestSchema.Type)[];
  finance: unknown[];
  leaseInvoices: (typeof LeaseInvoicesRequestSchema.Type)[];
  work: (typeof WorkRecordsRequestSchema.Type)[];
}
const workCorrelations: (string | undefined)[] = [];
const reads: ReceivedReads = { counterparty: [], finance: [], leaseInvoices: [], work: [] };
const Work = WorkRecordsApi.prefix('/work-tasks-api');
const Finance = FinanceRecordsApi.prefix('/finance-billing-api');
const Invoices = LeaseInvoicesApi.prefix('/finance-billing-api');
const Leasing = RecordsApi.prefix('/property-leasing-api');
const Property = PropertyRecordsApi.prefix('/property-portfolio-api');
const Agreement = AgreementRecordsApi.prefix('/legal-agreements-api');
const Counterparty = CounterpartyReadApi.prefix('/party-registry-api');
const Customers = CustomerListApi.prefix('/party-registry-api');
type BrowserRequest = Parameters<
  NonNullable<Window['happyDOM']['settings']['fetch']['interceptor']>['beforeAsyncRequest']
>[0];
const answerBrowserRequest = (
  handler: (request: Request) => Promise<Response>,
  { request, window: sender }: BrowserRequest,
) =>
  Effect.gen(function* answerRequest() {
    const head = { headers: [...request.headers], method: request.method, signal: request.signal };
    const forwarded =
      request.method === 'GET' || request.method === 'HEAD'
        ? new Request(request.url, head)
        : new Request(request.url, { ...head, body: yield* Effect.promise(() => request.arrayBuffer()) });
    const response = yield* Effect.promise(() => handler(forwarded));
    const body = yield* Effect.promise(() => response.arrayBuffer());
    return new sender.Response(body, {
      headers: [...response.headers],
      status: response.status,
      statusText: response.statusText,
    });
  });
// Forward the browser request's AbortSignal too: the shared double currently drops it when
// constructing its server Request, so an interrupted client cannot cancel a blocked HTTP handler.
const cancellableBrowserNetwork = (...applications: readonly [InProcessApplication, ...InProcessApplication[]]) =>
  Layer.effectDiscard(
    Effect.gen(function* interceptRequests() {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(Layer.mergeAll(...applications), { disableLogger: true })),
        (handler) => Effect.promise(() => handler.dispose()),
      );
      const run = yield* FiberSet.makeRuntimePromise();
      const settings = window.happyDOM.settings.fetch;
      const previous = settings.interceptor;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          settings.interceptor = {
            beforeAsyncRequest: (request) => run(answerBrowserRequest(server.handler, request)),
          };
        }),
        () =>
          Effect.sync(() => {
            settings.interceptor = previous;
          }),
      );
    }),
  );
const network = cancellableBrowserNetwork(
  shellGatewayIssuer({
    'finance-billing': '/finance-billing-api',
    'legal-agreements': '/legal-agreements-api',
    'party-registry': '/party-registry-api',
    'property-leasing': '/property-leasing-api',
    'property-portfolio': '/property-portfolio-api',
    'work-tasks': '/work-tasks-api',
  }).application,
  serveApi(
    Work,
    HttpApiBuilder.group(Work, 'records', (g) =>
      g.handle('execute', ({ payload }) =>
        Effect.gen(function* workRequest() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          reads.work.push(payload);
          workCorrelations.push(request.headers['x-correlation-id']);
          return yield* workAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    Finance,
    HttpApiBuilder.group(Finance, 'records', (g) =>
      g.handle('execute', ({ payload }) => {
        reads.finance.push(payload);
        return Effect.die('A related lease must never query the company ledger');
      }),
    ),
  ),
  serveApi(
    Invoices,
    HttpApiBuilder.group(Invoices, 'leaseInvoices', (g) =>
      g.handle('execute', ({ payload }) => {
        reads.leaseInvoices.push(payload);
        return invoiceAnswer;
      }),
    ),
  ),
  serveApi(
    Leasing,
    HttpApiBuilder.group(Leasing, 'records', (g) => g.handle('execute', () => Effect.succeed(recordsAnswer))),
  ),
  serveApi(
    Property,
    HttpApiBuilder.group(Property, 'records', (g) =>
      g.handle('execute', () => Effect.succeed({ assets: [], properties: [], revision: 1, units: [] })),
    ),
  ),
  serveApi(
    Agreement,
    HttpApiBuilder.group(Agreement, 'records', (g) =>
      g.handle('execute', () => Effect.succeed({ contracts: [], documents: [], revision: 1 })),
    ),
  ),
  serveApi(
    Counterparty,
    HttpApiBuilder.group(Counterparty, 'counterpartyRead', (g) =>
      g.handle('execute', ({ payload }) => {
        reads.counterparty.push(payload);
        return counterpartyAnswer;
      }),
    ),
  ),
  serveApi(
    Customers,
    HttpApiBuilder.group(Customers, 'customerList', (g) => g.handle('execute', () => Effect.succeed({ items: [] }))),
  ),
);
afterAll(() => browserRuntime.dispose());
beforeEach(() => {
  for (const entries of Object.values(reads)) {
    entries.length = 0;
  }
  workCorrelations.length = 0;
  workAnswer = Effect.succeed(workResponse);
  invoiceAnswer = Effect.succeed(emptyInvoices);
  counterpartyAnswer = Effect.succeed(counterpartyResponse);
  recordsAnswer = records;
  window.dispatchEvent(new Event(moduleChangeEvent));
});
const warm = (rows = canonicalRecords().occupancies) => preloadLeaseOccupants(input, rows, 7, preloadLeaseRelated);
const seed = leaseRecords.read(input).pipe(Effect.asVoid);

it.layer(network, { excludeTestServices: true })('lease related preload', (suite) => {
  suite.effect('warms only final rendered rows with exact per-row reads and no company-wide ledger query', () =>
    Effect.gen(function* finalRows() {
      yield* pinTestDocument;
      yield* seed;
      const visible = [detail(3).record, detail(1).record];
      yield* warm(renderedLeaseOccupantRows(undefined, undefined, visible));
      expect(reads.work).toEqual([
        { contextResourceId: row(3).unitRef.resourceId },
        { contextResourceId: row(1).unitRef.resourceId },
      ]);
      expect(reads.counterparty).toHaveLength(2);
      expect(leaseTasks.snapshot(detail(2))).toBe(pageDataPending);
      expect(leaseInvoicesExact.snapshot(detail(2))).toBe(pageDataPending);
      expect(reads.leaseInvoices).toHaveLength(2);
      expect(reads.finance).toHaveLength(0);
    }),
  );

  suite.effect('a cold direct URL prepares only the selected authorized row with its exact invoice read', () =>
    Effect.gen(function* coldLink() {
      yield* pinTestDocument;
      yield* prepareLeasePage({ context, routeParams: {}, search: `?resourceId=${id(2)}` }, preloadLeaseRelated);
      expect(leaseTasks.snapshot(detail(2)).state).toBe('ready');
      expect(leaseTasks.snapshot(detail(1))).toBe(pageDataPending);
      expect(reads.work).toContainEqual({ contextResourceId: row(2).unitRef.resourceId });
      expect(workCorrelations).toEqual(['property-leasing.unit-tasks']);
      expect(reads.leaseInvoices).toHaveLength(1);
      expect(leaseInvoicesExact.snapshot(detail(2)).state).toBe('ready');
      expect(leaseInvoicesExact.snapshot(detail(1))).toBe(pageDataPending);
      expect(reads.finance).toHaveLength(0);
      yield* prepareLeasePage({ context, routeParams: {}, search: `?resourceId=${id(99)}` }, preloadLeaseRelated);
      expect(reads.work).toHaveLength(1);
      expect(reads.leaseInvoices).toHaveLength(1);
    }),
  );

  suite.effect('hidden lease lists and outdated revisions cannot warm related data', () =>
    Effect.gen(function* canonicalFence() {
      yield* pinTestDocument;
      yield* seed;
      yield* warm(renderedLeaseOccupantRows(id(1), undefined, records.occupancies));
      yield* warm(renderedLeaseOccupantRows(undefined, id(11), records.occupancies));
      yield* preloadLeaseRelated(detail(1, 8));
      leaseRecords.invalidate();
      yield* preloadLeaseRelated(detail(1));
      expect(reads.work).toHaveLength(0);
      expect(reads.leaseInvoices).toHaveLength(0);
      expect(reads.finance).toHaveLength(0);
    }),
  );

  suite.effect('missing identity and foreign-tenant units never enter the background task cache', () =>
    Effect.gen(function* scopeFence() {
      yield* pinTestDocument;
      yield* seed;
      yield* preloadLeaseOccupants(leaseInputOf(), records.occupancies, 7, preloadLeaseRelated);
      yield* preloadLeaseRelated({ ...detail(1), ...leaseInputOf({ ...context, principalId: '' }) });
      const foreign = {
        ...detail(1),
        record: { ...detail(1).record, unitRef: { ...detail(1).record.unitRef, tenantId: id(99) } },
      };
      yield* preloadLeaseRelated(foreign);
      expect(Result.isFailure(yield* Effect.result(leaseTasks.read(foreign)))).toBe(true);
      expect(reads.work).toHaveLength(0);
      expect(reads.leaseInvoices).toHaveLength(0);
    }),
  );

  suite.effect(
    'keys isolate tenant, principal, company, unit and actual lease revision without substituting owner revisions',
    () =>
      Effect.gen(function* scopeKeys() {
        yield* pinTestDocument;
        const original = leaseTaskKey(detail(1));
        for (const field of ['tenantId', 'principalId', 'legalEntityId'] as const) {
          const changed = leaseInputOf({ ...context, [field]: id(99) });
          expect(leaseTaskKey({ ...detail(1), ...changed })).not.toBe(original);
          expect(leaseInvoicesExact.key({ ...detail(1), ...changed })).not.toBe(leaseInvoicesExact.key(detail(1)));
        }
        expect(leaseTaskKey(detail(2))).not.toBe(original);
        expect(leaseTaskKey(detail(1, 8))).not.toBe(original);
        yield* seed;
        yield* warm([detail(1).record]);
        expect((yield* leaseTasks.read(detail(1))).revision).toBe(17);
        expect((yield* leaseInvoicesExact.read(detail(1))).revision).toBe(23);
        expect(detail(1).revision).toBe(7);
      }),
  );

  suite.effect('refused task and invoice reads render unavailable, not empty or previously allowed data', () =>
    Effect.gen(function* refusedOwners() {
      yield* pinTestDocument;
      workAnswer = Effect.fail(RecordsForbiddenProblemSchema.make(problem));
      invoiceAnswer = Effect.fail(LeaseInvoicesForbiddenProblemSchema.make(problem));
      yield* Effect.result(leaseTasks.read(detail(1)));
      yield* Effect.result(leaseInvoicesExact.read(detail(1)));
      expect(
        leaseRelatedView(detail(1), leaseTasks.snapshot(detail(1)), leaseInvoicesExact.snapshot(detail(1))),
      ).toEqual({ invoices: Option.some('unavailable'), tasks: Option.some('unavailable') });
    }),
  );

  suite.effect('a Finance denial does not erase the separately admitted warmed task section', () =>
    Effect.gen(function* independentOwners() {
      yield* pinTestDocument;
      yield* seed;
      yield* warm([detail(1).record]);
      expect(leaseInvoicesExact.snapshot(detail(1)).state).toBe('ready');
      leaseInvoicesExact.invalidate();
      invoiceAnswer = Effect.fail(LeaseInvoicesForbiddenProblemSchema.make(problem));
      yield* Effect.result(leaseInvoicesExact.read(detail(1)));
      expect(
        leaseRelatedView(detail(1), leaseTasks.snapshot(detail(1)), leaseInvoicesExact.snapshot(detail(1))),
      ).toEqual({
        invoices: Option.some('unavailable'),
        tasks: Option.some([tasks[0]]),
      });
    }),
  );

  suite.effect('an occupant-name denial does not block the separately admitted task preload', () =>
    Effect.gen(function* independentNameRead() {
      yield* pinTestDocument;
      yield* seed;
      counterpartyAnswer = Effect.fail(CounterpartyReadForbiddenProblemSchema.make(problem));
      yield* warm([detail(1).record]);
      expect(leaseOccupant.snapshot(detail(1)).state).toBe('failed');
      expect(leaseTasks.snapshot(detail(1)).state).toBe('ready');
      expect(reads.work).toHaveLength(1);
    }),
  );

  suite.effect('only exact full unit references are accepted from the task context query', () =>
    Effect.gen(function* exactUnitReference() {
      yield* pinTestDocument;
      const encoded = yield* Schema.encodeEffect(TaskSchema)(tasks[0] ?? task(1));
      const foreignTenant = yield* Schema.decodeEffect(TaskSchema)({
        ...encoded,
        contextRefs: [{ ...row(1).unitRef, tenantId: id(99) }],
      });
      const propertyWithSameId = yield* Schema.decodeEffect(TaskSchema)({
        ...encoded,
        contextRefs: [{ ...row(1).unitRef, resourceType: 'property.portfolio.property' }],
      });
      workAnswer = Effect.succeed({ ...workResponse, items: [tasks[0] ?? task(1), foreignTenant, propertyWithSameId] });
      expect((yield* leaseTasks.read(detail(1))).items).toEqual([tasks[0]]);
    }),
  );

  suite.effect('leases of the same unit join one task query without sharing occupant identities', () =>
    Effect.gen(function* sameUnit() {
      yield* pinTestDocument;
      const current = yield* Schema.decodeEffect(RecordsResponseSchema)({
        occupancies: [row(1), { ...row(2), unitRef: row(1).unitRef }],
        revision: 7,
      });
      recordsAnswer = current;
      yield* seed;
      yield* warm(canonicalRecords().occupancies);
      expect(reads.work).toHaveLength(1);
      expect(reads.counterparty).toHaveLength(2);
    }),
  );

  suite.effect('a changed scope or cleared selection cannot render the previous related data', () =>
    Effect.gen(function* scopeSwitch() {
      yield* pinTestDocument;
      yield* leaseTasks.read(detail(1));
      yield* leaseInvoicesExact.read(detail(1));
      const other = { ...detail(1), ...leaseInputOf({ ...context, principalId: id(99) }) };
      expect(leaseRelatedView(other, leaseTasks.snapshot(other), leaseInvoicesExact.snapshot(other))).toEqual({
        invoices: Option.none(),
        tasks: Option.none(),
      });
      expect(
        leaseRelatedView(undefined, leaseTasks.snapshot(detail(1)), leaseInvoicesExact.snapshot(detail(1))),
      ).toEqual({
        invoices: Option.none(),
        tasks: Option.none(),
      });
    }),
  );

  suite.effect('the exact lease read is shared for one lease and kept separate per lease row', () =>
    Effect.gen(function* exactSharing() {
      yield* pinTestDocument;
      invoiceAnswer = Effect.succeed({ invoices: [invoice], revision: 23 });
      yield* seed;
      yield* warm([detail(1).record]);
      expect(reads.leaseInvoices).toHaveLength(1);
      const first = yield* leaseInvoicesExact.read(detail(1));
      const second = yield* leaseInvoicesExact.read({ ...detail(1) });
      expect(second.invoices).toEqual(first.invoices);
      expect(reads.leaseInvoices).toHaveLength(1);
      yield* preloadLeaseRelated(detail(2));
      expect(reads.leaseInvoices).toHaveLength(2);
      expect(reads.finance).toHaveLength(0);
      expect(invoicesForLease(detail(1).record, first.invoices)).toEqual([invoice]);
      expect(invoicesForLease(detail(2).record, second.invoices)).toEqual([]);
    }),
  );

  it('retains the invoice fallback only for an exact unit and Counterparty reference', () => {
    const { occupancyRef, ...fallback } = invoice;
    expect(occupancyRef).toEqual(row(1).occupancyRef);
    expect(invoicesForLease(detail(1).record, [fallback])).toEqual([fallback]);
    expect(invoicesForLease(detail(2).record, [fallback])).toEqual([]);
    const foreign = {
      ...fallback,
      counterpartyRef: { ...fallback.counterpartyRef, tenantId: id(99) },
    };
    expect(invoicesForLease(detail(1).record, [foreign])).toEqual([]);
  });
  suite.effect('caps the combined speculative batch at 200 canonical visible rows', () =>
    Effect.gen(function* maxRows() {
      yield* pinTestDocument;
      const many = yield* Schema.decodeEffect(RecordsResponseSchema)({
        occupancies: Array.from({ length: 202 }, (_, index) => row(index + 1)),
        revision: 7,
      });
      recordsAnswer = many;
      yield* seed;
      yield* warm(canonicalRecords().occupancies);
      expect(reads.counterparty).toHaveLength(200);
      expect(reads.work).toHaveLength(200);
      expect(reads.leaseInvoices).toHaveLength(200);
      expect(reads.finance).toHaveLength(0);
    }),
  );
  suite.effect('two combined background rows join foreground task work and cancellation preserves that join', () =>
    Effect.gen(function* boundedJoin() {
      yield* pinTestDocument;
      yield* seed;
      const started = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const stopped = yield* Deferred.make<boolean>();
      let active = 0;
      let total = 0;
      workAnswer = Effect.gen(function* blockedTasks() {
        active += 1;
        total += 1;
        if (total === 2) {
          yield* Deferred.succeed(started, true);
        }
        return yield* Deferred.await(release).pipe(Effect.as(workResponse));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active -= 1;
            if (active === 1) {
              Deferred.doneUnsafe(stopped, Effect.succeed(true));
            }
          }),
        ),
      );
      const background = yield* Effect.forkChild(warm());
      yield* Deferred.await(started);
      expect(active).toBe(2);
      expect(reads.counterparty).toHaveLength(2);
      const foreground = yield* Effect.forkChild(leaseTasks.read(detail(1)));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(background);
      yield* Deferred.await(stopped);
      expect(active).toBe(1);
      expect(total).toBe(2);
      yield* Deferred.succeed(release, true);
      expect((yield* Fiber.join(foreground)).items).toEqual([tasks[0]]);
      expect(total).toBe(2);
      expect(reads.finance).toHaveLength(0);
    }),
  );
});

import { moduleChangeEvent, moduleWriteEvent, pageDataPending } from '@app/shared-contracts/page-data';
import { InvoiceSchema } from '@app/finance-billing/contracts/records';
import { TaskSchema } from '@app/work-tasks/contracts/records';
import { Deferred, Effect, Fiber, FileSystem, Option, Result, Schema } from 'effect';
import { layer as nodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type ReactRuntime from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OccupancySchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
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
  invalidateLeaseRelated,
  invoicesForLease,
  leaseInvoicesExact,
  leaseRelatedView,
  leaseTaskKey,
  leaseTasks,
  preloadLeaseRelated,
  useLeaseRelated,
} from '../../src/routes/[lang]/najmy/lease-related.ts';

rstest.mock('react', () => ({
  ...rstest.requireActual<typeof ReactRuntime>('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));

const { reads } = rstest.hoisted(() => ({
  reads: {
    agreements: rstest.fn(),
    counterparty: rstest.fn(),
    directory: rstest.fn(),
    finance: rstest.fn(),
    guest: rstest.fn(),
    leaseInvoices: rstest.fn(),
    properties: rstest.fn(),
    records: rstest.fn(),
    work: rstest.fn(),
  },
}));
rstest.mock('@app/party-registry/api/client', () => ({
  executeCounterpartyRead: reads.counterparty,
  executePartyDetail: reads.guest,
  listCustomers: reads.directory,
}));
rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: reads.properties }));
rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: reads.agreements }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: reads.records }));
rstest.mock('@app/finance-billing/clients/records', () => ({ executeRecords: reads.finance }));
rstest.mock('@app/finance-billing/clients/lease-invoices', () => ({
  executeLeaseInvoices: reads.leaseInvoices,
  LEASE_INVOICES_PAGE_LIMIT_MAX: 200,
}));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: reads.work }));
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
const detail = (index: number, revision = 7) => ({
  ...input,
  record: records.occupancies[index - 1] ?? row(index),
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
const workResponse = { items: tasks, revision: 17 };
const financeResponse = { revision: 23, state: { invoices: [invoice] } };
const events = new EventTarget();
beforeAll(() => {
  rstest.stubGlobal('document', {});
  rstest.stubGlobal('addEventListener', events.addEventListener.bind(events));
  rstest.stubGlobal('removeEventListener', events.removeEventListener.bind(events));
  rstest.stubGlobal('dispatchEvent', events.dispatchEvent.bind(events));
});
afterAll(() => {
  rstest.unstubAllGlobals();
  return browserRuntime.dispose();
});
beforeEach(() => {
  rstest.resetAllMocks();
  reads.counterparty.mockReturnValue(Effect.succeed({ party: { displayName: 'Tenant' } }));
  reads.guest.mockReturnValue(Effect.succeed({ party: { displayName: Option.some('Guest') } }));
  reads.directory.mockReturnValue(Effect.succeed([]));
  reads.properties.mockReturnValue(Effect.succeed({ properties: [], units: [] }));
  reads.agreements.mockReturnValue(Effect.succeed({ contracts: [] }));
  reads.records.mockReturnValue(Effect.succeed(records));
  reads.work.mockReturnValue(Effect.succeed(workResponse));
  reads.finance.mockReturnValue(Effect.succeed(financeResponse));
  reads.leaseInvoices.mockReturnValue(Effect.succeed({ invoices: [], revision: 23 }));
  globalThis.dispatchEvent(new Event(moduleChangeEvent));
});
const warm = (rows = records.occupancies) => preloadLeaseOccupants(input, rows, 7, preloadLeaseRelated);
const seed = leaseRecords.read(input).pipe(Effect.asVoid);

it.live('warms only final rendered rows with exact per-row reads and no company-wide ledger query', () =>
  Effect.gen(function* finalRows() {
    yield* seed;
    const visible = [detail(3).record, detail(1).record];
    yield* warm(renderedLeaseOccupantRows(undefined, undefined, visible));
    expect(reads.work.mock.calls.map(([query]) => query)).toEqual([
      { contextResourceId: row(3).unitRef.resourceId },
      { contextResourceId: row(1).unitRef.resourceId },
    ]);
    expect(reads.counterparty).toHaveBeenCalledTimes(2);
    expect(leaseTasks.snapshot(detail(2))).toBe(pageDataPending);
    expect(leaseInvoicesExact.snapshot(detail(2))).toBe(pageDataPending);
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(2);
    expect(reads.finance).not.toHaveBeenCalled();
  }),
);

it.live('a warm opening consumes task details synchronously without another read', () =>
  Effect.gen(function* warmOpen() {
    yield* seed;
    yield* warm([detail(1).record]);
    reads.work.mockClear();
    const Probe = () => {
      const related = useLeaseRelated(detail(1));
      return createElement(
        'output',
        null,
        Option.match(related.tasks, {
          onNone: () => 'loading',
          onSome: (value) => (value === 'unavailable' ? value : value.map((item) => item.title).join('|')),
        }),
      );
    };
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<output>Unit task 1</output>');
    expect((yield* leaseTasks.read(detail(1))).revision).toBe(17);
    expect(reads.work).not.toHaveBeenCalled();
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(1);
    expect(reads.finance).not.toHaveBeenCalled();
  }),
);

it.live('a cold direct URL prepares only the selected authorized row with its exact invoice read', () =>
  Effect.gen(function* coldLink() {
    yield* prepareLeasePage({ context, routeParams: {}, search: `?resourceId=${id(2)}` }, preloadLeaseRelated);
    expect(leaseTasks.snapshot(detail(2)).state).toBe('ready');
    expect(leaseTasks.snapshot(detail(1))).toBe(pageDataPending);
    expect(reads.work).toHaveBeenCalledWith({ contextResourceId: row(2).unitRef.resourceId }, expect.any(String));
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(1);
    expect(leaseInvoicesExact.snapshot(detail(2)).state).toBe('ready');
    expect(leaseInvoicesExact.snapshot(detail(1))).toBe(pageDataPending);
    expect(reads.finance).not.toHaveBeenCalled();
    yield* prepareLeasePage({ context, routeParams: {}, search: `?resourceId=${id(99)}` }, preloadLeaseRelated);
    expect(reads.work).toHaveBeenCalledTimes(1);
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(1);
  }),
);

it.live('hidden tables, stale revisions and rows outside the canonical page cannot warm task data', () =>
  Effect.gen(function* canonicalFence() {
    yield* seed;
    yield* warm(renderedLeaseOccupantRows(id(1), undefined, records.occupancies));
    yield* warm(renderedLeaseOccupantRows(undefined, id(11), records.occupancies));
    yield* preloadLeaseRelated({ ...detail(1), record: { ...detail(1).record } });
    yield* preloadLeaseRelated(detail(1, 8));
    leaseRecords.invalidate();
    yield* preloadLeaseRelated(detail(1));
    expect(reads.work).not.toHaveBeenCalled();
    expect(reads.leaseInvoices).not.toHaveBeenCalled();
    expect(reads.finance).not.toHaveBeenCalled();
  }),
);

it.live('missing identity and foreign-tenant units never enter the background task cache', () =>
  Effect.gen(function* scopeFence() {
    yield* seed;
    yield* preloadLeaseOccupants(leaseInputOf(), records.occupancies, 7, preloadLeaseRelated);
    yield* preloadLeaseRelated({ ...detail(1), ...leaseInputOf({ ...context, principalId: '' }) });
    const foreign = {
      ...detail(1),
      record: { ...detail(1).record, unitRef: { ...detail(1).record.unitRef, tenantId: id(99) } },
    };
    yield* preloadLeaseRelated(foreign);
    expect(Result.isFailure(yield* Effect.result(leaseTasks.read(foreign)))).toBe(true);
    expect(reads.work).not.toHaveBeenCalled();
    expect(reads.leaseInvoices).not.toHaveBeenCalled();
  }),
);

it.live(
  'keys isolate tenant, principal, company, unit and actual lease revision without substituting owner revisions',
  () =>
    Effect.gen(function* scopeKeys() {
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

it.live('two combined background rows join foreground task work and cancellation preserves that join', () =>
  Effect.gen(function* boundedJoin() {
    yield* seed;
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const stopped = yield* Deferred.make<boolean>();
    let active = 0;
    let total = 0;
    reads.work.mockImplementation(() =>
      Effect.gen(function* blockedTasks() {
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
      ),
    );
    const background = yield* Effect.forkChild(warm());
    yield* Deferred.await(started);
    expect(active).toBe(2);
    expect(reads.counterparty).toHaveBeenCalledTimes(2);
    const foreground = yield* Effect.forkChild(leaseTasks.read(detail(1)));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(background);
    yield* Deferred.await(stopped);
    expect(active).toBe(1);
    expect(total).toBe(2);
    yield* Deferred.succeed(release, true);
    expect((yield* Fiber.join(foreground)).items).toEqual([tasks[0]]);
    expect(total).toBe(2);
    expect(reads.finance).not.toHaveBeenCalled();
  }),
);

it.live('unrelated foreground work starts outside the two occupied background rows', () =>
  Effect.gen(function* foregroundPriority() {
    yield* seed;
    const started = yield* Deferred.make<boolean>();
    const foregroundStarted = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    let total = 0;
    reads.work.mockImplementation(() =>
      Effect.gen(function* blockedTasks() {
        total += 1;
        if (total === 2) {
          yield* Deferred.succeed(started, true);
        }
        if (total === 3) {
          yield* Deferred.succeed(foregroundStarted, true);
        }
        return yield* Deferred.await(release).pipe(Effect.as(workResponse));
      }),
    );
    const background = yield* Effect.forkChild(warm());
    yield* Deferred.await(started);
    const foreground = yield* Effect.forkChild(leaseTasks.read(detail(6)));
    yield* Deferred.await(foregroundStarted);
    expect(total).toBe(3);
    yield* Fiber.interrupt(background);
    yield* Deferred.succeed(release, true);
    expect((yield* Fiber.join(foreground)).items).toEqual([tasks[5]]);
    expect(total).toBe(3);
  }),
);

it.live('page cancellation stops both active task reads and every queued row', () =>
  Effect.gen(function* cancelQueue() {
    yield* seed;
    const started = yield* Deferred.make<boolean>();
    const stopped = yield* Deferred.make<boolean>();
    let total = 0;
    let active = 0;
    reads.work.mockImplementation(() =>
      Effect.gen(function* blockedTasks() {
        total += 1;
        active += 1;
        if (active === 2) {
          yield* Deferred.succeed(started, true);
        }
        return yield* Effect.never;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active -= 1;
            if (active === 0) {
              Deferred.doneUnsafe(stopped, Effect.succeed(true));
            }
          }),
        ),
      ),
    );
    const background = yield* Effect.forkChild(warm());
    yield* Deferred.await(started);
    yield* Fiber.interrupt(background);
    yield* Deferred.await(stopped);
    expect(active).toBe(0);
    expect(total).toBe(2);
  }),
);

it.live('live and settled-write refusals clear both related decisions and retry independently', () =>
  Effect.gen(function* invalidation() {
    yield* leaseTasks.read(detail(1));
    yield* leaseInvoicesExact.read(detail(1));
    for (const event of [moduleChangeEvent, moduleWriteEvent]) {
      globalThis.dispatchEvent(new Event(event));
      expect(leaseTasks.snapshot(detail(1))).toBe(pageDataPending);
      expect(leaseInvoicesExact.snapshot(detail(1))).toBe(pageDataPending);
      reads.work.mockReturnValue(Effect.fail({ _tag: 'RecordsForbiddenProblem', status: 403 }));
      reads.leaseInvoices.mockReturnValue(Effect.fail({ _tag: 'LeaseInvoicesForbiddenProblem', status: 403 }));
      yield* Effect.result(leaseTasks.read(detail(1)));
      yield* Effect.result(leaseInvoicesExact.read(detail(1)));
      const view = leaseRelatedView(detail(1), leaseTasks.snapshot(detail(1)), leaseInvoicesExact.snapshot(detail(1)));
      expect(view).toEqual({ invoices: Option.some('unavailable'), tasks: Option.some('unavailable') });
      expect(leaseTasks.snapshot(detail(1))).not.toHaveProperty('value');
      expect(leaseInvoicesExact.snapshot(detail(1))).not.toHaveProperty('value');
      reads.work.mockReturnValue(Effect.succeed(workResponse));
      reads.leaseInvoices.mockReturnValue(Effect.succeed({ invoices: [], revision: 23 }));
      yield* leaseTasks.read(detail(1));
      yield* leaseInvoicesExact.read(detail(1));
    }
    invalidateLeaseRelated();
    expect(leaseTasks.snapshot(detail(1))).toBe(pageDataPending);
    expect(leaseInvoicesExact.snapshot(detail(1))).toBe(pageDataPending);
  }),
);

it.live('a Finance denial does not erase the separately admitted warmed task section', () =>
  Effect.gen(function* independentOwners() {
    yield* seed;
    yield* warm([detail(1).record]);
    expect(leaseInvoicesExact.snapshot(detail(1)).state).toBe('ready');
    leaseInvoicesExact.invalidate();
    reads.leaseInvoices.mockReturnValue(Effect.fail({ _tag: 'LeaseInvoicesForbiddenProblem', status: 403 }));
    yield* Effect.result(leaseInvoicesExact.read(detail(1)));
    expect(leaseRelatedView(detail(1), leaseTasks.snapshot(detail(1)), leaseInvoicesExact.snapshot(detail(1)))).toEqual(
      {
        invoices: Option.some('unavailable'),
        tasks: Option.some([tasks[0]]),
      },
    );
  }),
);

it.live('an occupant-name denial does not block the separately admitted task preload', () =>
  Effect.gen(function* independentNameRead() {
    yield* seed;
    reads.counterparty.mockReturnValue(Effect.fail({ _tag: 'CounterpartyReadForbiddenProblem', status: 403 }));
    yield* warm([detail(1).record]);
    expect(leaseOccupant.snapshot(detail(1)).state).toBe('failed');
    expect(leaseTasks.snapshot(detail(1)).state).toBe('ready');
    expect(reads.work).toHaveBeenCalledTimes(1);
  }),
);

it.live('only exact full unit references are accepted from the task context query', () =>
  Effect.gen(function* exactUnitReference() {
    const encoded = yield* Schema.encodeEffect(TaskSchema)(tasks[0] ?? task(1));
    const foreignTenant = yield* Schema.decodeEffect(TaskSchema)({
      ...encoded,
      contextRefs: [{ ...row(1).unitRef, tenantId: id(99) }],
    });
    const propertyWithSameId = yield* Schema.decodeEffect(TaskSchema)({
      ...encoded,
      contextRefs: [{ ...row(1).unitRef, resourceType: 'property.portfolio.property' }],
    });
    reads.work.mockReturnValue(
      Effect.succeed({ ...workResponse, items: [tasks[0], foreignTenant, propertyWithSameId] }),
    );
    expect((yield* leaseTasks.read(detail(1))).items).toEqual([tasks[0]]);
  }),
);

it.live('leases of the same unit join one task query without sharing occupant identities', () =>
  Effect.gen(function* sameUnit() {
    const current = yield* Schema.decodeEffect(RecordsResponseSchema)({
      occupancies: [row(1), { ...row(2), unitRef: row(1).unitRef }],
      revision: 7,
    });
    reads.records.mockReturnValue(Effect.succeed(current));
    yield* seed;
    yield* warm(current.occupancies);
    expect(reads.work).toHaveBeenCalledTimes(1);
    expect(reads.counterparty).toHaveBeenCalledTimes(2);
  }),
);

it.live('a changed scope or cleared selection cannot render the previous related data', () =>
  Effect.gen(function* scopeSwitch() {
    yield* leaseTasks.read(detail(1));
    yield* leaseInvoicesExact.read(detail(1));
    const other = { ...detail(1), ...leaseInputOf({ ...context, principalId: id(99) }) };
    expect(leaseRelatedView(other, leaseTasks.snapshot(other), leaseInvoicesExact.snapshot(other))).toEqual({
      invoices: Option.none(),
      tasks: Option.none(),
    });
    expect(leaseRelatedView(undefined, leaseTasks.snapshot(detail(1)), leaseInvoicesExact.snapshot(detail(1)))).toEqual(
      {
        invoices: Option.none(),
        tasks: Option.none(),
      },
    );
  }),
);

it.live('the exact lease read is shared for one lease and kept separate per lease row', () =>
  Effect.gen(function* exactSharing() {
    reads.leaseInvoices.mockReturnValue(Effect.succeed({ invoices: [invoice], revision: 23 }));
    yield* seed;
    yield* warm([detail(1).record]);
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(1);
    const first = yield* leaseInvoicesExact.read(detail(1));
    const second = yield* leaseInvoicesExact.read({ ...detail(1) });
    expect(second).toBe(first);
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(1);
    yield* preloadLeaseRelated(detail(2));
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(2);
    expect(reads.finance).not.toHaveBeenCalled();
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

it.live('caps the combined speculative batch at 200 canonical visible rows', () =>
  Effect.gen(function* maxRows() {
    const many = yield* Schema.decodeEffect(RecordsResponseSchema)({
      occupancies: Array.from({ length: 202 }, (_, index) => row(index + 1)),
      revision: 7,
    });
    reads.records.mockReturnValue(Effect.succeed(many));
    yield* seed;
    yield* warm(many.occupancies);
    expect(reads.counterparty).toHaveBeenCalledTimes(200);
    expect(reads.work).toHaveBeenCalledTimes(200);
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(200);
    expect(reads.finance).not.toHaveBeenCalled();
  }),
);

it.layer(nodeFileSystemLayer)('actual page data wiring', (scoped) => {
  scoped.effect('uses the rendered-row seam, cold loader and settled invalidation', () =>
    Effect.gen(function* pageWiring() {
      const fs = yield* FileSystem.FileSystem;
      const page = yield* fs.readFileString(
        new URL('../../src/routes/[lang]/najmy/page.tsx', import.meta.url).pathname,
      );
      expect(page).toContain('modulePagePreload((props) => prepareLeasePage(props, preloadLeaseRelated))');
      expect(page).toContain('renderedLeaseOccupantRows(linkedResourceId, linkedCounterpartyId, visible)');
      expect(page).toContain('Effect.sync(invalidateLeaseRelated)');
      expect(page).toContain('.pipe(Effect.ensuring(Effect.sync(invalidateLeaseRelated)))');
      expect(page).not.toContain('setRelated(');
    }),
  );
});

// @rstest-environment happy-dom
// Real mounted consumer proof for the exact lease-invoice read: the actual `useLeaseRelated` runs under a real
// React root (no hook mocks; only the transport clients are doubled). The mounted cases cover the hook's own
// effect start, revalidation through the supported module events, stale clearing, cancellation on unmount and
// the absence of any broad company-ledger request. The non-mounted cases keep the store-level decisions
// (pagination, drift, cursor stall, scope fence) that do not need a render.
import { moduleChangeEvent, moduleWriteEvent, pageDataPending } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Exit, Fiber, Option, Schema } from 'effect';
import { afterAll, afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { OccupancySchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { leaseInputOf, leaseRecords } from '../../src/routes/[lang]/najmy/lease-occupant.ts';
import {
  leaseInvoicesExact,
  leaseRelatedView,
  leaseTasks,
  preloadLeaseRelated,
  useLeaseRelated,
} from '../../src/routes/[lang]/najmy/lease-related.ts';
import type { LeaseRelated } from '../../src/routes/[lang]/najmy/lease-story.tsx';

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
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: reads.work }));
rstest.mock('@app/finance-billing/clients/lease-invoices', () => ({
  executeLeaseInvoices: reads.leaseInvoices,
  LEASE_INVOICES_PAGE_LIMIT_MAX: 200,
}));

const tenantId = '70000000-0000-4000-8000-000000000020';
const id = (index: number) => `76000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const context = { legalEntityId: id(90), principalId: id(91), tenantId };
const input = leaseInputOf(context);
const occupancyRef = {
  moduleId: 'property.leasing' as const,
  resourceId: id(1),
  resourceType: 'property.leasing.occupancy' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'property.portfolio' as const,
  resourceId: id(31),
  resourceType: 'property.portfolio.unit' as const,
  tenantId,
};
const customerCounterpartyRef = {
  moduleId: 'party.registry' as const,
  resourceId: id(11),
  resourceType: 'party.registry.counterparty' as const,
  tenantId,
};
const row = Schema.decodeSync(OccupancySchema)({
  contractRef: null,
  customerCounterpartyRef,
  endDate: null,
  externalBookingCorrelation: null,
  guestPartyRef: null,
  kind: 'LONG_TERM_LEASE',
  note: null,
  occupancyRef,
  peopleCount: null,
  startDate: '2026-10-01',
  state: 'ACTIVE',
  unitRef,
});
const guestRow = Schema.decodeSync(OccupancySchema)({
  contractRef: null,
  customerCounterpartyRef: null,
  endDate: null,
  externalBookingCorrelation: null,
  guestPartyRef: {
    moduleId: 'party.registry',
    resourceId: id(21),
    resourceType: 'party.registry.party',
    tenantId,
  },
  kind: 'SHORT_STAY',
  note: null,
  occupancyRef: { ...occupancyRef, resourceId: id(2) },
  peopleCount: null,
  startDate: '2026-10-01',
  state: 'ACTIVE',
  unitRef,
});
const records = Schema.decodeSync(RecordsResponseSchema)({ occupancies: [row, guestRow], revision: 7 });
const detail = (record = records.occupancies[0] ?? row, revision = 7) => ({ ...input, record, revision });
const guestDetail = () => detail(records.occupancies[1] ?? guestRow);

const invoiceOf = (index: number) => ({
  occupancyRef,
  ref: {
    moduleId: 'finance.billing',
    resourceId: `invoice-${String(index).padStart(4, '0')}`,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
});
const page = (offset: number, count: number, nextCursor?: string) => {
  const invoices = Array.from({ length: count }, (_, index) => invoiceOf(offset + index));
  return nextCursor === undefined ? { invoices, revision: 23 } : { invoices, nextCursor, revision: 23 };
};

/** The real consumer hook in a real React root; only the transport clients are doubled. */
let latest: LeaseRelated | undefined;
const invoiceTextOf = (related: LeaseRelated | undefined): string =>
  related === undefined
    ? 'unmounted'
    : Option.match(related.invoices, {
        onNone: () => 'loading',
        onSome: (value) => (value === 'unavailable' ? 'unavailable' : String(value.length)),
      });
const RelatedHarness = () => {
  const related = useLeaseRelated(detail());
  useEffect(() => {
    latest = related;
  }, [related]);
  return createElement('output', null, invoiceTextOf(related));
};
const invoiceIds = (): readonly string[] => {
  if (latest === undefined) {
    return [];
  }
  const { invoices } = latest;
  return Option.isNone(invoices) || invoices.value === 'unavailable'
    ? []
    : invoices.value.map((entry) => entry.ref.resourceId);
};

interface Mounted {
  readonly text: () => string;
  readonly unmount: () => void;
}
const mountedViews: Mounted[] = [];
/** One runtime tick as a promise; the React act flush adopts it instead of an async callback. */
const settle = (): Promise<void> => browserRuntime.runPromise(Effect.yieldNow);
/** React async flush: `act` adopts the thenable `settle` returns and awaits it before settling effects. */
const actSettle = (): Promise<void> => Promise.resolve(act(settle));
const mount = (): Effect.Effect<Mounted> =>
  Effect.gen(function* mountConsumerView() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let live = true;
    const view: Mounted = {
      text: () => container.textContent ?? '',
      unmount: () => {
        if (!live) {
          return;
        }
        live = false;
        act(() => {
          root.unmount();
          container.remove();
        });
      },
    };
    mountedViews.push(view);
    act(() => {
      root.render(createElement(RelatedHarness));
    });
    yield* Effect.promise(actSettle);
    return view;
  });
const waitUntil = (condition: () => boolean, attempt = 0): Effect.Effect<void> =>
  Effect.gen(function* waitForMountedRender() {
    if (condition()) {
      return;
    }
    if (attempt >= 400) {
      expect(condition()).toBe(true);
      return;
    }
    yield* Effect.promise(actSettle);
    yield* waitUntil(condition, attempt + 1);
  });
const dispatch = (event: string): Effect.Effect<void> =>
  Effect.promise(() =>
    act(() => {
      globalThis.dispatchEvent(new Event(event));
      return settle();
    }),
  );

afterAll(() => {
  rstest.unstubAllGlobals();
  return browserRuntime.dispose();
});
beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  leaseTasks.invalidate();
  leaseInvoicesExact.invalidate();
  reads.counterparty.mockReturnValue(Effect.succeed({ party: { displayName: 'Tenant' } }));
  reads.guest.mockReturnValue(Effect.succeed({ party: { displayName: Option.some('Guest') } }));
  reads.directory.mockReturnValue(Effect.succeed([]));
  reads.properties.mockReturnValue(Effect.succeed({ properties: [], units: [] }));
  reads.agreements.mockReturnValue(Effect.succeed({ contracts: [] }));
  reads.records.mockReturnValue(Effect.succeed(records));
  reads.work.mockReturnValue(Effect.succeed({ items: [], revision: 17 }));
  reads.finance.mockReturnValue(Effect.succeed({ revision: 23, state: { invoices: [] } }));
  reads.leaseInvoices.mockReturnValue(Effect.succeed(page(1, 1)));
  globalThis.dispatchEvent(new Event(moduleChangeEvent));
});
afterEach(() => {
  for (const view of mountedViews) {
    view.unmount();
  }
  mountedViews.length = 0;
  rstest.unstubAllGlobals();
});
const seed = leaseRecords.read(input).pipe(Effect.asVoid);

it.live('a real mounted consumer collects every exact page and never touches the broad ledger', () =>
  Effect.gen(function* mountedCollection() {
    reads.leaseInvoices
      .mockReturnValueOnce(Effect.succeed(page(1, 200, 'cursor-200')))
      .mockReturnValueOnce(Effect.succeed(page(201, 200, 'cursor-400')))
      .mockReturnValueOnce(Effect.succeed(page(401, 50)));
    const view = yield* mount();
    yield* waitUntil(() => view.text() === '450');
    expect(reads.leaseInvoices.mock.calls.map(([request]) => request)).toEqual([
      { counterpartyRef: customerCounterpartyRef, limit: 200, occupancyRef, unitRef },
      { counterpartyRef: customerCounterpartyRef, cursor: 'cursor-200', limit: 200, occupancyRef, unitRef },
      { counterpartyRef: customerCounterpartyRef, cursor: 'cursor-400', limit: 200, occupancyRef, unitRef },
    ]);
    expect(reads.finance).not.toHaveBeenCalled();
    const collected = yield* leaseInvoicesExact.read(detail());
    expect(collected.invoices).toHaveLength(450);
    expect(new Set(collected.invoices.map((entry) => entry.ref.resourceId)).size).toBe(450);
    expect(leaseInvoicesExact.snapshot(detail()).state).toBe('ready');
  }),
);

it.live('a denied or unavailable revalidation clears ready rows in the mounted consumer', () =>
  Effect.gen(function* mountedDenial() {
    reads.leaseInvoices.mockReturnValueOnce(Effect.succeed(page(1, 2)));
    const view = yield* mount();
    yield* waitUntil(() => view.text() === '2');
    reads.leaseInvoices.mockReturnValue(Effect.fail({ _tag: 'LeaseInvoicesForbiddenProblem', status: 403 }));
    yield* dispatch(moduleChangeEvent);
    yield* waitUntil(() => view.text() === 'unavailable');
    expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
    reads.leaseInvoices.mockReturnValue(Effect.fail({ _tag: 'LeaseInvoicesUnavailableProblem', status: 503 }));
    yield* dispatch(moduleWriteEvent);
    yield* waitUntil(() => view.text() === 'unavailable');
    expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
    expect(reads.finance).not.toHaveBeenCalled();
  }),
);

it.live('revision drift and a stalled cursor render unavailable, then a later event recovers', () =>
  Effect.gen(function* mountedDrift() {
    reads.leaseInvoices
      .mockReturnValueOnce(Effect.succeed(page(1, 1, 'cursor-1')))
      .mockReturnValueOnce(Effect.succeed({ invoices: [invoiceOf(2)], revision: 24 }));
    const view = yield* mount();
    yield* waitUntil(() => view.text() === 'unavailable');
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(2);
    expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
    reads.leaseInvoices.mockReturnValue(Effect.succeed(page(1, 1)));
    yield* dispatch(moduleChangeEvent);
    yield* waitUntil(() => view.text() === '1');
    expect(leaseInvoicesExact.snapshot(detail()).state).toBe('ready');
    reads.leaseInvoices
      .mockReturnValueOnce(Effect.succeed(page(1, 1, 'cursor-1')))
      .mockReturnValueOnce(Effect.succeed(page(1, 1, 'cursor-1')));
    yield* dispatch(moduleChangeEvent);
    yield* waitUntil(() => view.text() === 'unavailable');
    expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
    expect(reads.finance).not.toHaveBeenCalled();
  }),
);

it.live('unmounting cancels the in-flight page without settling a partial or empty success', () =>
  Effect.gen(function* mountedCancel() {
    const started = yield* Deferred.make<boolean>();
    reads.leaseInvoices
      .mockReturnValueOnce(Effect.succeed(page(1, 1, 'cursor-1')))
      .mockImplementationOnce(() => Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)));
    const view = yield* mount();
    yield* waitUntil(() => Deferred.isDoneUnsafe(started));
    expect(leaseInvoicesExact.snapshot(detail())).toBe(pageDataPending);
    expect(view.text()).toBe('loading');
    view.unmount();
    yield* Effect.promise(settle);
    expect(leaseInvoicesExact.snapshot(detail())).toBe(pageDataPending);
    expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
    expect(reads.finance).not.toHaveBeenCalled();
    reads.leaseInvoices.mockReturnValue(Effect.succeed(page(1, 1)));
    const remount = yield* mount();
    yield* waitUntil(() => remount.text() === '1');
    expect(leaseInvoicesExact.snapshot(detail()).state).toBe('ready');
  }),
);

it.live('a settled module write clears ready rows before the next exact collection settles', () =>
  Effect.gen(function* mountedStaleClear() {
    const revalidated = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    reads.leaseInvoices
      .mockReturnValueOnce(Effect.succeed(page(1, 1)))
      .mockImplementationOnce(() =>
        Deferred.succeed(revalidated, true).pipe(Effect.andThen(Deferred.await(release).pipe(Effect.as(page(501, 1))))),
      );
    const view = yield* mount();
    yield* waitUntil(() => view.text() === '1');
    expect(invoiceIds()[0]).toBe('invoice-0001');
    yield* dispatch(moduleWriteEvent);
    yield* waitUntil(() => Deferred.isDoneUnsafe(revalidated));
    expect(leaseInvoicesExact.snapshot(detail())).toBe(pageDataPending);
    expect(view.text()).toBe('loading');
    expect(invoiceIds()).toEqual([]);
    yield* Effect.promise(() => act(() => browserRuntime.runPromise(Deferred.succeed(release, true)).then(settle)));
    yield* waitUntil(() => view.text() === '1');
    expect(invoiceIds()[0]).toBe('invoice-0501');
    expect(reads.finance).not.toHaveBeenCalled();
  }),
);

it.live('preloads every exact page for a validated row and leaves the broad ledger read untouched', () =>
  Effect.gen(function* boundedPrewarm() {
    reads.leaseInvoices
      .mockReturnValueOnce(Effect.succeed(page(1, 200, 'cursor-200')))
      .mockReturnValueOnce(Effect.succeed(page(201, 200, 'cursor-400')))
      .mockReturnValueOnce(Effect.succeed(page(401, 50)));
    yield* seed;
    yield* preloadLeaseRelated(detail());
    expect(reads.leaseInvoices.mock.calls.map(([request]) => request)).toEqual([
      { counterpartyRef: customerCounterpartyRef, limit: 200, occupancyRef, unitRef },
      { counterpartyRef: customerCounterpartyRef, cursor: 'cursor-200', limit: 200, occupancyRef, unitRef },
      { counterpartyRef: customerCounterpartyRef, cursor: 'cursor-400', limit: 200, occupancyRef, unitRef },
    ]);
    const snapshot = leaseInvoicesExact.snapshot(detail());
    expect(snapshot.state).toBe('ready');
    if (snapshot.state === 'ready') {
      expect(snapshot.value.invoices).toHaveLength(450);
      expect(snapshot.value.revision).toBe(23);
      expect(new Set(snapshot.value.invoices.map((entry) => entry.ref.resourceId)).size).toBe(450);
    }
    expect(reads.finance).not.toHaveBeenCalled();
    expect(reads.work).toHaveBeenCalledTimes(1);
  }),
);

it.live('a Finance revision change between pages fails honestly and a later read retries', () =>
  Effect.gen(function* revisionDrift() {
    reads.leaseInvoices
      .mockReturnValueOnce(Effect.succeed(page(1, 1, 'cursor-1')))
      .mockReturnValueOnce(Effect.succeed({ invoices: [invoiceOf(2)], revision: 24 }));
    const exit = yield* Effect.exit(leaseInvoicesExact.read(detail()));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(leaseInvoicesExact.snapshot(detail()).state).toBe('failed');
    reads.leaseInvoices.mockReturnValue(Effect.succeed({ invoices: [invoiceOf(1)], revision: 24 }));
    const retried = yield* leaseInvoicesExact.read(detail());
    expect(retried.invoices).toHaveLength(1);
    expect(retried.revision).toBe(24);
    expect(leaseInvoicesExact.snapshot(detail()).state).toBe('ready');
  }),
);

it.live('a stalled cursor fails instead of looping or claiming completeness', () =>
  Effect.gen(function* stalledCursor() {
    reads.leaseInvoices
      .mockReturnValueOnce(Effect.succeed(page(1, 1, 'cursor-1')))
      .mockReturnValueOnce(Effect.succeed(page(1, 1, 'cursor-1')));
    const exit = yield* Effect.exit(leaseInvoicesExact.read(detail()));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(reads.leaseInvoices).toHaveBeenCalledTimes(2);
    expect(leaseInvoicesExact.snapshot(detail()).state).toBe('failed');
  }),
);

it.live('cancellation stops the in-flight page without settling a partial collection', () =>
  Effect.gen(function* cancelledPage() {
    const started = yield* Deferred.make<boolean>();
    reads.leaseInvoices
      .mockReturnValueOnce(Effect.succeed(page(1, 1, 'cursor-1')))
      .mockImplementationOnce(() => Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)));
    const fiber = yield* Effect.forkChild(leaseInvoicesExact.read(detail()));
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(leaseInvoicesExact.snapshot(detail())).toBe(pageDataPending);
    reads.leaseInvoices.mockReturnValue(Effect.succeed(page(1, 1)));
    const retried = yield* leaseInvoicesExact.read(detail());
    expect(retried.invoices).toHaveLength(1);
  }),
);

it.live('foreign-tenant, unseeded and guest rows never reach the exact read with the wrong request', () =>
  Effect.gen(function* scopeFence() {
    yield* preloadLeaseRelated(detail());
    expect(reads.leaseInvoices).not.toHaveBeenCalled();
    yield* seed;
    const foreign = detail({ ...(records.occupancies[0] ?? row), unitRef: { ...unitRef, tenantId: id(99) } });
    yield* preloadLeaseRelated(foreign);
    expect(reads.leaseInvoices).not.toHaveBeenCalled();
    expect(Exit.isFailure(yield* Effect.exit(leaseInvoicesExact.read(foreign)))).toBe(true);
    yield* preloadLeaseRelated(guestDetail());
    expect(reads.leaseInvoices.mock.calls[0]?.[0]).toEqual({
      limit: 200,
      occupancyRef: guestRow.occupancyRef,
      unitRef: guestRow.unitRef,
    });
  }),
);

it.live('the rendered related view consumes the exact prewarmed invoices authoritatively', () =>
  Effect.gen(function* viewConsumption() {
    yield* seed;
    yield* preloadLeaseRelated(detail());
    const view = leaseRelatedView(detail(), leaseTasks.snapshot(detail()), leaseInvoicesExact.snapshot(detail()));
    expect(view.invoices).toEqual(Option.some([invoiceOf(1)]));
    const pending = leaseRelatedView(detail(), leaseTasks.snapshot(detail()), pageDataPending);
    expect(pending.invoices).toEqual(Option.none());
    const failed = leaseRelatedView(detail(), leaseTasks.snapshot(detail()), {
      error: 'denied',
      refreshing: false,
      state: 'failed',
    });
    expect(failed.invoices).toEqual(Option.some('unavailable'));
  }),
);

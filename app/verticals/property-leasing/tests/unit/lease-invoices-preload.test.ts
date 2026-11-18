// @rstest-environment happy-dom
// The real related-data hook and stores use generated clients against schema-checked owner APIs.
import { acted, settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import { RecordsApi as FinanceRecordsApi } from '@app/finance-billing/contracts/records';
import type { RecordsRequest as FinanceRecordsRequest } from '@app/finance-billing/contracts/records';
import { RecordsApi as AgreementsRecordsApi } from '@app/legal-agreements/contracts/records';
import { RecordsApi as PropertyRecordsApi } from '@app/property-portfolio/contracts/records';
import { moduleChangeEvent, moduleWriteEvent, pageDataPending } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import {
  RecordsApi as WorkRecordsApi,
  RecordsResponseSchema as WorkRecordsResponseSchema,
} from '@app/work-tasks/contracts/records';
import type { RecordsRequest as WorkRecordsRequest } from '@app/work-tasks/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Exit, Option, Schema } from 'effect';
import { afterAll, afterEach, beforeEach, expect, it } from 'effect-rstest';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LeaseInvoicesApi,
  LeaseInvoicesForbiddenProblemSchema,
  LeaseInvoicesUnavailableProblemSchema,
  LeaseInvoicesResponseSchema,
} from '../../../finance-billing/shared/apis/lease-invoices.ts';
import type {
  LeaseInvoicesRequest,
  LeaseInvoicesResponse,
} from '../../../finance-billing/shared/apis/lease-invoices.ts';
import { CustomerListApi } from '../../../party-registry/shared/apis/customer-list.ts';
import { OccupancySchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { Occupancy } from '../../shared/apis/records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { leaseInputOf, leaseRecords } from '../../src/routes/[lang]/najmy/lease-occupant.ts';
import {
  leaseInvoicesExact,
  leaseTasks,
  preloadLeaseRelated,
  useLeaseRelated,
} from '../../src/routes/[lang]/najmy/lease-related.ts';
import type { LeaseRelated } from '../../src/routes/[lang]/najmy/lease-story.tsx';

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
// Prewarming uses the authorized row instance decoded into the actual store, as the page does.
const storedRow = (fallback: Occupancy): Occupancy => {
  const source = leaseRecords.snapshot(input);
  return source.state === 'ready'
    ? (source.value.records.occupancies.find(
        (record) => record.occupancyRef.resourceId === fallback.occupancyRef.resourceId,
      ) ?? fallback)
    : fallback;
};
const detail = (record = storedRow(row), revision = 7) => ({ ...input, record, revision });
const guestDetail = () => detail(storedRow(guestRow));

const invoiceOf = (index: number) => ({
  accountingCorrelation: `lease-invoice-${index}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'DRAFT',
  counterpartyRef: customerCounterpartyRef,
  createdAt: '2026-10-01T00:00:00.000Z',
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: `Lease ${index}`,
  dueDate: '2026-10-15',
  issueDate: '2026-10-01',
  occupancyRef,
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: {
    moduleId: 'finance.billing',
    resourceId: `invoice-${String(index).padStart(4, '0')}`,
    resourceType: 'finance.billing.invoice',
    tenantId,
  },
  totalMinor: 10_000,
  updatedAt: '2026-10-01T00:00:00.000Z',
});
const page = (offset: number, count: number, nextCursor?: string): LeaseInvoicesResponse => {
  const invoices = Array.from({ length: count }, (_, index) => invoiceOf(offset + index));
  return Schema.decodeUnknownSync(LeaseInvoicesResponseSchema)(
    nextCursor === undefined ? { invoices, revision: 23 } : { invoices, nextCursor, revision: 23 },
  );
};
type InvoiceProblem =
  | typeof LeaseInvoicesForbiddenProblemSchema.Type
  | typeof LeaseInvoicesUnavailableProblemSchema.Type;
type InvoiceAnswer = Effect.Effect<LeaseInvoicesResponse, InvoiceProblem>;
let answer: InvoiceAnswer = Effect.succeed(page(1, 1));
const answers: InvoiceAnswer[] = [];
interface RecordedReads {
  readonly finance: FinanceRecordsRequest[];
  readonly leaseInvoices: LeaseInvoicesRequest[];
  readonly work: WorkRecordsRequest[];
}
const reads: RecordedReads = { finance: [], leaseInvoices: [], work: [] };
const emptyWork = Schema.decodeUnknownSync(WorkRecordsResponseSchema)({
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
    ref: { moduleId: 'work.tasks', resourceId: 'default', resourceType: 'work.tasks.task-collection', tenantId },
    title: 'Tasks',
  },
  indicators: { open: 0, openByAssignee: [], overdue: 0 },
  items: [],
  principalNames: [],
  referenceDate: '2026-10-01',
  revision: 17,
});
const FinanceInvoices = LeaseInvoicesApi.prefix('/finance-billing-api');
const FinanceRecords = FinanceRecordsApi.prefix('/finance-billing-api');
const WorkRecords = WorkRecordsApi.prefix('/work-tasks-api');
const LeaseRecords = RecordsApi.prefix('/property-leasing-api');
const PropertyRecords = PropertyRecordsApi.prefix('/property-portfolio-api');
const AgreementsRecords = AgreementsRecordsApi.prefix('/legal-agreements-api');
const Customers = CustomerListApi.prefix('/party-registry-api');
const network = browserNetwork(
  shellGatewayIssuer({
    'finance-billing': '/finance-billing-api',
    'legal-agreements': '/legal-agreements-api',
    'party-registry': '/party-registry-api',
    'property-leasing': '/property-leasing-api',
    'property-portfolio': '/property-portfolio-api',
    'work-tasks': '/work-tasks-api',
  }).application,
  serveApi(
    FinanceInvoices,
    HttpApiBuilder.group(FinanceInvoices, 'leaseInvoices', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.leaseInvoices.push(payload);
          return answers.shift() ?? answer;
        }),
      ),
    ),
  ),
  serveApi(
    FinanceRecords,
    HttpApiBuilder.group(FinanceRecords, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.finance.push(payload);
        }).pipe(Effect.andThen(Effect.never)),
      ),
    ),
  ),
  serveApi(
    WorkRecords,
    HttpApiBuilder.group(WorkRecords, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.work.push(payload);
          return emptyWork;
        }),
      ),
    ),
  ),
  serveApi(
    LeaseRecords,
    HttpApiBuilder.group(LeaseRecords, 'records', (group) => group.handle('execute', () => Effect.succeed(records))),
  ),
  serveApi(
    PropertyRecords,
    HttpApiBuilder.group(PropertyRecords, 'records', (group) =>
      group.handle('execute', () => Effect.succeed({ assets: [], properties: [], revision: 1, units: [] })),
    ),
  ),
  serveApi(
    AgreementsRecords,
    HttpApiBuilder.group(AgreementsRecords, 'records', (group) =>
      group.handle('execute', () => Effect.succeed({ contracts: [], documents: [], revision: 1 })),
    ),
  ),
  serveApi(
    Customers,
    HttpApiBuilder.group(Customers, 'customerList', (group) =>
      group.handle('execute', () => Effect.succeed({ items: [] })),
    ),
  ),
);

/** The real consumer hook in a real React root. */
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
    yield* settle;
    return view;
  });
const dispatch = (event: string): Effect.Effect<void> =>
  acted(() => {
    window.dispatchEvent(new Event(event));
  });

afterAll(() => browserRuntime.dispose());
beforeEach(() => {
  leaseRecords.invalidate();
  leaseTasks.invalidate();
  leaseInvoicesExact.invalidate();
  reads.finance.length = 0;
  reads.leaseInvoices.length = 0;
  reads.work.length = 0;
  answers.length = 0;
  answer = Effect.succeed(page(1, 1));
});
afterEach(() => {
  for (const view of mountedViews.splice(0)) {
    view.unmount();
  }
});
const seed = leaseRecords.read(input).pipe(Effect.asVoid);

it.layer(network, { excludeTestServices: true })('lease invoices preload', (suite) => {
  suite.effect('a real mounted consumer collects every exact page and never touches the broad ledger', () =>
    Effect.gen(function* mountedCollection() {
      yield* pinTestDocument;
      answers.push(
        Effect.succeed(page(1, 200, 'cursor-200')),
        Effect.succeed(page(201, 200, 'cursor-400')),
        Effect.succeed(page(401, 50)),
      );
      const view = yield* mount();
      yield* waitUntil(() => view.text() === '450');
      expect(reads.leaseInvoices).toEqual([
        { counterpartyRef: customerCounterpartyRef, limit: 200, occupancyRef, unitRef },
        { counterpartyRef: customerCounterpartyRef, cursor: 'cursor-200', limit: 200, occupancyRef, unitRef },
        { counterpartyRef: customerCounterpartyRef, cursor: 'cursor-400', limit: 200, occupancyRef, unitRef },
      ]);
      expect(reads.finance).toHaveLength(0);
      const collected = yield* leaseInvoicesExact.read(detail());
      expect(collected.invoices).toHaveLength(450);
      expect(new Set(collected.invoices.map((entry) => entry.ref.resourceId)).size).toBe(450);
      expect(leaseInvoicesExact.snapshot(detail()).state).toBe('ready');
    }),
  );

  suite.effect('a denied or unavailable revalidation clears ready rows in the mounted consumer', () =>
    Effect.gen(function* mountedDenial() {
      yield* pinTestDocument;
      answers.push(Effect.succeed(page(1, 2)));
      const view = yield* mount();
      yield* waitUntil(() => view.text() === '2');
      answer = Effect.fail(
        yield* Schema.decodeUnknownEffect(LeaseInvoicesForbiddenProblemSchema)({
          _tag: 'LeaseInvoicesForbiddenProblem',
          detail: 'Lease invoices are denied',
          status: 403,
          title: 'Forbidden',
          type: 'urn:test:lease-invoices-forbidden',
        }),
      );
      yield* dispatch(moduleChangeEvent);
      yield* waitUntil(() => view.text() === 'unavailable');
      expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
      answer = Effect.fail(
        yield* Schema.decodeUnknownEffect(LeaseInvoicesUnavailableProblemSchema)({
          _tag: 'LeaseInvoicesUnavailableProblem',
          detail: 'Lease invoices are unavailable',
          retryable: true,
          status: 503,
          title: 'Unavailable',
          type: 'urn:test:lease-invoices-unavailable',
        }),
      );
      yield* dispatch(moduleWriteEvent);
      yield* waitUntil(() => view.text() === 'unavailable');
      expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
      expect(reads.finance).toHaveLength(0);
    }),
  );

  suite.effect('revision drift and a stalled cursor render unavailable, then a later event recovers', () =>
    Effect.gen(function* mountedDrift() {
      yield* pinTestDocument;
      answers.push(Effect.succeed(page(1, 1, 'cursor-1')), Effect.succeed({ ...page(2, 1), revision: 24 }));
      const view = yield* mount();
      yield* waitUntil(() => view.text() === 'unavailable');
      expect(reads.leaseInvoices).toHaveLength(2);
      expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
      answer = Effect.succeed(page(1, 1));
      yield* dispatch(moduleChangeEvent);
      yield* waitUntil(() => view.text() === '1');
      expect(leaseInvoicesExact.snapshot(detail()).state).toBe('ready');
      answers.push(Effect.succeed(page(1, 1, 'cursor-1')), Effect.succeed(page(1, 1, 'cursor-1')));
      yield* dispatch(moduleChangeEvent);
      yield* waitUntil(() => view.text() === 'unavailable');
      expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
      expect(reads.finance).toHaveLength(0);
    }),
  );

  suite.effect('unmounting cancels the in-flight page without settling a partial or empty success', () =>
    Effect.gen(function* mountedCancel() {
      yield* pinTestDocument;
      const started = yield* Deferred.make<boolean>();
      answers.push(
        Effect.succeed(page(1, 1, 'cursor-1')),
        Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never)),
      );
      const view = yield* mount();
      yield* Deferred.await(started);
      expect(leaseInvoicesExact.snapshot(detail())).toBe(pageDataPending);
      expect(view.text()).toBe('loading');
      view.unmount();
      yield* settle;
      expect(leaseInvoicesExact.snapshot(detail())).toBe(pageDataPending);
      expect(leaseInvoicesExact.snapshot(detail())).not.toHaveProperty('value');
      expect(reads.finance).toHaveLength(0);
      answer = Effect.succeed(page(1, 1));
      const remount = yield* mount();
      yield* waitUntil(() => remount.text() === '1');
      expect(leaseInvoicesExact.snapshot(detail()).state).toBe('ready');
    }),
  );

  suite.effect('a settled module write clears ready rows before the next exact collection settles', () =>
    Effect.gen(function* mountedStaleClear() {
      yield* pinTestDocument;
      const revalidated = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      answers.push(
        Effect.succeed(page(1, 1)),
        Deferred.succeed(revalidated, true).pipe(Effect.andThen(Deferred.await(release)), Effect.as(page(501, 1))),
      );
      const view = yield* mount();
      yield* waitUntil(() => view.text() === '1');
      expect(invoiceIds()[0]).toBe('invoice-0001');
      yield* dispatch(moduleWriteEvent);
      yield* Deferred.await(revalidated);
      yield* settle;
      expect(leaseInvoicesExact.snapshot(detail())).toBe(pageDataPending);
      expect(view.text()).toBe('loading');
      expect(invoiceIds()).toEqual([]);
      yield* Deferred.succeed(release, true);
      yield* settle;
      yield* waitUntil(() => view.text() === '1');
      expect(invoiceIds()[0]).toBe('invoice-0501');
      expect(reads.finance).toHaveLength(0);
    }),
  );

  suite.effect('preloads every exact page for a validated row and leaves the broad ledger read untouched', () =>
    Effect.gen(function* boundedPrewarm() {
      yield* pinTestDocument;
      answers.push(
        Effect.succeed(page(1, 200, 'cursor-200')),
        Effect.succeed(page(201, 200, 'cursor-400')),
        Effect.succeed(page(401, 50)),
      );
      yield* seed;
      yield* preloadLeaseRelated(detail());
      expect(reads.leaseInvoices).toEqual([
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
      expect(reads.finance).toHaveLength(0);
      expect(reads.work).toHaveLength(1);
    }),
  );

  suite.effect('foreign-tenant, unseeded and guest rows never reach the exact read with the wrong request', () =>
    Effect.gen(function* scopeFence() {
      yield* pinTestDocument;
      yield* preloadLeaseRelated(detail());
      expect(reads.leaseInvoices).toHaveLength(0);
      yield* seed;
      const foreign = detail({ ...(records.occupancies[0] ?? row), unitRef: { ...unitRef, tenantId: id(99) } });
      yield* preloadLeaseRelated(foreign);
      expect(reads.leaseInvoices).toHaveLength(0);
      expect(Exit.isFailure(yield* Effect.exit(leaseInvoicesExact.read(foreign)))).toBe(true);
      yield* preloadLeaseRelated(guestDetail());
      expect(reads.leaseInvoices[0]).toEqual({
        limit: 200,
        occupancyRef: guestRow.occupancyRef,
        unitRef: guestRow.unitRef,
      });
    }),
  );
});

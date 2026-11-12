import { moduleChangeEvent, moduleWriteEvent } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Fiber, Result, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { PropertyRecordSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import {
  preloadPage,
  preloadPropertySummaries,
  propertyRecords,
  propertySummary,
  recordsInput,
  renderedPropertySummaryRows,
} from '../../src/routes/[lang]/nemovitosti/property-summary.ts';

const { reads } = rstest.hoisted(() => ({
  reads: {
    agreements: rstest.fn(),
    employees: rstest.fn(),
    finance: rstest.fn(),
    occupancy: rstest.fn(),
    records: rstest.fn(),
    work: rstest.fn(),
  },
}));
rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: reads.agreements }));
rstest.mock('@app/property-leasing/clients/records', () => ({ executeRecords: reads.occupancy }));
rstest.mock('@app/finance-billing/clients/records', () => ({ executeRecords: reads.finance }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: reads.work }));
rstest.mock('@app/workforce/clients/records', () => ({
  executeRecords: () => reads.employees().pipe(Effect.map((items: readonly object[]) => ({ items }))),
}));
rstest.mock('../../src/api/records-client', () => ({ executeRecords: reads.records }));
const tenantId = '70000000-0000-4000-8000-000000000020';
const id = (index: number) => `76000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const context = { legalEntityId: id(90), principalId: id(91), tenantId };
const input = recordsInput(context);
const row = (index: number) =>
  Schema.decodeSync(PropertyRecordSchema)({
    address: 'Garden Street',
    code: `P-${index}`,
    createdAt: '2026-10-01T09:00:00.000Z',
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: context.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    lifecycleState: 'ACTIVE',
    name: `Property ${index}`,
    note: null,
    propertyRef: {
      moduleId: 'property.portfolio',
      resourceId: id(index),
      resourceType: 'property.portfolio.property',
      tenantId,
    },
    updatedAt: '2026-10-01T09:00:00.000Z',
  });
const detail = (index: number, revision = 7) => ({ ...input, propertyId: id(index), revision });
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
  reads.agreements.mockReturnValue(Effect.succeed({ contracts: [], documents: [] }));
  reads.finance.mockReturnValue(Effect.succeed({ state: { invoices: [] } }));
  reads.occupancy.mockReturnValue(Effect.succeed({ occupancies: [] }));
  reads.work.mockReturnValue(Effect.succeed({ items: [] }));
  reads.employees.mockReturnValue(Effect.succeed([]));
  reads.records.mockReturnValue(
    Effect.succeed(
      Schema.decodeSync(RecordsResponseSchema)({
        assets: [],
        properties: [row(1), row(2), row(3)],
        revision: 7,
        units: [],
      }),
    ),
  );
  globalThis.dispatchEvent(new Event(moduleChangeEvent));
});

it.live('warms only supplied final rows and shares unfiltered owner reads instead of a portfolio burst', () =>
  Effect.gen(function* warmsRows() {
    yield* preloadPropertySummaries(input, [row(2), row(1)], 7);
    expect(reads.finance.mock.calls.map(([query]) => query)).toEqual([{ propertyId: id(2) }, { propertyId: id(1) }]);
    expect(reads.agreements).toHaveBeenCalledTimes(1);
    expect(reads.occupancy).toHaveBeenCalledTimes(1);
    expect(reads.work).toHaveBeenCalledTimes(1);
    expect(propertySummary.snapshot(detail(3)).state).toBe('pending');
    yield* propertySummary.read(detail(2));
    expect(reads.finance).toHaveBeenCalledTimes(2);
  }),
);

it('keys both primary and related data by tenant, principal, company, module and actual revision', () => {
  const original = propertySummary.key(detail(1));
  for (const field of ['tenantId', 'principalId', 'legalEntityId'] as const) {
    const changed = recordsInput({ ...context, [field]: id(99) });
    expect(propertyRecords.key(changed)).not.toBe(propertyRecords.key(input));
    expect(propertySummary.key({ ...changed, propertyId: id(1), revision: 7 })).not.toBe(original);
  }
  expect(propertySummary.key(detail(1, 8))).not.toBe(original);
  expect(original).toContain('property.portfolio');
});

it.live('disables warming with incomplete context and rejects rows from another tenant', () =>
  Effect.gen(function* noScopeReuse() {
    yield* preloadPropertySummaries(recordsInput(), [row(1)], 7);
    yield* preloadPropertySummaries(recordsInput({ ...context, principalId: '' }), [row(1)], 7);
    yield* preloadPropertySummaries(recordsInput({ ...context, tenantId: id(99) }), [row(1)], 7);
    expect(reads.finance).not.toHaveBeenCalled();
  }),
);

it.live(
  'a partial denial stays failed, independently reads other owners, and retries rather than caching a grant',
  () =>
    Effect.gen(function* partialRetry() {
      reads.agreements.mockReturnValueOnce(Effect.fail({ _tag: 'RecordsForbiddenProblem' }));
      const first = yield* propertySummary.read(detail(1)).pipe(Effect.result);
      expect(Result.isFailure(first)).toBe(true);
      if (Result.isFailure(first)) {
        expect(Result.isFailure(first.failure.value.agreements)).toBe(true);
        expect(Result.isSuccess(first.failure.value.finance)).toBe(true);
      }
      expect(propertySummary.snapshot(detail(1)).state).toBe('failed');
      yield* propertySummary.read(detail(1));
      expect(reads.agreements).toHaveBeenCalledTimes(2);
      expect(reads.finance).toHaveBeenCalledTimes(2);
      expect(reads.occupancy).toHaveBeenCalledTimes(1);
      expect(reads.work).toHaveBeenCalledTimes(1);
    }),
);

it.live('two background rows dedupe a foreground join and cancellation leaves only the joined read alive', () =>
  Effect.gen(function* cancelsRows() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const stopped = yield* Deferred.make<boolean>();
    let active = 0;
    let total = 0;
    reads.finance.mockImplementation(() =>
      Effect.gen(function* blockedFinance() {
        active += 1;
        total += 1;
        if (total === 2) {
          yield* Deferred.succeed(started, true);
        }
        return yield* Deferred.await(release).pipe(Effect.as({ state: { invoices: [] } }));
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
    const background = yield* Effect.forkChild(preloadPropertySummaries(input, [row(1), row(2), row(3)], 7));
    yield* Deferred.await(started);
    expect(active).toBe(2);
    const foreground = yield* Effect.forkChild(propertySummary.read(detail(1)));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(background);
    yield* Deferred.await(stopped);
    expect(active).toBe(1);
    expect(total).toBe(2);
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(foreground);
    expect(total).toBe(2);
  }),
);

it.live('live and settled-write invalidation remove old related values even when owner revision is unchanged', () =>
  Effect.gen(function* invalidates() {
    yield* propertySummary.read(detail(1));
    for (const event of [moduleChangeEvent, moduleWriteEvent]) {
      globalThis.dispatchEvent(new Event(event));
      expect(propertySummary.snapshot(detail(1)).state).toBe('pending');
      yield* propertySummary.read(detail(1));
    }
    expect(reads.finance).toHaveBeenCalledTimes(3);
  }),
);

it.live('cold direct property links prepare the selected related summary and never choose an unrelated property', () =>
  Effect.gen(function* directPreload() {
    yield* Effect.promise(() => preloadPage({ context, routeParams: {}, search: `?resourceId=${id(2)}` }));
    expect(propertySummary.snapshot(detail(2)).state).toBe('ready');
    expect(reads.finance).toHaveBeenCalledTimes(1);
    yield* Effect.promise(() => preloadPage({ context, routeParams: {}, search: `?resourceId=${id(99)}` }));
    expect(reads.finance).toHaveBeenCalledTimes(1);
  }),
);

it.live('a denied primary refresh clears the record and writeable snapshot', () =>
  Effect.gen(function* deniedBase() {
    yield* propertyRecords.read(input);
    reads.records.mockReturnValue(Effect.fail({ _tag: 'RecordsForbiddenProblem' }));
    yield* propertyRecords.refresh(input);
    expect(propertyRecords.snapshot(input).state).toBe('failed');
    expect(propertyRecords.snapshot(input)).not.toHaveProperty('value');
  }),
);

it.live('caps speculative work at 200 rendered rows', () =>
  Effect.gen(function* boundsRows() {
    const rows = Array.from({ length: 202 }, (_, index) => row(index + 1));
    yield* preloadPropertySummaries(input, rows, 9);
    expect(reads.finance).toHaveBeenCalledTimes(200);
    expect(propertySummary.snapshot(detail(201, 9)).state).toBe('pending');
  }),
);

it.live('an unrelated foreground row starts outside the two occupied background slots', () =>
  Effect.gen(function* foregroundPriority() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const foregroundStarted = yield* Deferred.make<boolean>();
    let total = 0;
    reads.finance.mockImplementation(() =>
      Effect.gen(function* blockedFinance() {
        total += 1;
        if (total === 2) {
          yield* Deferred.succeed(started, true);
        }
        if (total === 3) {
          yield* Deferred.succeed(foregroundStarted, true);
        }
        return yield* Deferred.await(release).pipe(Effect.as({ state: { invoices: [] } }));
      }),
    );
    const background = yield* Effect.forkChild(preloadPropertySummaries(input, [row(1), row(2), row(3)], 7));
    yield* Deferred.await(started);
    const foreground = yield* Effect.forkChild(propertySummary.read(detail(4)));
    yield* Deferred.await(foregroundStarted);
    expect(total).toBe(3);
    yield* Fiber.interrupt(background);
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(foreground);
    expect(total).toBe(3);
  }),
);

it('warms only the rendered property hierarchy when the portfolio cards are hidden', () => {
  const visible = [row(1), row(2)];
  expect(renderedPropertySummaryRows(undefined, visible)).toEqual(visible);
  expect(renderedPropertySummaryRows(row(2), visible)).toEqual([row(2)]);
});
it('does not reuse incomplete context across mounts or partial identity changes', () => {
  const missing = recordsInput(undefined, 'mount-a');
  expect(propertyRecords.key(recordsInput(undefined, 'mount-b'))).not.toBe(propertyRecords.key(missing));
  expect(propertyRecords.key(recordsInput({ ...context, principalId: '' }, 'mount-a'))).not.toBe(
    propertyRecords.key(missing),
  );
});

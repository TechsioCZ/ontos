// @rstest-environment happy-dom
import {
  RecordsApi as AgreementsApi,
  RecordsResponseSchema as AgreementsResponse,
  RecordsForbiddenProblemSchema as AgreementsForbidden,
} from '@app/legal-agreements/contracts/records';
import {
  RecordsApi as OccupancyApi,
  RecordsResponseSchema as OccupancyResponse,
} from '@app/property-leasing/contracts/records';
import {
  RecordsApi as FinanceApi,
  RecordsResponseSchema as FinanceResponse,
} from '@app/finance-billing/contracts/records';
import type { RecordsRequest as FinanceRequest } from '@app/finance-billing/contracts/records';
import { RecordsApi as WorkApi, RecordsResponseSchema as WorkResponse } from '@app/work-tasks/contracts/records';
import {
  RecordsApi as EmployeesApi,
  RecordsResponseSchema as EmployeesResponse,
} from '@app/workforce/contracts/records';
import {
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
  streamingBrowserNetwork,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Fiber, Result, Schema } from 'effect';
import { afterAll, beforeEach, expect, it } from 'effect-rstest';
import {
  PropertyRecordSchema,
  RecordsResponseSchema,
  RecordsApi,
  RecordsForbiddenProblemSchema,
} from '../../shared/apis/records.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import {
  preloadPage,
  preloadPropertySummaries,
  propertyRecords,
  propertySummary,
  recordsInput,
  renderedPropertySummaryRows,
} from '../../src/routes/[lang]/nemovitosti/property-summary.ts';

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
const agreementsResponse = Schema.decodeUnknownSync(AgreementsResponse)({ contracts: [], documents: [], revision: 7 });
const occupancyResponse = Schema.decodeUnknownSync(OccupancyResponse)({ occupancies: [], revision: 7 });
const financeResponse = Schema.decodeUnknownSync(FinanceResponse)({
  canWrite: true,
  indicators: {
    costMinor: 0,
    costVarianceMinor: 0,
    draftCount: 0,
    grossOutstandingMinor: 0,
    openIncomingInvoices: 0,
    openInvoices: 0,
    openOutgoingInvoices: 0,
    overdueInvoices: 0,
    payablesOutstandingMinor: 0,
    plannedCostMinor: 0,
    plannedRevenueMinor: 0,
    receivablesOutstandingMinor: 0,
    revenueMinor: 0,
    revenueVarianceMinor: 0,
  },
  referenceDate: '2026-10-05',
  revision: 7,
  state: { financialPlanEntries: [], invoices: [] },
});
const actorPrincipalRef = { principalId: context.principalId, tenantId };
const workResponse = Schema.decodeUnknownSync(WorkResponse)({
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
    ref: { moduleId: 'work.tasks', resourceId: 'default', resourceType: 'work.tasks.task-collection', tenantId },
    title: 'Tasks',
  },
  indicators: { open: 0, openByAssignee: [], overdue: 0 },
  items: [],
  principalNames: [],
  referenceDate: '2026-10-05',
  revision: 7,
});
const employeesResponse = Schema.decodeUnknownSync(EmployeesResponse)({
  actorPrincipalRef,
  availablePrincipals: [],
  canWrite: true,
  indicators: {
    active: 0,
    byDepartment: [],
    byRole: { ACCOUNTANT: 0, SALES_HEAD: 0, SALES_REP: 0, SUPPORT: 0, WAREHOUSE: 0 },
    total: 0,
  },
  items: [],
  revision: 7,
});
const recordsResponse = Schema.decodeUnknownSync(RecordsResponseSchema)({
  assets: [],
  properties: [row(1), row(2), row(3)],
  revision: 7,
  units: [],
});
const forbidden = RecordsForbiddenProblemSchema.make({
  detail: 'Read denied',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/records-forbidden',
});
const agreementsForbidden = AgreementsForbidden.make({
  detail: 'Read denied',
  status: 403,
  title: 'Forbidden',
  type: 'https://ontos.dev/problems/records-forbidden',
});
const agreementReads: object[] = [];
const employeeReads: object[] = [];
const financeReads: FinanceRequest[] = [];
const occupancyReads: object[] = [];
const recordReads: object[] = [];
const workReads: object[] = [];
const reads = {
  agreements: agreementReads,
  employees: employeeReads,
  finance: financeReads,
  occupancy: occupancyReads,
  records: recordReads,
  work: workReads,
};
let denyAgreementOnce = false;
let recordsAnswer: Effect.Effect<typeof recordsResponse, typeof forbidden> = Effect.succeed(recordsResponse);
let financeAnswer: Effect.Effect<typeof financeResponse> = Effect.succeed(financeResponse);
const Agreements = AgreementsApi.prefix('/legal-agreements-api');
const Occupancy = OccupancyApi.prefix('/property-leasing-api');
const Finance = FinanceApi.prefix('/finance-billing-api');
const Work = WorkApi.prefix('/work-tasks-api');
const Employees = EmployeesApi.prefix('/workforce-api');
const Records = RecordsApi.prefix('/property-portfolio-api');
const network = streamingBrowserNetwork(
  shellGatewayIssuer({
    'finance-billing': '/finance-billing-api',
    'legal-agreements': '/legal-agreements-api',
    'property-leasing': '/property-leasing-api',
    'property-portfolio': '/property-portfolio-api',
    'work-tasks': '/work-tasks-api',
    workforce: '/workforce-api',
  }).application,
  serveApi(
    Agreements,
    HttpApiBuilder.group(Agreements, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.agreements.push(payload);
          if (denyAgreementOnce) {
            denyAgreementOnce = false;
            return Effect.fail(agreementsForbidden);
          }
          return Effect.succeed(agreementsResponse);
        }),
      ),
    ),
  ),
  serveApi(
    Occupancy,
    HttpApiBuilder.group(Occupancy, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.occupancy.push(payload);
          return occupancyResponse;
        }),
      ),
    ),
  ),
  serveApi(
    Finance,
    HttpApiBuilder.group(Finance, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.finance.push(payload);
          return financeAnswer;
        }),
      ),
    ),
  ),
  serveApi(
    Work,
    HttpApiBuilder.group(Work, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.work.push(payload);
          return workResponse;
        }),
      ),
    ),
  ),
  serveApi(
    Employees,
    HttpApiBuilder.group(Employees, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.employees.push(payload);
          return employeesResponse;
        }),
      ),
    ),
  ),
  serveApi(
    Records,
    HttpApiBuilder.group(Records, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.records.push(payload);
          return recordsAnswer;
        }),
      ),
    ),
  ),
);
afterAll(() => browserRuntime.dispose());
beforeEach(() => {
  for (const requests of Object.values(reads)) {
    requests.length = 0;
  }
  denyAgreementOnce = false;
  recordsAnswer = Effect.succeed(recordsResponse);
  financeAnswer = Effect.succeed(financeResponse);
  window.dispatchEvent(new Event(moduleChangeEvent));
});

it.layer(network, { excludeTestServices: true })('property summary prefetch', (suite) => {
  suite.effect('warms only supplied final rows and shares unfiltered owner reads instead of a portfolio burst', () =>
    Effect.gen(function* warmsRows() {
      yield* pinTestDocument;
      yield* preloadPropertySummaries(input, [row(2), row(1)], 7);
      yield* networkIdle;
      expect(reads.finance).toEqual([{ propertyId: id(2) }, { propertyId: id(1) }]);
      expect(reads.agreements).toHaveLength(1);
      expect(reads.occupancy).toHaveLength(1);
      expect(reads.work).toHaveLength(1);
      expect(propertySummary.snapshot(detail(3)).state).toBe('pending');
      yield* propertySummary.read(detail(2));
      yield* networkIdle;
      expect(reads.finance).toHaveLength(2);
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
  });

  suite.effect('disables warming with incomplete context and rejects rows from another tenant', () =>
    Effect.gen(function* noScopeReuse() {
      yield* pinTestDocument;
      yield* preloadPropertySummaries(recordsInput(), [row(1)], 7);
      yield* preloadPropertySummaries(recordsInput({ ...context, principalId: '' }), [row(1)], 7);
      yield* preloadPropertySummaries(recordsInput({ ...context, tenantId: id(99) }), [row(1)], 7);
      yield* networkIdle;
      expect(reads.finance).toHaveLength(0);
    }),
  );

  suite.effect(
    'a partial denial stays failed, independently reads other owners, and retries rather than caching a grant',
    () =>
      Effect.gen(function* partialRetry() {
        yield* pinTestDocument;
        denyAgreementOnce = true;
        const first = yield* propertySummary.read(detail(1)).pipe(Effect.result);
        expect(Result.isFailure(first)).toBe(true);
        if (Result.isFailure(first)) {
          expect(Result.isFailure(first.failure.value.agreements)).toBe(true);
          expect(Result.isSuccess(first.failure.value.finance)).toBe(true);
        }
        expect(propertySummary.snapshot(detail(1)).state).toBe('failed');
        yield* propertySummary.read(detail(1));
        yield* networkIdle;
        expect(reads.agreements).toHaveLength(2);
        expect(reads.finance).toHaveLength(2);
        expect(reads.occupancy).toHaveLength(1);
        expect(reads.work).toHaveLength(1);
      }),
  );

  suite.effect(
    'cold direct property links prepare the selected related summary and never choose an unrelated property',
    () =>
      Effect.gen(function* directPreload() {
        yield* pinTestDocument;
        yield* Effect.promise(() => preloadPage({ context, routeParams: {}, search: `?resourceId=${id(2)}` }));
        expect(propertySummary.snapshot(detail(2)).state).toBe('ready');
        yield* networkIdle;
        expect(reads.finance).toHaveLength(1);
        yield* Effect.promise(() => preloadPage({ context, routeParams: {}, search: `?resourceId=${id(99)}` }));
        yield* networkIdle;
        expect(reads.finance).toHaveLength(1);
      }),
  );

  suite.effect('a denied primary refresh clears the record and writeable snapshot', () =>
    Effect.gen(function* deniedBase() {
      yield* pinTestDocument;
      yield* propertyRecords.read(input);
      recordsAnswer = Effect.fail(forbidden);
      yield* propertyRecords.refresh(input);
      expect(propertyRecords.snapshot(input).state).toBe('failed');
      expect(propertyRecords.snapshot(input)).not.toHaveProperty('value');
    }),
  );

  it('warms only the rendered property hierarchy when the portfolio cards are hidden', () => {
    const visible = [row(1), row(2)];
    expect(renderedPropertySummaryRows(undefined, visible)).toEqual(visible);
    expect(renderedPropertySummaryRows(row(2), visible)).toEqual([row(2)]);
  });
  suite.effect('caps speculative work at 200 rendered rows', () =>
    Effect.gen(function* boundsRows() {
      yield* pinTestDocument;
      const rows = Array.from({ length: 202 }, (_, index) => row(index + 1));
      yield* preloadPropertySummaries(input, rows, 9);
      yield* networkIdle;
      expect(reads.finance).toHaveLength(200);
      expect(propertySummary.snapshot(detail(201, 9)).state).toBe('pending');
    }),
  );

  it('does not reuse incomplete context across mounts or partial identity changes', () => {
    const missing = recordsInput(undefined, 'mount-a');
    expect(propertyRecords.key(recordsInput(undefined, 'mount-b'))).not.toBe(propertyRecords.key(missing));
    expect(propertyRecords.key(recordsInput({ ...context, principalId: '' }, 'mount-a'))).not.toBe(
      propertyRecords.key(missing),
    );
  });
  suite.effect('two background rows dedupe a foreground join and cancellation leaves only the joined read alive', () =>
    Effect.gen(function* cancelsRows() {
      yield* pinTestDocument;
      const started = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const stopped = yield* Deferred.make<boolean>();
      let active = 0;
      let total = 0;
      financeAnswer = Effect.gen(function* blockedFinance() {
        active += 1;
        total += 1;
        if (total === 2) {
          yield* Deferred.succeed(started, true);
        }
        return yield* Deferred.await(release).pipe(Effect.as(financeResponse));
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
      const background = yield* Effect.forkChild(preloadPropertySummaries(input, [row(1), row(2), row(3)], 7));
      yield* Deferred.await(started);
      yield* networkQuietExcept(2);
      expect(active).toBe(2);
      const foreground = yield* Effect.forkChild(propertySummary.read(detail(1)));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(background);
      yield* Deferred.await(stopped);
      expect(active).toBe(1);
      yield* networkQuietExcept(1);
      expect(total).toBe(2);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(foreground);
      yield* networkIdle;
      expect(total).toBe(2);
    }),
  );
});

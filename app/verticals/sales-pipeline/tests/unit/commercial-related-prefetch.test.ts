import { Deferred, Effect, Fiber, Option, Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import type ReactRuntime from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleChangeEvent, pageDataScopeKey } from '@app/shared-contracts/page-data';
import { OpportunitySchema } from '../../shared/model/opportunity.ts';
import {
  opportunityRelatedData,
  preloadOpportunityDetails,
  useOpportunityRelated,
} from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-related.ts';
import { preloadPage as preloadPipelinePage } from '../../src/routes/[lang]/prodej/prilezitosti/page.tsx';
import { applyPipelineCommand } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-api.ts';
import { pipelineRecords, initialRecordsInput } from '../../src/routes/[lang]/prodej/prilezitosti/pipeline-records.ts';

const mocks = rstest.hoisted(() => ({
  command: rstest.fn(),
  contracts: rstest.fn(),
  orders: rstest.fn(),
  records: rstest.fn(),
  tasks: rstest.fn(),
}));
rstest.mock('@app/shared-contracts', () => ({
  ...rstest.requireActual<object>('@app/shared-contracts'),
  documentNavigationModules: () => new Set(['work.tasks', 'demo.merchandise', 'legal.agreements']),
}));
rstest.mock('@app/merchandise/clients/records', () => ({ listOrders: mocks.orders }));
rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: mocks.contracts }));
rstest.mock('@app/work-tasks/clients/records', () => ({ listTasks: mocks.tasks }));
rstest.mock('../../src/api/records-consumer.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: mocks.command }));
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof ReactRuntime>('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));
const events = new EventTarget();
const globals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};
beforeAll(() => {
  for (const [key, value] of Object.entries(globals)) {
    Reflect.set(globalThis, key, value);
  }
});
afterAll(() => {
  for (const key of Object.keys(globals)) {
    Reflect.deleteProperty(globalThis, key);
  }
});
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
const row = { counterpartyId: 'customer-a', opportunity };
const input = { ...row, revision: 7, scope };
const contracts = {
  contracts: [
    {
      contractRef: { resourceId: 'contract-a' },
      counterpartyRef: { resourceId: 'customer-a' },
      kind: 'OTHER',
      lifecycleState: 'ACTIVE',
      startDate: '2026-11-03',
      subject: 'Visible contract',
    },
  ],
};
beforeEach(() => {
  rstest.resetAllMocks();
  opportunityRelatedData.invalidate();
  pipelineRecords.invalidate();
  mocks.contracts.mockReturnValue(Effect.succeed(contracts));
  mocks.orders.mockReturnValue(Effect.succeed([{ id: 'order-a', number: 'Order A', status: 'NEW', totalMinor: 100 }]));
  mocks.tasks.mockReturnValue(
    Effect.succeed({
      items: [
        {
          dueDate: null,
          opportunityId: opportunity.id,
          ref: { resourceId: 'task-a' },
          state: 'NEW',
          title: 'Visible task',
        },
      ],
    }),
  );
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
it.effect('warms actual related data before selection and renders it without any extra request', () =>
  Effect.gen(function* test() {
    yield* preloadOpportunityDetails(context, [row], 7);
    expect(mocks.contracts).toHaveBeenCalledTimes(1);
    expect(mocks.tasks).toHaveBeenCalledTimes(2);
    expect(mocks.orders).toHaveBeenCalledTimes(1);
    expect(renderToStaticMarkup(createElement(Detail))).toContain('Visible task|Visible contract|Order A');
    yield* opportunityRelatedData.read(input);
    expect(mocks.contracts).toHaveBeenCalledTimes(1);
    expect(mocks.tasks).toHaveBeenCalledTimes(2);
    expect(mocks.orders).toHaveBeenCalledTimes(1);
  }),
);
it.effect('separates tenant, principal, company, module, revision and exact customer link', () =>
  Effect.gen(function* test() {
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
    expect(mocks.contracts).toHaveBeenCalledTimes(7);
    expect(opportunityRelatedData.snapshot(input).state).toBe('ready');
  }),
);
it.effect('does not prefetch with absent or incomplete identity', () =>
  Effect.gen(function* test() {
    yield* preloadOpportunityDetails(undefined, [row], 7);
    yield* preloadOpportunityDetails({ ...context, principalId: '' }, [row], 7);
    expect(mocks.contracts).not.toHaveBeenCalled();
    expect(mocks.tasks).not.toHaveBeenCalled();
  }),
);
it.effect('keeps independent successful sections but never reuses a denial as success', () =>
  Effect.gen(function* test() {
    mocks.contracts.mockReturnValue(Effect.fail({ _tag: 'RecordsForbiddenProblem', status: 403 }));
    yield* preloadOpportunityDetails(context, [row], 7);
    const failed = opportunityRelatedData.snapshot(input);
    expect(failed.state).toBe('failed');
    if (failed.state === 'failed') {
      expect(failed.error.value.contracts.status).toBe('unavailable');
      expect(failed.error.value.tasks.status).toBe('ready');
      expect(failed.error.value.orders.status).toBe('ready');
    }
    mocks.contracts.mockReturnValue(Effect.succeed(contracts));
    yield* opportunityRelatedData.read(input);
    expect(mocks.contracts).toHaveBeenCalledTimes(2);
    expect(opportunityRelatedData.snapshot(input).state).toBe('ready');
  }),
);
it.effect('limits background work to two rows and cancels both active and queued work', () =>
  Effect.gen(function* test() {
    const started = yield* Deferred.make<boolean>();
    let active = 0;
    let stopped = 0;
    mocks.contracts.mockImplementation(() =>
      Effect.gen(function* blocked() {
        active += 1;
        if (active === 2) {
          yield* Deferred.succeed(started, true);
        }
        return yield* Effect.never;
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            stopped += 1;
          }),
        ),
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
    expect(stopped).toBe(2);
    expect(mocks.contracts).toHaveBeenCalledTimes(2);
    expect(mocks.orders).not.toHaveBeenCalled();
  }),
);
it.effect('joins a foreground opening without cancelling it when the background page changes', () =>
  Effect.gen(function* test() {
    const started = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    mocks.contracts.mockImplementation(() =>
      Deferred.succeed(started, true).pipe(Effect.andThen(Deferred.await(release)), Effect.as(contracts)),
    );
    const background = yield* Effect.forkChild(preloadOpportunityDetails(context, [row], 7));
    yield* Deferred.await(started);
    const joined = yield* Effect.forkChild(opportunityRelatedData.read(input));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(background);
    yield* Deferred.succeed(release, true);
    yield* Fiber.join(joined);
    expect(mocks.contracts).toHaveBeenCalledTimes(1);
  }),
);
it.effect('clears warm data on live updates and on a failed settled command', () =>
  Effect.gen(function* test() {
    yield* preloadOpportunityDetails(context, [row], 7);
    events.dispatchEvent(new Event(moduleChangeEvent));
    expect(opportunityRelatedData.snapshot(input).state).toBe('pending');
    yield* opportunityRelatedData.read(input);
    expect(mocks.contracts).toHaveBeenCalledTimes(2);
    mocks.command.mockReturnValue(Effect.fail({ _tag: 'ApplyCommandActionForbiddenProblem', status: 403 }));
    yield* applyPipelineCommand({ _tag: 'ArchiveOpportunity', id: opportunity.id }, 7).pipe(Effect.ignore);
    expect(opportunityRelatedData.snapshot(input).state).toBe('pending');
  }),
);
it.live('preserves a cold URL record and does not return last-authorized rows after a denied refresh', () =>
  Effect.gen(function* test() {
    const initial = initialRecordsInput({ context, routeParams: {}, search: `?opportunityId=${opportunity.id}` });
    expect(Option.isSome(initial)).toBe(true);
    if (Option.isNone(initial)) {
      return;
    }
    mocks.records.mockReturnValue(Effect.succeed({ items: [opportunity], revision: 7 }));
    yield* Effect.promise(() =>
      preloadPipelinePage({ context, routeParams: {}, search: `?opportunityId=${opportunity.id}` }),
    );
    yield* pipelineRecords.read(initial.value);
    expect(mocks.records).toHaveBeenCalledTimes(1);
    const ready = pipelineRecords.snapshot(initial.value);
    expect(ready.state).toBe('ready');
    if (ready.state === 'ready') {
      expect(ready.value.items[0]?.id).toBe(opportunity.id);
    }
    mocks.records.mockReturnValue(Effect.fail({ _tag: 'RecordsForbiddenProblem' }));
    yield* pipelineRecords.refresh(initial.value);
    expect(pipelineRecords.snapshot(initial.value).state).toBe('failed');
  }),
);

it.effect('does not invent a successful contract section before the independent customer reference exists', () =>
  Effect.gen(function* noCustomerReference() {
    const counterpartyId = new Map<string, string>().get(opportunity.partyId);
    yield* preloadOpportunityDetails(context, [{ counterpartyId, opportunity }], 7);
    const partial = opportunityRelatedData.snapshot({ ...input, counterpartyId });
    expect(partial.state).toBe('failed');
    if (partial.state === 'failed') {
      expect(partial.error.value.contracts.status).toBe('unavailable');
      expect(partial.error.value.orders.status).toBe('ready');
      expect(partial.error.value.tasks.status).toBe('ready');
    }
    expect(mocks.contracts).not.toHaveBeenCalled();
    yield* opportunityRelatedData.read(input);
    expect(mocks.contracts).toHaveBeenCalledTimes(1);
    expect(mocks.orders.mock.calls[0]?.[1]).toEqual({ limit: 0, orderOpportunityId: opportunity.id, ordersLimit: 250 });
    expect(mocks.tasks.mock.calls.slice(0, 2).map(([query]) => query)).toEqual([
      { opportunityId: opportunity.id },
      { partyId: opportunity.partyId },
    ]);
  }),
);

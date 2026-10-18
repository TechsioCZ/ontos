import { DateTime, Deferred, Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { dashboardValues } from '../../src/dashboard/dashboard-model.ts';
import { createDashboardQuery, settleDashboardSource } from '../../src/dashboard/dashboard-query.ts';
import type { MetricInputs } from '../../shared/metrics.ts';

const inputs: MetricInputs = {
  employees: [],
  invoices: [],
  movements: [],
  opportunities: [],
  orders: [],
  products: [],
  tasks: [],
};
it('preserves denied and unavailable source states as absent values, never zero', () => {
  const values = dashboardValues(
    inputs,
    { invoices: 'forbidden', opportunities: 'empty', tasks: 'unavailable' },
    '2026-10-15',
  );
  expect(values.find((value) => value.id === 'unpaid_amount')).toMatchObject({ state: 'forbidden' });
  expect(values.find((value) => value.id === 'unpaid_amount')).not.toHaveProperty('value');
  expect(values.find((value) => value.id === 'tasks_open')).not.toHaveProperty('value');
  expect(values.find((value) => value.id === 'opportunities_open')).toMatchObject({ state: 'empty', value: 0 });
});
it('reuses current-state pipeline, confirmed outgoing unpaid and real calendar overdue semantics', () => {
  const data: MetricInputs = {
    ...inputs,
    invoices: [
      {
        businessState: 'CONFIRMED',
        direction: 'OUTGOING',
        issueDate: '2026-01-01',
        paidMinor: 2000,
        paymentState: 'PARTIALLY_PAID',
        totalMinor: 10_000,
      },
      {
        businessState: 'DRAFT',
        direction: 'OUTGOING',
        issueDate: '2026-01-01',
        paidMinor: 0,
        paymentState: 'UNPAID',
        totalMinor: 90_000,
      },
    ],
    opportunities: [
      { amountMinor: 30_000, expectedCloseDate: '2026-11-01', id: 'o', partyId: 'p', probability: 50, stage: 'LEAD' },
    ],
    tasks: [{ dueDate: '2026-10-14', state: 'NEW', updatedAt: DateTime.makeUnsafe('2026-10-14T12:00:00Z') }],
  };
  const values = dashboardValues(data, { invoices: 'ready', opportunities: 'ready', tasks: 'ready' }, '2026-10-15');
  expect(values.map(({ id, value }) => [id, value])).toEqual([
    ['opportunities_open', 1],
    ['pipeline_open_value', 30_000],
    ['unpaid_amount', 8000],
    ['tasks_open', 1],
    ['tasks_overdue', 1],
  ]);
  expect(values.map(({ href }) => href)).toEqual([
    '/prodej/prilezitosti',
    '/prodej/prilezitosti',
    '/siampark/finance',
    '/siampark/work',
    '/siampark/work',
  ]);
});
it.effect('settles independent producer states and retries a denial instead of caching authorization', () =>
  Effect.gen(function* settlesDashboardSources() {
    expect(
      yield* settleDashboardSource(
        Effect.fail({
          _tag: 'RecordsForbiddenProblem',
          detail: 'Denied',
          status: 403,
          title: 'Denied',
          type: 'https://ontos.dev/problems/records-forbidden',
        }),
      ),
    ).toEqual({ items: [], state: 'forbidden' });
    expect(
      yield* settleDashboardSource(
        Effect.fail({
          _tag: 'RecordsUnavailableProblem',
          detail: 'Unavailable',
          retryable: true,
          status: 503,
          title: 'Unavailable',
          type: 'https://ontos.dev/problems/records-unavailable',
        }),
      ),
    ).toEqual({ items: [], state: 'unavailable' });
    expect(yield* settleDashboardSource(Effect.succeed([]))).toEqual({ items: [], state: 'empty' });
    expect(yield* settleDashboardSource(Effect.succeed([1]))).toEqual({ items: [1], state: 'ready' });
  }),
);
it.effect('does not publish a completed request after dashboard unmount', () =>
  Effect.gen(function* unmountedDashboardQuery() {
    let notifications = 0;
    const release = yield* Deferred.make<boolean>();
    const finished = yield* Deferred.make<boolean>();
    const query = createDashboardQuery(
      Deferred.await(release).pipe(
        Effect.tap(() => Deferred.succeed(finished, true)),
        Effect.as([]),
      ),
    );
    const unsubscribe = query.subscribe(() => {
      notifications += 1;
    });
    unsubscribe();
    yield* Deferred.succeed(release, true);
    yield* Deferred.await(finished);
    yield* Effect.yieldNow;
    expect(query.getSnapshot().state).toBe('loading');
    expect(notifications).toBe(1);
  }),
);

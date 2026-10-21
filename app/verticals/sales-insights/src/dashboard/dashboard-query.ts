import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { listInvoices } from '@app/finance-billing/clients/records';
import { listTasks } from '@app/work-tasks/clients/records';
import { DateTime, Effect, Match, Random } from 'effect';
import type { MetricInputs } from '../../shared/metrics.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { dashboardValues } from './dashboard-model.ts';
import type { DashboardSourceState, DashboardValue } from './dashboard-model.ts';

export interface DashboardSourceResult<A> {
  readonly items: readonly A[];
  readonly state: DashboardSourceState;
}
// All three records clients currently expose the same failure union; every call below is checked against it.
type DashboardReadFailure = Effect.Error<ReturnType<typeof listOpportunities>>;
const dashboardFailureState = Match.type<DashboardReadFailure>().pipe(
  Match.tag('RecordsForbiddenProblem', 'GatewayForbiddenProblem', () => 'forbidden' as const),
  Match.tag(
    'RecordsAuthenticationProblem',
    'RecordsInvalidProblem',
    'RecordsUnavailableProblem',
    'RecordsNotFoundProblem',
    'RecordsPolicyProblem',
    'RecordsPolicyConflictProblem',
    'RecordsInternalProblem',
    'GatewayAuthenticationRequiredProblem',
    'GatewayAudienceInvalidProblem',
    'GatewayReloadRequiredProblem',
    'GatewayUnavailableProblem',
    'GatewayInternalProblem',
    'GatewayRateLimitedProblem',
    'DocumentCompositionRevisionError',
    'HttpClientError',
    'SchemaError',
    () => 'unavailable' as const,
  ),
  Match.exhaustive,
);
/** Every visit/retry asks the producer again; a prior denial or a stale navigation cache never grants access. */
export const settleDashboardSource = <A>(
  read: Effect.Effect<readonly A[], DashboardReadFailure>,
): Effect.Effect<DashboardSourceResult<A>> =>
  read.pipe(
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.succeed<DashboardSourceResult<A>>({ items: [], state: dashboardFailureState(error) }),
      onSuccess: (items) =>
        Effect.succeed<DashboardSourceResult<A>>({ items, state: items.length === 0 ? 'empty' : 'ready' }),
    }),
  );

const correlation = Random.nextInt.pipe(Effect.map((id) => `crm-dashboard:${id}`));
export const loadDashboard = Effect.gen(function* loadDashboardEffect() {
  const result = yield* Effect.all(
    {
      invoices: settleDashboardSource(correlation.pipe(Effect.flatMap((id) => listInvoices({}, id)))),
      opportunities: settleDashboardSource(
        correlation.pipe(
          Effect.flatMap((id) => listOpportunities({}, id)),
          Effect.map((response) => response.items),
        ),
      ),
      // Keep this consumer rebuilt with the work contract: referenceDate is a calendar date, not a seed-day literal.
      tasks: settleDashboardSource(listTasks({}).pipe(Effect.map((response) => response.items))),
    },
    { concurrency: 3 },
  );
  const inputs: MetricInputs = {
    employees: [],
    invoices: result.invoices.items,
    movements: [],
    opportunities: result.opportunities.items,
    orders: [],
    products: [],
    tasks: result.tasks.items,
  };
  // Use the same Prague business day as the work producer (including around UTC midnight).
  const today = yield* DateTime.now.pipe(
    Effect.map((now) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(DateTime.toDateUtc(now)),
    ),
  );
  return dashboardValues(
    inputs,
    { invoices: result.invoices.state, opportunities: result.opportunities.state, tasks: result.tasks.state },
    today,
  );
});

export type DashboardSnapshot =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly values: readonly DashboardValue[] };
/** A mounted dashboard owns its query, and unsubscription discards late results. No business data is persisted. */
export const createDashboardQuery = (read: Effect.Effect<readonly DashboardValue[]> = loadDashboard) => {
  const initial: DashboardSnapshot = { state: 'loading' };
  let snapshot: DashboardSnapshot = initial;
  let generation = 0;
  let started = false;
  const listeners = new Set<() => void>();
  const publish = (next: DashboardSnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const reload = () => {
    if (listeners.size === 0) {
      return;
    }
    started = true;
    generation += 1;
    const requested = generation;
    publish(initial);
    void browserRuntime.runPromiseExit(
      read.pipe(
        Effect.tap((values) =>
          Effect.sync(() => {
            if (generation === requested && listeners.size > 0) {
              publish({ state: 'ready', values });
            }
          }),
        ),
      ),
    );
  };
  return {
    getServerSnapshot: () => initial,
    getSnapshot: () => snapshot,
    reload,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (!started) {
        reload();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation += 1;
          started = false;
        }
      };
    },
  };
};

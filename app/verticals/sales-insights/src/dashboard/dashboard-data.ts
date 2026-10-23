import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { listInvoices } from '@app/finance-billing/clients/records';
import { listTasks } from '@app/work-tasks/clients/records';
import { definePageData } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { DateTime, Effect, Match, Random } from 'effect';
import type { MetricInputs } from '../../shared/metrics.ts';
import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { dashboardValues } from './dashboard-model.ts';
import type { DashboardSourceState } from './dashboard-model.ts';

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

/** Formats an instant as the Prague calendar day (YYYY-MM-DD), the business day of the work producer. */
const pragueCalendarDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' });

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
  const today = yield* DateTime.now.pipe(Effect.map((now) => pragueCalendarDay.format(DateTime.toDateUtc(now))));
  return dashboardValues(
    inputs,
    { invoices: result.invoices.state, opportunities: result.opportunities.state, tasks: result.tasks.state },
    today,
  );
});

export interface DashboardInput {
  readonly legalEntityId: string;
}
export const dashboardInputOf = (props: ModulePageProps): DashboardInput => ({
  legalEntityId: props.context?.legalEntityId ?? '',
});

/**
 * The dashboard values of one legal entity, kept for the document so the Shell can prepare them before it reveals
 * Home. A source failure is a card state, so the load itself never fails. Every revalidation asks the producers
 * again, so a prior denial is never cached as an authorization decision.
 */
export const dashboardData = definePageData({
  key: (input: DashboardInput) => input.legalEntityId,
  load: (_input: DashboardInput) => loadDashboard,
  runtime: browserRuntime,
});

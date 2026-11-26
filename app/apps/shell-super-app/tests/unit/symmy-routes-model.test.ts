import { ManageSymmyRoutesActionIneligibleProblemSchema } from '@app/symmy-integration/api/manage-symmy-routes-action';
import { SymmyCompanyRouteSchema } from '@app/symmy-integration/api/symmy-company-routes';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { WorkloadKeySchema } from '../../shared/browser-api.ts';
import {
  SYMMY_EXECUTOR,
  SYMMY_INITIAL_ROUTE_CHOICE,
  SYMMY_PANEL_ROUTES,
  symmyEnableChanges,
  symmyFulfilThenRetry,
  symmyMissingPrerequisites,
  symmyPendingRoutes,
  symmySubmitChange,
} from '../../src/routes/people/symmy-routes-model.ts';
import type { SymmyPrerequisite } from '../../src/routes/people/symmy-routes-model.ts';

const decodeRoute = Schema.decodeUnknownSync(SymmyCompanyRouteSchema);
const route = (routeKey: string, active: boolean, changeToken = 3) =>
  decodeRoute({ active, changeToken, routeId: '6d1d4cdb-72f9-4485-8c07-5806ec9468fe', routeKey, routeRevision: '1' });
const setup = {
  issuerId: ' symmy-akros ',
  retentionDays: 30,
  routeKeys: [...SYMMY_PANEL_ROUTES],
  sourceNamespace: 'akros-erp',
};
const source = { issuerId: 'symmy-akros', sourceNamespace: 'akros-erp' };

it('enables reads before writes, retention only on writes, and the price read source on price lists', () => {
  expect(symmyEnableChanges(setup, [])).toEqual([
    {
      kind: 'enable',
      routeKey: 'priceLists',
      settings: { priceReadSource: { ownerModuleId: 'external.symmy', sourceSystemRef: 'symmy-akros' }, source },
    },
    { kind: 'enable', routeKey: 'adminProducts', settings: { source } },
    { kind: 'enable', routeKey: 'adminCustomers', settings: { source } },
    { kind: 'enable', routeKey: 'adminRegions', settings: { source } },
    { kind: 'enable', routeKey: 'productsBatch', settings: { retentionDays: 30, source } },
    { kind: 'enable', routeKey: 'customersBatch', settings: { retentionDays: 30, source } },
    { kind: 'enable', routeKey: 'customerGroupsBatch', settings: { retentionDays: 30, source } },
    { kind: 'enable', routeKey: 'priceListsBatchUpsert', settings: { retentionDays: 30, source } },
  ]);
});

it('leaves active routes alone, re-enables a disabled one at its token and skips unchosen ones', () => {
  const routes = [route('adminProducts', true), route('productsBatch', false, 7)];
  expect(symmyPendingRoutes(routes)).not.toContain('adminProducts');
  expect(
    symmyEnableChanges({ ...setup, routeKeys: ['adminProducts', 'productsBatch', 'adminRegions'] }, routes),
  ).toEqual([
    { kind: 'enable', routeKey: 'adminRegions', settings: { source } },
    {
      expectedChangeToken: 7,
      kind: 'enable',
      routeKey: 'productsBatch',
      settings: { retentionDays: 30, source },
    },
  ]);
});

it('starts with no route chosen, so an untouched form sends nothing', () => {
  expect(symmyEnableChanges({ ...setup, routeKeys: SYMMY_INITIAL_ROUTE_CHOICE }, [])).toEqual([]);
});

const executorWorkload = 'integration.symmy.execute-symmy-job';
const enrollExecutor = { kind: 'enrollExecutor', ...SYMMY_EXECUTOR } as const;
const registration = {
  kind: 'registerWorkloads',
  workloadKeys: [WorkloadKeySchema.make('commerce.symmy-product-read')],
} as const;

it('writes only what every refusal names: the executor enrollment, then the first workload of each binding', () => {
  expect(
    symmyMissingPrerequisites([
      { code: 'integration_binding_missing', workloads: ['integration.symmy.admit-symmy-sync', 'other'] },
      { code: 'integration_company_registration_missing', workloads: ['commerce.symmy-product-read'] },
      { code: 'executor_binding_missing', workloads: [executorWorkload] },
      { code: 'integration_binding_missing', workloads: ['integration.symmy.admit-symmy-sync'] },
    ]),
  ).toEqual([
    enrollExecutor,
    {
      kind: 'registerWorkloads',
      workloadKeys: ['integration.symmy.admit-symmy-sync', 'commerce.symmy-product-read'],
    },
  ]);
  expect(symmyMissingPrerequisites([{ code: 'executor_binding_missing', workloads: [executorWorkload] }])).toEqual([
    enrollExecutor,
  ]);
  expect(symmyMissingPrerequisites([])).toBeNull();
  expect(
    symmyMissingPrerequisites([
      { code: 'integration_binding_missing', workloads: ['integration.symmy.admit-symmy-sync'] },
      { code: 'executor_binding_not_unique' },
    ]),
  ).toBeNull();
  expect(symmyMissingPrerequisites([{ code: 'integration_binding_missing' }])).toBeNull();
  expect(
    symmyMissingPrerequisites([{ code: 'executor_binding_missing', workloads: ['commerce.other-executor'] }]),
  ).toBeNull();
});

const refused = (refusals: readonly { code: string; workloads?: readonly [string, ...string[]] }[]) =>
  ManageSymmyRoutesActionIneligibleProblemSchema.make({
    code: 'route_enrollment_refused',
    detail: 'The route change was refused.',
    refusals: refusals.map((refusal) => ({ ...refusal, detail: refusal.code })),
    status: 422,
    title: 'Action ineligible',
    type: 'https://ontos.dev/problems/action-ineligible',
  });

/** A route change that answers with each of `outcomes` in turn and counts its calls. */
const routeChange = (...outcomes: (ReturnType<typeof refused> | null)[]) => {
  const calls = { count: 0 };
  const submit = Effect.suspend(() => {
    const outcome = outcomes[calls.count] ?? null;
    calls.count += 1;
    return outcome === null ? Effect.void : Effect.fail(outcome);
  });
  return { calls, submit };
};

it.effect('asks to confirm the refused workloads and the executor and writes nothing before that', () =>
  Effect.gen(function* unconfirmed() {
    const change = routeChange(
      refused([
        { code: 'integration_binding_missing', workloads: ['integration.symmy.admit-symmy-sync'] },
        { code: 'executor_binding_missing', workloads: [executorWorkload] },
      ]),
    );
    expect(yield* symmySubmitChange(change.submit)).toEqual({
      kind: 'confirm',
      prerequisites: [
        enrollExecutor,
        { kind: 'registerWorkloads', workloadKeys: ['integration.symmy.admit-symmy-sync'] },
      ],
    });
    expect(change.calls.count).toBe(1);
    const other = refused([{ code: 'route_drift' }]);
    expect(yield* Effect.flip(symmySubmitChange(routeChange(other).submit))).toBe(other);
    expect(yield* symmySubmitChange(routeChange(null).submit)).toEqual({ kind: 'done' });
  }),
);

it.effect('after confirmation writes exactly the confirmed prerequisites, in order, then repeats the change once', () =>
  Effect.gen(function* confirmed() {
    const written: SymmyPrerequisite[] = [];
    const fulfil = (prerequisite: SymmyPrerequisite) => Effect.sync(() => written.push(prerequisite));
    const change = routeChange(null);
    yield* symmyFulfilThenRetry([enrollExecutor, registration], fulfil, change.submit);
    expect(written).toEqual([enrollExecutor, registration]);
    expect(change.calls.count).toBe(1);
  }),
);

it.effect('names what was already written when a confirmed run fails', () =>
  Effect.gen(function* failedRun() {
    const refusal = refused([{ code: 'route_drift' }]);
    const retryFailure = yield* Effect.flip(
      symmyFulfilThenRetry([enrollExecutor, registration], () => Effect.void, routeChange(refusal).submit),
    );
    expect(retryFailure.done).toEqual([enrollExecutor, registration]);
    expect(retryFailure.failed).toBe('retry');
    expect(retryFailure.problem).toBe(refusal);
    const change = routeChange(null);
    const registrationFailure = yield* Effect.flip(
      symmyFulfilThenRetry(
        [enrollExecutor, registration],
        (prerequisite): Effect.Effect<void, string> =>
          prerequisite.kind === 'registerWorkloads' ? Effect.fail('timeout') : Effect.void,
        change.submit,
      ),
    );
    expect(registrationFailure.done).toEqual([enrollExecutor]);
    expect(registrationFailure.failed).toEqual(registration);
    expect(registrationFailure.problem).toBe('timeout');
    expect(change.calls.count).toBe(0);
  }),
);

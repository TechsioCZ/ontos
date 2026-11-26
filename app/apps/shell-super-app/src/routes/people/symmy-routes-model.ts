import { SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import { ManageSymmyRoutesActionIneligibleProblemSchema } from '@app/symmy-integration/api/manage-symmy-routes-action';
import { SYMMY_BULK_IMPORT_ROUTE_KEYS } from '@app/symmy-integration/actions/manage-symmy-routes';
import type {
  SymmyManagedRouteKey,
  SymmyRouteChangeRequestSchema,
} from '@app/symmy-integration/actions/manage-symmy-routes';
import type { SymmyCompanyRoutesResponse } from '@app/symmy-integration/api/symmy-company-routes';
import { Effect, Option, Schema } from 'effect';

import { SystemWorkloadModuleKeySchema, WorkloadKeySchema } from '../../../shared/browser-api.ts';

/*
 * What the Shell's Symmy panel asks `integration.symmy.manage-symmy-routes` for. Symmy is a connector partner: the
 * administrator names the partner's source identity once, and the panel enables the route families the partner reads
 * and writes in the selected company: Symmy's own bulk-import set (`SYMMY_BULK_IMPORT_ROUTE_KEYS`) and the region read.
 * Route families that need owner references (stock, prices of a list, customer group memberships) are enabled outside
 * this panel.
 */
/** A write route keeps its admitted work for a retention; a read route keeps none. */
const isWriteRoute = (routeKey: SymmyManagedRouteKey) => SYMMY_ROUTES[routeKey].method !== 'GET';
/** Symmy's bulk-import set and the region read its orders need, reads first (the Action applies changes in order). */
const panelRoutes: readonly SymmyManagedRouteKey[] = [
  ...new Set([...SYMMY_BULK_IMPORT_ROUTE_KEYS, 'adminRegions' as const]),
];
export const SYMMY_PANEL_ROUTES: readonly SymmyManagedRouteKey[] = [
  ...panelRoutes.filter((routeKey) => !isWriteRoute(routeKey)),
  ...panelRoutes.filter(isWriteRoute),
];
export const SYMMY_DEFAULT_RETENTION_DAYS = 30;
/** No route starts ticked: only the routes the administrator ticks are sent. */
export const SYMMY_INITIAL_ROUTE_CHOICE: readonly SymmyManagedRouteKey[] = [];
/** The pricing owner module a Symmy price list's prices are read from (the partner's source system). */
const SYMMY_PRICE_OWNER_MODULE = 'external.symmy';

type CompanyRoute = SymmyCompanyRoutesResponse['routes'][number];
/** A change as the panel builds it from the administrator's input; the panel decodes it before it is sent. */
export type SymmyRouteChangeInput = typeof SymmyRouteChangeRequestSchema.Encoded;
type RouteSettingsInput = Extract<SymmyRouteChangeInput, { readonly kind: 'enable' }>['settings'];

export interface SymmyRouteSetup {
  readonly issuerId: string;
  readonly retentionDays: number;
  readonly routeKeys: readonly SymmyManagedRouteKey[];
  readonly sourceNamespace: string;
}

/** A write keeps its admitted work for the retention; a price-list read pages prices from the partner's source. */
const routeSettings = (
  routeKey: SymmyManagedRouteKey,
  retentionDays: number,
  source: RouteSettingsInput['source'],
): RouteSettingsInput => {
  if (routeKey === 'priceLists') {
    return { priceReadSource: { ownerModuleId: SYMMY_PRICE_OWNER_MODULE, sourceSystemRef: source.issuerId }, source };
  }
  return isWriteRoute(routeKey) ? { retentionDays, source } : { source };
};

const baseRoute = (routes: readonly CompanyRoute[], routeKey: SymmyManagedRouteKey) =>
  routes.find((route) => route.routeKey === routeKey && route.routeCode === undefined);

/** The panel's route families not active in the company yet, in panel order. */
export const symmyPendingRoutes = (routes: readonly CompanyRoute[]): readonly SymmyManagedRouteKey[] =>
  SYMMY_PANEL_ROUTES.filter((routeKey) => baseRoute(routes, routeKey)?.active !== true);

/**
 * The enable changes for every chosen route that is not active yet, in panel order: a route never enrolled is
 * enrolled, a disabled one is re-enabled at its change token, an active one is left as it is.
 */
export const symmyEnableChanges = (
  setup: SymmyRouteSetup,
  routes: readonly CompanyRoute[],
): readonly SymmyRouteChangeInput[] => {
  const source = { issuerId: setup.issuerId.trim(), sourceNamespace: setup.sourceNamespace.trim() };
  const chosen = new Set(setup.routeKeys);
  return symmyPendingRoutes(routes).flatMap((routeKey): SymmyRouteChangeInput[] => {
    const stored = baseRoute(routes, routeKey);
    if (!chosen.has(routeKey)) {
      return [];
    }
    const settings = routeSettings(routeKey, setup.retentionDays, source);
    return [
      stored === undefined
        ? { kind: 'enable', routeKey, settings }
        : { expectedChangeToken: stored.changeToken, kind: 'enable', routeKey, settings },
    ];
  });
};

const bindingRefusals = new Set(['integration_binding_missing', 'integration_company_registration_missing']);

/** Symmy's background job writer: the system workload `core.identity.change-system-workload-enrollment` enrolls. */
export const SYMMY_EXECUTOR = {
  moduleKey: SystemWorkloadModuleKeySchema.make('integration.symmy'),
  workloadKey: WorkloadKeySchema.make('integration.symmy.execute-symmy-job'),
};

const WorkloadKeysSchema = Schema.NonEmptyArray(WorkloadKeySchema);
/** One write the panel makes, only after the administrator confirmed it, before it repeats a refused route change. */
export const SymmyPrerequisiteSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('enrollExecutor'),
    moduleKey: SystemWorkloadModuleKeySchema,
    workloadKey: WorkloadKeySchema,
  }),
  Schema.Struct({ kind: Schema.Literal('registerWorkloads'), workloadKeys: WorkloadKeysSchema }),
]);
export type SymmyPrerequisite = typeof SymmyPrerequisiteSchema.Type;
export type SymmyPrerequisites = readonly [SymmyPrerequisite, ...SymmyPrerequisite[]];

interface Refusal {
  readonly code: string;
  readonly workloads?: readonly string[] | undefined;
}

const isExecutorRefusal = ({ code, workloads }: Refusal) =>
  code === 'executor_binding_missing' && workloads?.length === 1 && workloads[0] === SYMMY_EXECUTOR.workloadKey;

/**
 * What the panel would write before repeating a refused route change, in order: the Symmy executor's enrollment when
 * the Tenant has none, then the integration workloads missing in the company (the first of each refusal's
 * alternatives). `null` when any refusal is something else, which is the administrator's to fix.
 */
export const symmyMissingPrerequisites = (refusals: readonly Refusal[]): SymmyPrerequisites | null => {
  const executor = refusals.filter(isExecutorRefusal);
  const bindings = refusals.filter(({ code }) => bindingRefusals.has(code));
  if (executor.length + bindings.length !== refusals.length) {
    return null;
  }
  const firsts = bindings.flatMap(({ workloads }) => workloads?.slice(0, 1) ?? []);
  if (firsts.length < bindings.length) {
    return null;
  }
  const registration = Schema.decodeUnknownOption(WorkloadKeysSchema)([...new Set(firsts)]);
  if (bindings.length > 0 && Option.isNone(registration)) {
    return null;
  }
  const prerequisites: SymmyPrerequisite[] = [
    ...(executor.length > 0 ? [{ kind: 'enrollExecutor' as const, ...SYMMY_EXECUTOR }] : []),
    ...registration.pipe(
      Option.map((workloadKeys) => ({ kind: 'registerWorkloads' as const, workloadKeys })),
      Option.toArray,
    ),
  ];
  const [head, ...tail] = prerequisites;
  return head === undefined ? null : [head, ...tail];
};

const isIneligible = Schema.is(ManageSymmyRoutesActionIneligibleProblemSchema);

/** A submitted route change either went through or waits for the administrator to confirm the writes it needs. */
export type SymmyChangeStep =
  | { readonly kind: 'confirm'; readonly prerequisites: SymmyPrerequisites }
  | { readonly kind: 'done' };

/**
 * Submits a route change once. A refusal the panel can resolve comes back as the writes to confirm; nothing is enrolled
 * or registered here.
 */
export const symmySubmitChange = <E, R>(submit: Effect.Effect<unknown, E, R>): Effect.Effect<SymmyChangeStep, E, R> =>
  submit.pipe(
    Effect.as<SymmyChangeStep>({ kind: 'done' }),
    Effect.catchIf(isIneligible, (problem) => {
      const prerequisites = symmyMissingPrerequisites(problem.refusals ?? []);
      return prerequisites === null
        ? Effect.fail(problem)
        : Effect.succeed<SymmyChangeStep>({ kind: 'confirm', prerequisites });
    }),
  );

/** Where a confirmed run stopped: the writes that went through, the step that failed, and its problem. */
export class SymmyConfirmedRunFailed extends Schema.TaggedError<SymmyConfirmedRunFailed>()('SymmyConfirmedRunFailed', {
  done: Schema.Array(SymmyPrerequisiteSchema),
  failed: Schema.Union([SymmyPrerequisiteSchema, Schema.Literal('retry')]),
  problem: Schema.Unknown,
}) {}

/**
 * After the administrator confirmed: makes exactly the confirmed writes, one after another, then repeats the route
 * change once. A failure names the writes that already went through.
 */
export const symmyFulfilThenRetry = <E, R, ES, RS>(
  prerequisites: SymmyPrerequisites,
  fulfil: (prerequisite: SymmyPrerequisite) => Effect.Effect<unknown, E, R>,
  submit: Effect.Effect<unknown, ES, RS>,
): Effect.Effect<void, SymmyConfirmedRunFailed, R | RS> =>
  Effect.forEach(
    prerequisites,
    (prerequisite, index) =>
      fulfil(prerequisite).pipe(
        Effect.mapError(
          (problem) =>
            new SymmyConfirmedRunFailed({ done: prerequisites.slice(0, index), failed: prerequisite, problem }),
        ),
      ),
    { concurrency: 1, discard: true },
  ).pipe(
    Effect.andThen(
      submit.pipe(
        Effect.mapError((problem) => new SymmyConfirmedRunFailed({ done: prerequisites, failed: 'retry', problem })),
      ),
    ),
  );

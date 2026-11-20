/**
 * One operator enrollment of one Symmy route, over the administrative Core database.
 *
 * The runtime role only reads `symmy_integration.job_routes`; the route is written by the migration and operator
 * login, whose writes the route trigger publishes as the route's execution gate. Every check reads published or Core
 * facts through their owners' exported readers. An apply transaction first takes the enrollment lock of the route's
 * Tenant, principal and source family (`symmyRouteEnrollmentLockKey`), so its checks across companies and sibling
 * routes see every enrollment committed before it; it then reads the route rows and outstanding work under the
 * route's row lock, writes, reads the write back and appends who changed the route and why
 * (`symmy_integration.route_enrollment_records`). dry-run and verify take no lock and only share the rows they read.
 * No owner Action or read is called, so no lock is ever held across one.
 *
 * A replacement keeps the route id and rotates the execution epoch (the trigger publishes it as a replaced
 * enrollment). The row lock quiesces admissions for the length of the transaction: an admission locks the same row
 * with `lock_symmy_enrollment_snapshot`, waits for this transaction, and then no longer matches the snapshot it read. A
 * route with outstanding work is never replaced, because the rotated epoch would close the fence of every job it
 * admitted; the refusal lists that work and how it is resolved.
 */
import {
  ActiveApplicationCompositionService,
  loadCheckedActiveApplicationComposition,
  makeLegalEntityContext,
  makeTenantModuleStateService,
  principalEligibilityForTransaction,
} from '@app/core-runtime';
import { readActiveWorkloadBindingHolders } from '@app/core-runtime/access/enforcement';
import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { and, eq, inArray, isNull, ne, notExists, sql } from 'drizzle-orm';
import { Config, Effect, Option, Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyJobLifecyclePolicyRefSchema } from '../../shared/domain/symmy-job-notification.ts';
import { SymmyJobRetentionPolicySchema } from '../../shared/domain/symmy-job-retention.ts';
import {
  symmyImportJobs,
  symmyJobEffects,
  symmyJobRetentionTombstones,
  symmyJobRoutes,
  symmyRouteEnrollmentRecords,
  symmySyncAdmissions,
} from '../db/schema.ts';
import {
  SymmyRequiredBindingSchema,
  checkSymmyRouteBindings,
  deriveSymmyRouteBindings,
  symmyBindingWorkloads,
} from './symmy-route-bindings.ts';
import { SymmyRouteEnrollmentRefused } from './symmy-route-enrollment-refused.ts';
import type { SymmyRouteEnrollmentRefusal } from './symmy-route-enrollment-refused.ts';
import { SymmyRouteEnrollmentUnavailable } from './symmy-route-enrollment-unavailable.ts';
import {
  SymmyRouteEnrollmentRequestSchema,
  SymmyRuntimePrerequisiteSchema,
  decideSymmyRouteWrite,
  symmyCoreRefusals,
  symmyEnrolledInventory,
  symmyOutstandingRefusals,
  symmyPlannedRouteRow,
  symmyRelatedRouteRefusals,
  symmyRetentionRefusals,
  symmyRouteDifferences,
  symmyRouteEnrollmentLockKey,
  symmyRouteInventoryOf,
  symmyRouteRequestRefusals,
  symmyRuntimePrerequisites,
  symmySourceFamilyPeers,
} from './symmy-route-enrollment.ts';
import type {
  SymmyRouteChange,
  SymmyRouteEnrollmentRequest,
  SymmyRouteEnrollmentWrite,
  SymmyRouteInventory,
} from './symmy-route-enrollment.ts';
import type { SymmyRouteBindingPlan } from './symmy-route-bindings.ts';

/** The outstanding work a refusal names; the operator re-runs once it has been resolved. */
const OUTSTANDING_LIMIT = 50;

type CoreExecutor = (typeof CoreDatabase)['Service']['executor'];
type Transaction = Parameters<Parameters<CoreExecutor['transaction']>[0]>[0];

const SymmyRouteEnrollmentModeSchema = Schema.Literals(['dry-run', 'apply', 'verify']);

export const SymmyRouteEnrollmentReceiptSchema = Schema.Struct({
  /** The one active system principal that runs each executor workload of the route. */
  executors: Schema.Array(
    Schema.Struct({
      principalId: PrincipalIdSchema,
      workloadKey: Schema.String.pipe(Schema.brand('SymmyRouteExecutorWorkloadKey')),
    }),
  ),
  mode: SymmyRouteEnrollmentModeSchema,
  outcome: Schema.Literals([
    'deactivated',
    'enrolled',
    'replaced',
    'unchanged',
    'verified',
    'would_deactivate',
    'would_enroll',
    'would_replace',
  ]),
  requiredBindings: Schema.Array(SymmyRequiredBindingSchema),
  routeId: SymmyRouteEnrollmentRequestSchema.fields.routeId,
  routeKey: SymmyRouteEnrollmentRequestSchema.fields.routeKey,
  /** The Shell's and Symmy's own configuration the route needs, which the command cannot read. */
  runtimePrerequisites: Schema.Array(SymmyRuntimePrerequisiteSchema),
  /** The enrolled routes of the same source whose logical source identity this route matches. */
  sourcePeers: Schema.Array(
    Schema.Struct({
      routeId: SymmyRouteEnrollmentRequestSchema.fields.routeId,
      routeKey: SymmyRouteEnrollmentRequestSchema.fields.routeKey,
    }),
  ),
});
export type SymmyRouteEnrollmentReceipt = typeof SymmyRouteEnrollmentReceiptSchema.Type;

/** Who applies a change and why, as the operator states it; recorded with every change it applies. */
export const SymmyRouteEnrollmentAttributionSchema = Schema.Struct({
  operatorRef: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200)),
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type SymmyRouteEnrollmentAttribution = typeof SymmyRouteEnrollmentAttributionSchema.Type;

const unavailable = (reason: string) => (cause?: unknown) => new SymmyRouteEnrollmentUnavailable({ cause, reason });
const refusalOf = (code: SymmyRouteEnrollmentRefusal['code'], detail: string): SymmyRouteEnrollmentRefusal => ({
  code,
  detail,
});
const refuse = (first: SymmyRouteEnrollmentRefusal, ...rest: readonly SymmyRouteEnrollmentRefusal[]) =>
  Effect.fail(new SymmyRouteEnrollmentRefused({ refusals: [first, ...rest] }));
/** Fails with every refusal at once, so the operator sees the whole list in one run. */
const refused = (refusals: readonly SymmyRouteEnrollmentRefusal[]) => {
  const [first, ...rest] = refusals;
  return first === undefined ? Effect.void : refuse(first, ...rest);
};

const decodeRequest = Schema.decodeUnknownEffect(SymmyRouteEnrollmentRequestSchema, { onExcessProperty: 'error' });
const decodeAttribution = Schema.decodeUnknownEffect(SymmyRouteEnrollmentAttributionSchema, {
  onExcessProperty: 'error',
});
const decodeReceipt = Schema.decodeUnknownEffect(SymmyRouteEnrollmentReceiptSchema);
const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(SymmyFixtureExecutionPlanSchema));
const encodePolicy = Schema.encodeEffect(Schema.fromJsonString(SymmyJobLifecyclePolicyRefSchema));
const isRefused = Schema.is(SymmyRouteEnrollmentRefused);
const isUnavailable = Schema.is(SymmyRouteEnrollmentUnavailable);

/** The Core facts the route depends on, each read through its owner's exported reader. */
const coreRefusals = Effect.fn('SymmyRouteEnrollment.coreRefusals')(function* coreRefusals(
  transaction: Transaction,
  request: SymmyRouteEnrollmentRequest,
  moduleKeys: readonly string[],
) {
  const states = yield* makeTenantModuleStateService({ executor: transaction })
    .getTenantModuleStates(request.tenantId, moduleKeys)
    .pipe(Effect.mapError(unavailable('The Tenant module states could not be read')));
  const active = new Set(states.flatMap(({ moduleKey, state }) => (state === 'active' ? [moduleKey] : [])));
  const companyActive =
    request.legalEntityId === undefined ||
    (yield* makeLegalEntityContext({ executor: transaction })
      .validateSelection(request.tenantId, request.legalEntityId)
      .pipe(
        Effect.as(true),
        Effect.catchTag('LegalEntityContextUnavailableError', (cause) =>
          Effect.fail(unavailable('The company could not be read')(cause)),
        ),
        Effect.orElseSucceed(() => false),
      ));
  const principal = yield* principalEligibilityForTransaction(transaction).resolve({
    principalId: request.principalId,
    tenantId: request.tenantId,
  });
  if (principal.decision === 'unavailable') {
    return yield* unavailable('The integration principal could not be read')();
  }
  return symmyCoreRefusals({
    activeModules: active,
    companyActive,
    moduleKeys,
    principalIneligible: principal.decision === 'eligible' ? Option.none() : Option.some(principal.reason),
  });
});

const codeMatch = (routeCode: string | undefined) =>
  routeCode === undefined ? isNull(symmyJobRoutes.routeCode) : eq(symmyJobRoutes.routeCode, routeCode);

/**
 * The enrollment lock of the request's Tenant, principal and source family, held until the transaction ends. Drizzle has
 * no advisory-lock builder, so the lock is selected from a one-row anchor (the Tax scope lock precedent).
 */
const lockEnrollment = (transaction: Transaction, request: SymmyRouteEnrollmentRequest) =>
  transaction
    .select({ locked: sql`pg_advisory_xact_lock(hashtextextended(${symmyRouteEnrollmentLockKey(request)}, 0))` })
    .from(sql`(values (1)) as symmy_route_enrollment_lock(anchor)`)
    .pipe(Effect.asVoid, Effect.mapError(unavailable('The route enrollment lock could not be taken')));

/** An apply transaction locks the rows it may write; dry-run and verify only share what they read. */
const RowLockSchema = Schema.Literals(['share', 'update']);
type RowLock = typeof RowLockSchema.Type;

/** The route of one kind and code for the request's Tenant, principal and company. */
const readSelector = (transaction: Transaction, request: SymmyRouteEnrollmentRequest, lock: RowLock) =>
  transaction
    .select()
    .from(symmyJobRoutes)
    .where(
      and(
        eq(symmyJobRoutes.tenantId, request.tenantId),
        eq(symmyJobRoutes.principalId, request.principalId),
        request.legalEntityId === undefined
          ? isNull(symmyJobRoutes.legalEntityId)
          : eq(symmyJobRoutes.legalEntityId, request.legalEntityId),
        eq(symmyJobRoutes.routeKey, request.routeKey),
        codeMatch(request.routeCode),
      ),
    )
    .limit(1)
    .for(lock)
    .pipe(
      Effect.map(([row]) => Option.fromUndefinedOr(row)),
      Effect.mapError(unavailable('The enrolled routes could not be read')),
    );

/** The request's route id in the request's Tenant: another Tenant's route is never read, locked or named. */
const readRouteId = (transaction: Transaction, request: SymmyRouteEnrollmentRequest, lock: RowLock) =>
  transaction
    .select()
    .from(symmyJobRoutes)
    .where(and(eq(symmyJobRoutes.tenantId, request.tenantId), eq(symmyJobRoutes.routeId, request.routeId)))
    .limit(1)
    .for(lock)
    .pipe(
      Effect.map(([row]) => Option.fromUndefinedOr(row)),
      Effect.mapError(unavailable('The enrolled route could not be read')),
    );

/** The principal's active routes of this kind and of the kinds sharing its source, held for this transaction. */
const readRelatedRoutes = (transaction: Transaction, request: SymmyRouteEnrollmentRequest) =>
  transaction
    .select()
    .from(symmyJobRoutes)
    .where(
      and(
        eq(symmyJobRoutes.tenantId, request.tenantId),
        eq(symmyJobRoutes.principalId, request.principalId),
        eq(symmyJobRoutes.active, true),
        inArray(symmyJobRoutes.routeKey, [request.routeKey, ...symmySourceFamilyPeers(request.routeKey)]),
      ),
    )
    .for('share')
    .pipe(Effect.mapError(unavailable('The related routes could not be read')));

/** The jobs and synchronous admissions of the route that a replacement would strand (`symmyOutstandingRefusals`). */
const outstandingWork = Effect.fn('SymmyRouteEnrollment.outstandingWork')(function* outstandingWork(
  transaction: Transaction,
  request: SymmyRouteEnrollmentRequest,
  inventory: SymmyRouteInventory,
) {
  const jobs = yield* transaction
    .selectDistinct({ jobId: symmyImportJobs.jobId, state: symmyJobEffects.state })
    .from(symmyImportJobs)
    .innerJoin(
      symmyJobEffects,
      and(eq(symmyJobEffects.tenantId, symmyImportJobs.tenantId), eq(symmyJobEffects.jobId, symmyImportJobs.jobId)),
    )
    .where(
      and(
        eq(symmyImportJobs.tenantId, request.tenantId),
        eq(symmyImportJobs.routeId, request.routeId),
        ne(symmyJobEffects.state, 'settled'),
        notExists(
          transaction
            .select({ jobId: symmyJobRetentionTombstones.jobId })
            .from(symmyJobRetentionTombstones)
            .where(
              and(
                eq(symmyJobRetentionTombstones.tenantId, symmyImportJobs.tenantId),
                eq(symmyJobRetentionTombstones.jobId, symmyImportJobs.jobId),
              ),
            ),
        ),
      ),
    )
    .orderBy(symmyImportJobs.jobId, symmyJobEffects.state)
    .limit(OUTSTANDING_LIMIT)
    .pipe(Effect.mapError(unavailable('The outstanding jobs of the route could not be read')));
  const admissions =
    inventory.admission === 'sync'
      ? yield* transaction
          .select({ admissionId: symmySyncAdmissions.admissionId })
          .from(symmySyncAdmissions)
          .where(
            and(
              eq(symmySyncAdmissions.tenantId, request.tenantId),
              eq(symmySyncAdmissions.routeId, request.routeId),
              isNull(symmySyncAdmissions.retentionReceipt),
            ),
          )
          .orderBy(symmySyncAdmissions.admissionId)
          .limit(OUTSTANDING_LIMIT)
          .pipe(Effect.mapError(unavailable('The outstanding admissions of the route could not be read')))
      : [];
  return symmyOutstandingRefusals({ admissions: admissions.map(({ admissionId }) => admissionId), jobs });
});

type AppliedWrite = Extract<SymmyRouteEnrollmentWrite, { readonly kind: 'deactivate' | 'insert' | 'replace' }>;

const writeRoute = Effect.fn('SymmyRouteEnrollment.writeRoute')(function* writeRoute(
  transaction: Transaction,
  request: SymmyRouteEnrollmentRequest,
  write: AppliedWrite,
) {
  const route = and(eq(symmyJobRoutes.tenantId, request.tenantId), eq(symmyJobRoutes.routeId, request.routeId));
  if (write.kind === 'deactivate') {
    return yield* transaction
      .update(symmyJobRoutes)
      .set({ active: false })
      .where(route)
      .pipe(Effect.mapError(unavailable('The route could not be deactivated')));
  }
  const configuration = yield* encodeConfiguration(request.configuration).pipe(
    Effect.mapError(unavailable('The route configuration could not be encoded')),
  );
  const policy =
    request.lifecyclePolicy === undefined
      ? Option.none<string>()
      : Option.some(
          yield* encodePolicy(request.lifecyclePolicy).pipe(
            Effect.mapError(unavailable('The lifecycle policy could not be encoded')),
          ),
        );
  const row = {
    ...symmyPlannedRouteRow(request),
    fixturePlan: sql`${configuration}::jsonb`,
    lifecyclePolicy: Option.match(policy, { onNone: () => null, onSome: (encoded) => sql`${encoded}::jsonb` }),
  };
  const written =
    write.kind === 'replace'
      ? transaction.update(symmyJobRoutes).set(row).where(route)
      : transaction.insert(symmyJobRoutes).values(row);
  return yield* written.pipe(Effect.mapError(unavailable('The route could not be written')));
});

/** The revision a change leaves the route at and the one it changed from: a deactivation keeps the revision. */
const recordedRevisions = (request: SymmyRouteEnrollmentRequest, write: AppliedWrite) => {
  if (write.kind === 'insert') {
    return { change: 'enroll', previousRevision: null, routeRevision: request.routeRevision } as const;
  }
  return write.kind === 'replace'
    ? ({ change: 'replace', previousRevision: write.previousRevision, routeRevision: request.routeRevision } as const)
    : ({ change: 'deactivate', previousRevision: write.revision, routeRevision: write.revision } as const);
};

/** Appends who applied the change and why, with the revision it changed from and to, in the change's transaction. */
const recordChange = (
  transaction: Transaction,
  request: SymmyRouteEnrollmentRequest,
  write: AppliedWrite,
  attribution: SymmyRouteEnrollmentAttribution,
) =>
  transaction
    .insert(symmyRouteEnrollmentRecords)
    .values({
      ...recordedRevisions(request, write),
      legalEntityId: request.legalEntityId ?? null,
      operatorRef: attribution.operatorRef,
      reason: attribution.reason,
      routeId: request.routeId,
      routeKey: request.routeKey,
      tenantId: request.tenantId,
    })
    .pipe(Effect.mapError(unavailable('The route change could not be recorded')));

/** The executors and source peers a receipt names, from the checks the change ran. */
interface RouteChecked {
  readonly executors: readonly { readonly principalId: string; readonly workloadKey: string }[];
  readonly peers: ReturnType<typeof symmyRelatedRouteRefusals>['peers'];
}

/** The bindings, Core facts and sibling routes a route depends on: none of them decides a deactivation. */
const routeChecks = Effect.fn('SymmyRouteEnrollment.routeChecks')(function* routeChecks(
  transaction: Transaction,
  input: {
    readonly inventory: SymmyRouteInventory;
    readonly plan: Pick<SymmyRouteBindingPlan, 'bindings' | 'moduleKeys'>;
    readonly request: SymmyRouteEnrollmentRequest;
  },
) {
  const { inventory, plan, request } = input;
  const core = yield* coreRefusals(transaction, request, plan.moduleKeys);
  const holders = new Map(
    yield* Effect.forEach(
      symmyBindingWorkloads(plan.bindings),
      (workloadKey) =>
        readActiveWorkloadBindingHolders(transaction, request.tenantId, workloadKey).pipe(
          Effect.map((found) => [workloadKey, found] as const),
          Effect.mapError(unavailable('The workload bindings could not be read')),
        ),
      { concurrency: 1 },
    ),
  );
  const bindings = checkSymmyRouteBindings({ bindings: plan.bindings, holders, principalId: request.principalId });
  const related = symmyRelatedRouteRefusals(request, inventory, yield* readRelatedRoutes(transaction, request));
  return {
    executors: [...bindings.executors].map(([workloadKey, principalId]) => ({ principalId, workloadKey })),
    peers: related.peers,
    refusals: [...core, ...bindings.refusals, ...related.refusals],
  };
});

/** What one run may do: an apply writes and records who applied it and why; dry-run and verify write nothing. */
export type SymmyRouteEnrollmentRun =
  | { readonly attribution: SymmyRouteEnrollmentAttribution; readonly mode: 'apply' }
  | { readonly mode: 'dry-run' }
  | { readonly mode: 'verify' };

const writtenOutcome = { deactivate: 'deactivated', insert: 'enrolled', replace: 'replaced' } as const;
const plannedOutcome = { deactivate: 'would_deactivate', insert: 'would_enroll', replace: 'would_replace' } as const;

/**
 * The transaction of one change, for a request already checked against its inventory, the active composition and the
 * retention configuration (a deactivation needs none of them): under the enrollment lock in apply, the route rows,
 * then the decided change with the facts it depends on, the write, its read-back and its record.
 */
export const enrollSymmyRoute = Effect.fn('SymmyRouteEnrollment.enroll')(function* enrollSymmyRoute(input: {
  readonly change: SymmyRouteChange;
  readonly inventory: SymmyRouteInventory;
  readonly plan: Pick<SymmyRouteBindingPlan, 'bindings' | 'moduleKeys'>;
  readonly request: SymmyRouteEnrollmentRequest;
  readonly run: SymmyRouteEnrollmentRun;
}) {
  const { change, inventory, plan, request, run } = input;
  const { executor } = yield* CoreDatabase;
  return yield* executor
    .transaction(
      Effect.fn('SymmyRouteEnrollment.transaction')(function* enrollment(transaction) {
        if (run.mode === 'apply') {
          yield* lockEnrollment(transaction, request);
        }
        const rowLock: RowLock = run.mode === 'apply' ? 'update' : 'share';
        const [bySelector, byRouteId] = yield* Effect.all(
          [readSelector(transaction, request, rowLock), readRouteId(transaction, request, rowLock)],
          { concurrency: 1 },
        );
        const receipt = (outcome: SymmyRouteEnrollmentReceipt['outcome'], checked: RouteChecked) =>
          decodeReceipt({
            executors: checked.executors,
            mode: run.mode,
            outcome,
            requiredBindings: plan.bindings,
            routeId: request.routeId,
            routeKey: request.routeKey,
            runtimePrerequisites: symmyRuntimePrerequisites(request),
            sourcePeers: checked.peers,
          }).pipe(Effect.mapError(unavailable('The enrollment receipt could not be built')));
        if (run.mode === 'verify') {
          const checked = yield* routeChecks(transaction, { inventory, plan, request });
          yield* refused(checked.refusals);
          const stored = Option.getOrUndefined(bySelector);
          if (stored === undefined || stored.routeId !== request.routeId) {
            return yield* refuse(refusalOf('route_not_enrolled', `No route ${request.routeId} holds this selector`));
          }
          const changed = symmyRouteDifferences(request, stored);
          yield* refused(
            changed.length === 0
              ? []
              : [refusalOf('route_drift', `The enrolled route differs in ${changed.join(', ')}`)],
          );
          return yield* receipt('verified', checked);
        }
        const decision = decideSymmyRouteWrite(request, { byRouteId, bySelector }, change);
        if (isRefused(decision)) {
          return yield* decision;
        }
        // A deactivation depends on no binding, Core fact or sibling route: a route stops even once they are gone.
        const checked: RouteChecked =
          change.kind === 'deactivate'
            ? { executors: [], peers: [] }
            : yield* routeChecks(transaction, { inventory, plan, request }).pipe(
                Effect.tap(({ refusals }) => refused(refusals)),
              );
        if (decision.kind === 'unchanged') {
          return yield* receipt('unchanged', checked);
        }
        if (decision.kind !== 'insert') {
          yield* refused(yield* outstandingWork(transaction, request, inventory));
        }
        if (run.mode === 'dry-run') {
          return yield* receipt(plannedOutcome[decision.kind], checked);
        }
        yield* writeRoute(transaction, request, decision);
        const stored = yield* readRouteId(transaction, request, 'update');
        const readBack =
          decision.kind === 'deactivate'
            ? Option.exists(stored, (row) => !row.active && row.routeRevision === decision.revision)
            : Option.exists(stored, (row) => symmyRouteDifferences(request, row).length === 0);
        if (!readBack) {
          return yield* unavailable('The enrolled route does not read back as written')();
        }
        yield* recordChange(transaction, request, decision, run.attribution);
        return yield* receipt(writtenOutcome[decision.kind], checked);
      }),
    )
    .pipe(
      Effect.catchIf(
        (failure) => !(isRefused(failure) || isUnavailable(failure)),
        (cause) => Effect.fail(unavailable('The enrollment transaction did not commit')(cause)),
      ),
    );
});

/**
 * Runs one change of one route. dry-run and verify write nothing; apply inserts the route, replaces or deactivates it
 * at the revision the operator names as current, or leaves an identical route unchanged, reads it back and records who
 * applied the change and why. Any refusal or failure rolls back.
 */
export const runSymmyRouteEnrollment = Effect.fn('SymmyRouteEnrollment.run')(function* runSymmyRouteEnrollment(input: {
  readonly change: SymmyRouteChange;
  readonly request: unknown;
  readonly run: { readonly attribution: unknown; readonly mode: 'apply' } | { readonly mode: 'dry-run' | 'verify' };
}) {
  const request = yield* decodeRequest(input.request).pipe(
    Effect.catchTag('SchemaError', ({ message }) => refuse(refusalOf('invalid_request', message))),
  );
  const run: SymmyRouteEnrollmentRun =
    input.run.mode === 'apply'
      ? {
          attribution: yield* decodeAttribution(input.run.attribution).pipe(
            Effect.catchTag('SchemaError', ({ message }) => refuse(refusalOf('invalid_request', message))),
          ),
          mode: 'apply',
        }
      : { mode: input.run.mode };
  const found = symmyRouteInventoryOf(request.routeKey);
  if (!Option.isOption(found)) {
    return yield* refuse(found);
  }
  if (Option.isNone(found)) {
    return yield* refuse(
      refusalOf('route_not_inventoried', `${request.routeKey} is an operator fixture route, not a Symmy route`),
    );
  }
  const inventory = found.value;
  if (input.change.kind === 'deactivate') {
    return yield* enrollSymmyRoute({
      change: input.change,
      inventory,
      plan: { bindings: [], moduleKeys: [] },
      request,
      run,
    });
  }
  yield* refused(symmyRouteRequestRefusals(request, inventory));
  const authority = yield* ActiveApplicationCompositionService;
  const { catalog } = yield* loadCheckedActiveApplicationComposition(authority).pipe(
    Effect.mapError(unavailable('The active Application Composition could not be read')),
  );
  const plan = deriveSymmyRouteBindings({
    companyScoped: request.legalEntityId !== undefined,
    contracts: catalog.contracts,
    enrolled: symmyEnrolledInventory(inventory, request.configuration),
    inventory,
  });
  yield* refused(plan.refusals);
  const retention = yield* Config.option(
    Config.schema(
      Schema.fromJsonString(Schema.Array(SymmyJobRetentionPolicySchema)),
      'ONTOS_SYMMY_JOB_RETENTION_POLICIES',
    ),
  ).pipe(Effect.mapError(unavailable('ONTOS_SYMMY_JOB_RETENTION_POLICIES is invalid')));
  yield* refused(
    symmyRetentionRefusals(
      request,
      Option.getOrElse(retention, () => []),
    ),
  );
  return yield* enrollSymmyRoute({ change: input.change, inventory, plan, request, run });
});

/**
 * One operator enrollment of one Symmy route, over the administrative Core database.
 *
 * The runtime role only reads `symmy_integration.job_routes`; the route is written by the migration and operator
 * login, whose writes the route trigger publishes as the route's execution gate and whose every change gives the route
 * a new change token. Every check reads published or Core facts through their owners' exported readers. An apply
 * transaction first takes the enrollment lock of the route's Tenant, principal and source family
 * (`symmyRouteEnrollmentLockKey`), so its checks across companies and sibling routes see every enrollment committed
 * before it; it then reads the route rows and outstanding work under the route's row lock, writes, reads the write
 * back and appends who changed the route and why (`symmy_integration.route_enrollment_records`). dry-run and verify
 * take no lock and only share the rows they read. No owner Action or read is called, so no lock is ever held across
 * one.
 *
 * Lock order of an apply: the enrollment lock of its key; then at most one route row for update, the row holding the
 * request's selector or, only when the selector holds none, the row holding its route id (a selector held by another
 * route id is refused without locking a second row); then the active routes of its key for share. Applies of one key
 * run one after another, and an apply locks a row of another key only through its route id, while it holds no row
 * lock, and is refused right after, so no two applies ever wait on each other.
 *
 * A replacement keeps the route id and rotates the execution epoch (the trigger publishes it as a replaced
 * enrollment). The row lock quiesces admissions for the length of the transaction: an admission locks the same row
 * with `lock_symmy_enrollment_snapshot`, waits for this transaction, and then no longer matches the snapshot it read. A
 * route with outstanding work is never replaced, because the rotated epoch would close the fence of every job it
 * admitted; the refusal lists that work and how it is resolved. A deactivation reads only the reference of the route
 * it stops and stops it whatever it enrolls or has admitted: it records what the locked route row holds, and its
 * receipt lists the work it strands and the Action that resolves it.
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
import { and, eq, inArray, isNull, ne, notExists, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Effect, Option, Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyJobLifecyclePolicyRefSchema } from '../../shared/domain/symmy-job-notification.ts';
import { SymmyJobRetentionPolicySchema } from '../../shared/domain/symmy-job-retention.ts';
import {
  symmyImportJobs,
  symmyIntegrationRelations,
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
  SYMMY_RETENTION_ACTION,
  SymmyOutstandingWorkSchema,
  SymmyRouteEnrollmentRequestSchema,
  SymmyRouteReferenceSchema,
  SymmyRuntimePrerequisiteSchema,
  SymmyStrandedWorkSchema,
  decideSymmyRouteDeactivation,
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
  SymmyOutstandingWork,
  SymmyRouteChange,
  SymmyRouteEnrollmentRequest,
  SymmyRouteEnrollmentWrite,
  SymmyRouteInventory,
  SymmyRouteReference,
} from './symmy-route-enrollment.ts';
import type { SymmyRouteBindingPlan } from './symmy-route-bindings.ts';

/** The outstanding jobs and admissions a refusal or receipt lists, of each. */
const OUTSTANDING_LIMIT = 50;

/**
 * The administrative database the command runs on (the `PgClient` its caller connects with DATABASE_ADMIN_URL), over
 * this vertical's schema; Core's facts are read through their owners' exported readers, which only select.
 */
const openDatabase = makeWithDefaults({ relations: symmyIntegrationRelations });
type Database = Effect.Success<typeof openDatabase>;
type RouteRow = typeof symmyJobRoutes.$inferSelect;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const SymmyRouteEnrollmentModeSchema = Schema.Literals(['dry-run', 'apply', 'verify']);

export const SymmyRouteEnrollmentReceiptSchema = Schema.Struct({
  /**
   * The change token of the stored route after this run, which the next replacement or deactivation names; a dry-run
   * reports the stored one, and none when no route is stored yet.
   */
  changeToken: Schema.optionalKey(Schema.Int),
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
  /** The Shell's and Symmy's own configuration the route needs, which the command cannot read; none to stop it. */
  runtimePrerequisites: Schema.Array(SymmyRuntimePrerequisiteSchema),
  /** The enrolled routes of the same source whose logical source identity this route matches. */
  sourcePeers: Schema.Array(
    Schema.Struct({
      routeId: SymmyRouteEnrollmentRequestSchema.fields.routeId,
      routeKey: SymmyRouteEnrollmentRequestSchema.fields.routeKey,
    }),
  ),
  /** What a deactivation strands of the route's outstanding work, and the Action that resolves it. */
  strandedWork: Schema.optionalKey(SymmyStrandedWorkSchema),
});
export type SymmyRouteEnrollmentReceipt = typeof SymmyRouteEnrollmentReceiptSchema.Type;

/**
 * Who applies a change and why, as the operator states it: recorded unauthenticated with every change it applies,
 * beside the database login that applied it.
 */
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
const decodeReference = Schema.decodeUnknownEffect(SymmyRouteReferenceSchema, { onExcessProperty: 'error' });
const decodeAttribution = Schema.decodeUnknownEffect(SymmyRouteEnrollmentAttributionSchema, {
  onExcessProperty: 'error',
});
const decodeReceipt = Schema.decodeUnknownEffect(SymmyRouteEnrollmentReceiptSchema);
const decodeOutstandingWork = Schema.decodeUnknownEffect(SymmyOutstandingWorkSchema);
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
 * The enrollment lock of the route's Tenant, principal and source family, held until the transaction ends. Drizzle has
 * no advisory-lock builder, so the lock is selected from a one-row anchor (the Tax scope lock precedent).
 */
const lockEnrollment = (transaction: Transaction, reference: SymmyRouteReference) =>
  transaction
    .select({ locked: sql`pg_advisory_xact_lock(hashtextextended(${symmyRouteEnrollmentLockKey(reference)}, 0))` })
    .from(sql`(values (1)) as symmy_route_enrollment_lock(anchor)`)
    .pipe(Effect.asVoid, Effect.mapError(unavailable('The route enrollment lock could not be taken')));

/** An apply transaction locks the rows it may write; dry-run and verify only share what they read. */
const RowLockSchema = Schema.Literals(['share', 'update']);
type RowLock = typeof RowLockSchema.Type;

/** The route of one kind and code for the reference's Tenant, principal and company. */
const readSelector = (transaction: Transaction, reference: SymmyRouteReference, lock: RowLock) =>
  transaction
    .select()
    .from(symmyJobRoutes)
    .where(
      and(
        eq(symmyJobRoutes.tenantId, reference.tenantId),
        eq(symmyJobRoutes.principalId, reference.principalId),
        reference.legalEntityId === undefined
          ? isNull(symmyJobRoutes.legalEntityId)
          : eq(symmyJobRoutes.legalEntityId, reference.legalEntityId),
        eq(symmyJobRoutes.routeKey, reference.routeKey),
        codeMatch(reference.routeCode),
      ),
    )
    .limit(1)
    .for(lock)
    .pipe(
      Effect.map(([row]) => Option.fromUndefinedOr(row)),
      Effect.mapError(unavailable('The enrolled routes could not be read')),
    );

/** The id of one route, in the Tenant the route is enrolled for. */
interface TenantRoute {
  readonly routeId: string;
  readonly tenantId: string;
}
const routeIs = (route: TenantRoute) =>
  and(eq(symmyJobRoutes.tenantId, route.tenantId), eq(symmyJobRoutes.routeId, route.routeId));

/** The route id in its own Tenant: another Tenant's route is never read, locked or named. */
const readRouteId = (transaction: Transaction, route: TenantRoute, lock: RowLock) =>
  transaction
    .select()
    .from(symmyJobRoutes)
    .where(routeIs(route))
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

/**
 * The jobs and synchronous admissions of the route that a replacement refuses on and a deactivation strands. Both are
 * read whatever the route's kind, so a route of a kind the command cannot enroll still names what it admitted.
 */
const outstandingWork = Effect.fn('SymmyRouteEnrollment.outstandingWork')(function* outstandingWork(
  transaction: Transaction,
  route: TenantRoute,
) {
  const jobsRead = transaction
    .selectDistinct({ jobId: symmyImportJobs.jobId, state: symmyJobEffects.state })
    .from(symmyImportJobs)
    .innerJoin(
      symmyJobEffects,
      and(eq(symmyJobEffects.tenantId, symmyImportJobs.tenantId), eq(symmyJobEffects.jobId, symmyImportJobs.jobId)),
    )
    .where(
      and(
        eq(symmyImportJobs.tenantId, route.tenantId),
        eq(symmyImportJobs.routeId, route.routeId),
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
    .limit(OUTSTANDING_LIMIT + 1)
    .pipe(Effect.mapError(unavailable('The outstanding jobs of the route could not be read')));
  const admissionsRead = transaction
    .select({ admissionId: symmySyncAdmissions.admissionId })
    .from(symmySyncAdmissions)
    .where(
      and(
        eq(symmySyncAdmissions.tenantId, route.tenantId),
        eq(symmySyncAdmissions.routeId, route.routeId),
        isNull(symmySyncAdmissions.retentionReceipt),
      ),
    )
    .orderBy(symmySyncAdmissions.admissionId)
    .limit(OUTSTANDING_LIMIT + 1)
    .pipe(Effect.mapError(unavailable('The outstanding admissions of the route could not be read')));
  // Both reads use the one connection of the transaction, so they run one after the other.
  const [jobs, admissions] = yield* Effect.all([jobsRead, admissionsRead], { concurrency: 1 });
  return yield* decodeOutstandingWork({
    admissions: admissions.slice(0, OUTSTANDING_LIMIT).map(({ admissionId }) => admissionId),
    jobs: jobs.slice(0, OUTSTANDING_LIMIT),
    listedAll: jobs.length <= OUTSTANDING_LIMIT && admissions.length <= OUTSTANDING_LIMIT,
  }).pipe(Effect.mapError(unavailable('The outstanding work of the route could not be read')));
});

type AppliedWrite = Extract<SymmyRouteEnrollmentWrite, { readonly kind: 'insert' | 'replace' }>;

const writeRoute = Effect.fn('SymmyRouteEnrollment.writeRoute')(function* writeRoute(
  transaction: Transaction,
  request: SymmyRouteEnrollmentRequest,
  write: AppliedWrite,
) {
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
      ? transaction.update(symmyJobRoutes).set(row).where(routeIs(request))
      : transaction.insert(symmyJobRoutes).values(row);
  return yield* written.pipe(Effect.mapError(unavailable('The route could not be written')));
});

/** What a record states of one change: the route, the change, and the revision and change token before and after it. */
type RecordedChange = Omit<
  typeof symmyRouteEnrollmentRecords.$inferInsert,
  'databaseSessionUser' | 'reason' | 'recordId' | 'recordedAt' | 'statedOperatorRef'
>;

/** An enrollment or replacement, as requested, from the revision and token it changed. */
const recordedWrite = (
  request: SymmyRouteEnrollmentRequest,
  write: AppliedWrite,
  changeToken: number,
): RecordedChange => ({
  change: write.kind === 'insert' ? 'enroll' : 'replace',
  changeToken,
  legalEntityId: request.legalEntityId ?? null,
  previousChangeToken: write.kind === 'insert' ? null : write.previous.changeToken,
  previousRevision: write.kind === 'insert' ? null : write.previous.routeRevision,
  routeId: request.routeId,
  routeKey: request.routeKey,
  routeRevision: request.routeRevision,
  tenantId: request.tenantId,
});

/**
 * Appends who applied the change and why, with the revision and change token the route had before and after it, in
 * the change's transaction: a record that cannot be written rolls the change back.
 */
const recordChange = (
  transaction: Transaction,
  attribution: SymmyRouteEnrollmentAttribution,
  recorded: RecordedChange,
) =>
  transaction
    .insert(symmyRouteEnrollmentRecords)
    .values({ ...recorded, reason: attribution.reason, statedOperatorRef: attribution.operatorRef })
    .pipe(Effect.mapError(unavailable('The route change could not be recorded')));

/** The executors and source peers a receipt names, and the refusals of the checks the change ran. */
interface RouteChecked {
  readonly executors: readonly { readonly principalId: string; readonly workloadKey: string }[];
  readonly peers: ReturnType<typeof symmyRelatedRouteRefusals>['peers'];
  readonly refusals: readonly SymmyRouteEnrollmentRefusal[];
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
  // A workload some company-scoped call runs under is read with the route's company, so Core reports whether each
  // holder's binding is registered for it; a tenant-only call needs no registration.
  const companyScoped = new Set(
    plan.bindings.flatMap(({ companyScoped: scoped, workloads }) => (scoped ? workloads : [])),
  );
  const holders = new Map(
    yield* Effect.forEach(
      symmyBindingWorkloads(plan.bindings),
      (workloadKey) =>
        readActiveWorkloadBindingHolders(
          transaction,
          request.tenantId,
          workloadKey,
          companyScoped.has(workloadKey) ? request.legalEntityId : undefined,
        ).pipe(
          Effect.map((found) => [workloadKey, found] as const),
          Effect.mapError(unavailable('The workload bindings could not be read')),
        ),
      { concurrency: 1 },
    ),
  );
  const bindings = checkSymmyRouteBindings({
    bindings: plan.bindings,
    holders,
    legalEntityId: request.legalEntityId,
    principalId: request.principalId,
  });
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

/** What every change but a deactivation is checked against: the route's inventory and the bindings it needs. */
interface SymmyRouteCheckBasis {
  readonly inventory: SymmyRouteInventory;
  readonly plan: Pick<SymmyRouteBindingPlan, 'bindings' | 'moduleKeys'>;
}

const writtenOutcome = { insert: 'enrolled', replace: 'replaced' } as const;
const plannedOutcome = { insert: 'would_enroll', replace: 'would_replace' } as const;

/**
 * Enrolls, replaces or verifies one route already checked against its inventory, the active composition and the
 * retention configuration, against the bindings, Core facts and sibling routes it depends on. Under the enrollment
 * lock in apply: the route rows, the decided change with those facts, the write, its read-back and its record.
 */
export const enrollSymmyRoute = Effect.fn('SymmyRouteEnrollment.enroll')(function* enrollSymmyRoute(
  input: SymmyRouteCheckBasis & {
    readonly change: Exclude<SymmyRouteChange, { readonly kind: 'deactivate' }>;
    readonly request: SymmyRouteEnrollmentRequest;
    readonly run: SymmyRouteEnrollmentRun;
  },
) {
  const { change, inventory, plan, request, run } = input;
  const database = yield* openDatabase;
  return yield* database
    .transaction(
      Effect.fn('SymmyRouteEnrollment.transaction')(function* enrollment(transaction) {
        if (run.mode === 'apply') {
          yield* lockEnrollment(transaction, request);
        }
        const rowLock: RowLock = run.mode === 'apply' ? 'update' : 'share';
        const bySelector = yield* readSelector(transaction, request, rowLock);
        // The selector's row is the route id's row, or another route the decision refuses: no second row is locked.
        const byRouteId = Option.isNone(bySelector)
          ? yield* readRouteId(transaction, request, rowLock)
          : Option.none<RouteRow>();
        const checks = routeChecks(transaction, { inventory, plan, request });
        const receipt = (
          outcome: SymmyRouteEnrollmentReceipt['outcome'],
          checked: RouteChecked,
          changeToken: Option.Option<number>,
        ) => {
          const fields = {
            executors: checked.executors,
            mode: run.mode,
            outcome,
            requiredBindings: plan.bindings,
            routeId: request.routeId,
            routeKey: request.routeKey,
            runtimePrerequisites: symmyRuntimePrerequisites(request),
            sourcePeers: checked.peers,
          };
          if (Option.isSome(changeToken)) {
            Object.assign(fields, { changeToken: changeToken.value });
          }
          return decodeReceipt(fields).pipe(Effect.mapError(unavailable('The enrollment receipt could not be built')));
        };
        if (run.mode === 'verify') {
          const checked = yield* checks;
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
          return yield* receipt('verified', checked, Option.some(stored.changeToken));
        }
        const decision = decideSymmyRouteWrite(request, { byRouteId, bySelector }, change);
        if (isRefused(decision)) {
          return yield* decision;
        }
        const storedToken = bySelector.pipe(Option.map(({ changeToken }) => changeToken));
        const checked = yield* checks.pipe(Effect.tap(({ refusals }) => refused(refusals)));
        if (decision.kind === 'unchanged') {
          return yield* receipt('unchanged', checked, storedToken);
        }
        if (decision.kind === 'replace') {
          yield* refused(symmyOutstandingRefusals(yield* outstandingWork(transaction, request)));
        }
        if (run.mode === 'dry-run') {
          return yield* receipt(plannedOutcome[decision.kind], checked, storedToken);
        }
        yield* writeRoute(transaction, request, decision);
        const stored = yield* readRouteId(transaction, request, 'update');
        // The trigger gives every written row a token the sequence never handed out before, so it is never the old one.
        const readBack = stored.pipe(
          Option.filter(
            (row) =>
              symmyRouteDifferences(request, row).length === 0 &&
              (decision.kind === 'insert' || row.changeToken !== decision.previous.changeToken),
          ),
        );
        if (Option.isNone(readBack)) {
          return yield* unavailable('The enrolled route does not read back as written')();
        }
        const { changeToken } = readBack.value;
        yield* recordChange(transaction, run.attribution, recordedWrite(request, decision, changeToken));
        return yield* receipt(writtenOutcome[decision.kind], checked, Option.some(changeToken));
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
 * Deactivates the stored route the reference names at the change token the operator read, whatever its kind and
 * whatever it enrolls or admitted. It reads that route and its outstanding work and nothing else (no inventory,
 * binding, Core fact or sibling route, so a route stops even once they are gone), records what the locked route row
 * holds, and its receipt lists the work it strands.
 */
export const deactivateSymmyRoute = Effect.fn('SymmyRouteEnrollment.deactivate')(function* deactivateSymmyRoute(input: {
  readonly change: Extract<SymmyRouteChange, { readonly kind: 'deactivate' }>;
  readonly reference: SymmyRouteReference;
  readonly run: Exclude<SymmyRouteEnrollmentRun, { readonly mode: 'verify' }>;
}) {
  const { change, reference, run } = input;
  const database = yield* openDatabase;
  return yield* database
    .transaction(
      Effect.fn('SymmyRouteEnrollment.deactivation')(function* deactivation(transaction) {
        if (run.mode === 'apply') {
          yield* lockEnrollment(transaction, reference);
        }
        const stored = yield* readSelector(transaction, reference, run.mode === 'apply' ? 'update' : 'share');
        const decision = decideSymmyRouteDeactivation(reference, stored, change.expectedChangeToken);
        if (isRefused(decision)) {
          return yield* decision;
        }
        const { route } = decision;
        const receipt = (
          outcome: SymmyRouteEnrollmentReceipt['outcome'],
          changeToken: number,
          strandedWork: Option.Option<SymmyOutstandingWork>,
        ) => {
          const fields = {
            changeToken,
            executors: [],
            mode: run.mode,
            outcome,
            requiredBindings: [],
            routeId: route.routeId,
            routeKey: route.routeKey,
            runtimePrerequisites: [],
            sourcePeers: [],
          };
          if (Option.isSome(strandedWork)) {
            Object.assign(fields, { strandedWork: { ...strandedWork.value, resolvedBy: SYMMY_RETENTION_ACTION } });
          }
          return decodeReceipt(fields).pipe(Effect.mapError(unavailable('The enrollment receipt could not be built')));
        };
        if (decision.kind === 'unchanged') {
          return yield* receipt('unchanged', route.changeToken, Option.none());
        }
        const stranded = Option.some(yield* outstandingWork(transaction, route));
        if (run.mode === 'dry-run') {
          return yield* receipt('would_deactivate', route.changeToken, stranded);
        }
        yield* transaction
          .update(symmyJobRoutes)
          .set({ active: false })
          .where(routeIs(route))
          .pipe(Effect.mapError(unavailable('The route could not be deactivated')));
        // The trigger gives the stopped row a token the sequence never handed out before, so it is never the old one.
        const readBack = (yield* readRouteId(transaction, route, 'update')).pipe(
          Option.filter(
            (row) => !row.active && row.routeRevision === route.routeRevision && row.changeToken !== route.changeToken,
          ),
        );
        if (Option.isNone(readBack)) {
          return yield* unavailable('The enrolled route does not read back as written')();
        }
        const { changeToken } = readBack.value;
        yield* recordChange(transaction, run.attribution, {
          change: 'deactivate',
          changeToken,
          legalEntityId: route.legalEntityId,
          previousChangeToken: route.changeToken,
          previousRevision: route.routeRevision,
          routeId: route.routeId,
          routeKey: route.routeKey,
          routeRevision: route.routeRevision,
          tenantId: route.tenantId,
        });
        return yield* receipt('deactivated', changeToken, stranded);
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
 * at the change token the operator names as current, or leaves an identical route unchanged, reads it back and records
 * who applied the change and why. A deactivation decodes only the reference of the route it stops and refuses a request
 * carrying anything else. Any refusal or failure rolls back.
 */
export const runSymmyRouteEnrollment = Effect.fn('SymmyRouteEnrollment.run')(function* runSymmyRouteEnrollment(input: {
  readonly change: SymmyRouteChange;
  readonly request: unknown;
  readonly run: { readonly attribution: unknown; readonly mode: 'apply' } | { readonly mode: 'dry-run' | 'verify' };
}) {
  const run: SymmyRouteEnrollmentRun =
    input.run.mode === 'apply'
      ? {
          attribution: yield* decodeAttribution(input.run.attribution).pipe(
            Effect.catchTag('SchemaError', ({ message }) => refuse(refusalOf('invalid_request', message))),
          ),
          mode: 'apply',
        }
      : { mode: input.run.mode };
  const { change } = input;
  if (change.kind === 'deactivate') {
    if (run.mode === 'verify') {
      return yield* refuse(refusalOf('invalid_request', 'verify checks an enrolled route and deactivates nothing'));
    }
    const reference = yield* decodeReference(input.request).pipe(
      Effect.catchTag('SchemaError', ({ message }) => refuse(refusalOf('invalid_request', message))),
    );
    return yield* deactivateSymmyRoute({ change, reference, run });
  }
  const request = yield* decodeRequest(input.request).pipe(
    Effect.catchTag('SchemaError', ({ message }) => refuse(refusalOf('invalid_request', message))),
  );
  const found = symmyRouteInventoryOf(request.routeKey);
  if (Option.isNone(found)) {
    return yield* refuse(
      refusalOf('route_not_inventoried', `${request.routeKey} is an operator fixture route, not a Symmy route`),
    );
  }
  const inventory = found.value;
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
  return yield* enrollSymmyRoute({ change, inventory, plan, request, run });
});

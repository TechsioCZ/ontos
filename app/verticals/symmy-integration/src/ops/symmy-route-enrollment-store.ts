/**
 * One change of one Symmy route, in the transaction of `integration.symmy.manage-symmy-routes`.
 *
 * The Action runs under the runtime role in the administrator's Tenant scope, so it reads and writes only that
 * Tenant's routes (RLS); the route triggers give every written row a new change token and publish the route's execution
 * gate, whoever writes it. Every check reads published or Core facts through their owners' exported readers. A change
 * first takes the enrollment lock of the route's Tenant, principal and source family (`symmyRouteEnrollmentLockKey`),
 * so its checks across companies and sibling routes see every enrollment committed before it; it then reads the route
 * rows and outstanding work under the route's row lock, writes, reads the write back and appends who changed the route
 * and why (`symmy_integration.route_enrollment_records`). No owner Action or read is called, so no lock is ever held
 * across one.
 *
 * Lock order: the enrollment lock of its key; then at most one route row for update, the row holding the request's
 * selector or, only when the selector holds none, the row holding its route id (a selector held by another route id is
 * refused without locking a second row); then the active routes of its key for share.
 *
 * A replacement keeps the route id and rotates the execution epoch (the trigger publishes it as a replaced
 * enrollment). The row lock quiesces admissions for the length of the transaction: an admission locks the same row
 * with `lock_symmy_enrollment_snapshot`, waits for this transaction, and then no longer matches the snapshot it read. A
 * route with outstanding work is never replaced, because the rotated epoch would close the fence of every job it
 * admitted; the refusal lists that work and how it is resolved. A deactivation reads only the reference of the route
 * it stops and stops it whatever it enrolls or has admitted: its receipt lists the work it strands and the Action that
 * resolves it.
 */
import {
  makeLegalEntityContext,
  makeTenantModuleStateService,
  principalEligibilityForTransaction,
} from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { readActiveWorkloadBindingHolders } from '@app/core-runtime/access/enforcement';
import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import type { PriceSourceSystem } from '@app/pricing-contracts/domain/price-source-provenance';
import { and, eq, inArray, isNull, ne, notExists, sql } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import type { Crypto } from 'effect';

import { SymmyExecutorWorkloadChangeSchema } from '../../shared/actions/manage-symmy-routes.ts';
import type { SymmyExecutorWorkloadChange } from '../../shared/actions/manage-symmy-routes.ts';
import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyJobLifecyclePolicyRefSchema } from '../../shared/domain/symmy-job-notification.ts';
import type { SymmyJobRetentionPolicy } from '../../shared/domain/symmy-job-retention.ts';
import {
  symmyImportJobs,
  symmyJobEffects,
  symmyJobRetentionTombstones,
  symmyJobRoutes,
  symmyRouteEnrollmentRecords,
  symmySyncAdmissions,
} from '../db/schema.ts';
import { writeSymmyPriceReadSource, writeSymmyRetentionPolicy } from '../persistence/symmy-route-settings-store.ts';
import {
  SymmyRequiredBindingSchema,
  checkSymmyRouteBindings,
  deriveSymmyRouteBindings,
  symmyBindingWorkloads,
} from './symmy-route-bindings.ts';
import type { SymmyRequiredBinding, SymmyRouteBindingPlan } from './symmy-route-bindings.ts';
import { SymmyRouteEnrollmentRefused } from './symmy-route-enrollment-refused.ts';
import type { SymmyRouteEnrollmentRefusal } from './symmy-route-enrollment-refused.ts';
import { SymmyRouteEnrollmentUnavailable } from './symmy-route-enrollment-unavailable.ts';
import {
  SYMMY_RETENTION_ACTION,
  SymmyOutstandingWorkSchema,
  SymmyRouteEnrollmentRequestSchema,
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

/** The outstanding jobs and admissions a refusal or receipt lists, of each. */
const OUTSTANDING_LIMIT = 50;

/** The statements a change needs of the Action's scoped owner transaction. */
export type SymmyRouteEnrollmentTransaction = Pick<ScopedTransactionExecutor, 'insert' | 'select' | 'update'>;
type RouteRow = typeof symmyJobRoutes.$inferSelect;

export const SymmyRouteEnrollmentReceiptSchema = Schema.Struct({
  /** The change token of the stored route after this change, which the next replacement or deactivation names. */
  changeToken: Schema.Int,
  /** The one active system principal that runs each executor workload of the route. */
  executors: Schema.Array(
    Schema.Struct({
      principalId: PrincipalIdSchema,
      workloadKey: Schema.String.pipe(Schema.brand('SymmyRouteExecutorWorkloadKey')),
    }),
  ),
  /** What this change bound or registered for the Tenant's Symmy executor so the route's calls run. */
  executorWorkloads: Schema.Array(SymmyExecutorWorkloadChangeSchema),
  outcome: Schema.Literals(['deactivated', 'enrolled', 'replaced', 'unchanged']),
  requiredBindings: Schema.Array(SymmyRequiredBindingSchema),
  routeId: SymmyRouteEnrollmentRequestSchema.fields.routeId,
  routeKey: SymmyRouteEnrollmentRequestSchema.fields.routeKey,
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
 * Binds or registers for the Symmy executor what the route's bindings need of it, in the change's transaction, before the
 * bindings are checked (`grantSymmyExecutorWorkloads`).
 */
export type SymmyExecutorWorkloadGrantor = (input: {
  readonly bindings: readonly SymmyRequiredBinding[];
  readonly legalEntityId?: string | undefined;
}) => Effect.Effect<readonly SymmyExecutorWorkloadChange[], SymmyRouteEnrollmentUnavailable, Crypto.Crypto>;

/** Who applied a change and why: the administrator's principal and Action invocation, and the stated reason. */
export interface SymmyRouteEnrollmentAttribution {
  readonly operatorRef: string;
  readonly reason: string;
}

const unavailable = (reason: string) => (cause?: unknown) => new SymmyRouteEnrollmentUnavailable({ cause, reason });
const refusalOf = (code: SymmyRouteEnrollmentRefusal['code'], detail: string): SymmyRouteEnrollmentRefusal => ({
  code,
  detail,
});
const refuse = (first: SymmyRouteEnrollmentRefusal, ...rest: readonly SymmyRouteEnrollmentRefusal[]) =>
  Effect.fail(new SymmyRouteEnrollmentRefused({ refusals: [first, ...rest] }));
/** Fails with every refusal at once, so the administrator sees the whole list in one run. */
const refused = (refusals: readonly SymmyRouteEnrollmentRefusal[]) => {
  const [first, ...rest] = refusals;
  return first === undefined ? Effect.void : refuse(first, ...rest);
};

const decodeReceipt = Schema.decodeUnknownEffect(SymmyRouteEnrollmentReceiptSchema);
const decodeOutstandingWork = Schema.decodeUnknownEffect(SymmyOutstandingWorkSchema);
const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(SymmyFixtureExecutionPlanSchema));
const encodePolicy = Schema.encodeEffect(Schema.fromJsonString(SymmyJobLifecyclePolicyRefSchema));
const isRefused = Schema.is(SymmyRouteEnrollmentRefused);

/** The Core facts the route depends on, each read through its owner's exported reader. */
const coreRefusals = Effect.fn('SymmyRouteEnrollment.coreRefusals')(function* coreRefusals(
  transaction: SymmyRouteEnrollmentTransaction,
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
const lockEnrollment = (transaction: SymmyRouteEnrollmentTransaction, reference: SymmyRouteReference) =>
  transaction
    .select({ locked: sql`pg_advisory_xact_lock(hashtextextended(${symmyRouteEnrollmentLockKey(reference)}, 0))` })
    .from(sql`(values (1)) as symmy_route_enrollment_lock(anchor)`)
    .pipe(Effect.asVoid, Effect.mapError(unavailable('The route enrollment lock could not be taken')));

const RowLockSchema = Schema.Literals(['share', 'update']);
type RowLock = typeof RowLockSchema.Type;
/** The route of one kind and code for the reference's Tenant, principal and company. */
const readSelector = (transaction: SymmyRouteEnrollmentTransaction, reference: SymmyRouteReference, lock: RowLock) =>
  transaction
    .select()
    .from(symmyJobRoutes)
    .where(
      and(
        eq(symmyJobRoutes.tenantId, reference.tenantId),
        eq(symmyJobRoutes.principalId, reference.principalId),
        eq(symmyJobRoutes.active, true),
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
const readRouteId = (transaction: SymmyRouteEnrollmentTransaction, route: TenantRoute, lock: RowLock) =>
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
const readRelatedRoutes = (transaction: SymmyRouteEnrollmentTransaction, request: SymmyRouteEnrollmentRequest) =>
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
 * read whatever the route's kind, so a route of a kind the command cannot enroll still names what it admitted; the
 * admissions a replacement keeps are not read.
 */
const outstandingWork = Effect.fn('SymmyRouteEnrollment.outstandingWork')(function* outstandingWork(
  transaction: SymmyRouteEnrollmentTransaction,
  route: TenantRoute,
  admissionsOfRoute: 'kept' | 'outstanding' = 'outstanding',
) {
  const jobsRead = transaction
    .select({ jobId: symmyImportJobs.jobId, state: symmyJobEffects.state })
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
    .groupBy(symmyImportJobs.jobId, symmyJobEffects.state)
    .orderBy(symmyImportJobs.jobId, symmyJobEffects.state)
    .limit(OUTSTANDING_LIMIT + 1)
    .pipe(Effect.mapError(unavailable('The outstanding jobs of the route could not be read')));
  const admissionsRead =
    admissionsOfRoute === 'kept'
      ? Effect.succeed<readonly { readonly admissionId: string }[]>([])
      : transaction
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
  transaction: SymmyRouteEnrollmentTransaction,
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
  transaction: SymmyRouteEnrollmentTransaction,
  attribution: SymmyRouteEnrollmentAttribution,
  recorded: RecordedChange,
) =>
  transaction
    .insert(symmyRouteEnrollmentRecords)
    .values({ ...recorded, reason: attribution.reason, statedOperatorRef: attribution.operatorRef })
    .pipe(Effect.mapError(unavailable('The route change could not be recorded')));

/** The bindings, Core facts and sibling routes a route depends on: none of them decides a deactivation. */
const routeChecks = Effect.fn('SymmyRouteEnrollment.routeChecks')(function* routeChecks(
  transaction: SymmyRouteEnrollmentTransaction,
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

/** The installed contracts of the active Application Composition, which the route's bindings are derived from. */
export type SymmyRouteContracts = Parameters<typeof deriveSymmyRouteBindings>[0]['contracts'];

/** What an enable writes besides the route: the retention its lifecycle policy names and its price read source. */
export interface SymmyRouteEnableData {
  readonly priceReadSource: Option.Option<PriceSourceSystem>;
  readonly retentionPolicy: Option.Option<SymmyJobRetentionPolicy>;
}

const writtenOutcome = { insert: 'enrolled', replace: 'replaced' } as const;

/** The retention row the route's lifecycle policy names and the price read source of a priceLists route. */
const writeRouteSettings = Effect.fn('SymmyRouteEnrollment.writeSettings')(function* writeSettings(
  transaction: SymmyRouteEnrollmentTransaction,
  request: SymmyRouteEnrollmentRequest,
  data: SymmyRouteEnableData,
) {
  if (Option.isSome(data.retentionPolicy)) {
    const recorded = yield* writeSymmyRetentionPolicy(transaction, data.retentionPolicy.value).pipe(
      Effect.mapError(unavailable('The retention policy could not be written')),
    );
    if (!recorded) {
      const { policyId, revision } = data.retentionPolicy.value;
      return yield* refuse(
        refusalOf(
          'lifecycle_policy_not_configured',
          `Policy ${policyId}@${revision} of route ${request.routeId} is recorded with another retention`,
        ),
      );
    }
  }
  if (Option.isSome(data.priceReadSource)) {
    yield* writeSymmyPriceReadSource(transaction, request, data.priceReadSource.value).pipe(
      Effect.mapError(unavailable('The price read source could not be written')),
    );
  }
  return yield* Effect.void;
});

/**
 * Enrolls or replaces one route already checked against its inventory, the bindings it needs and its retention, against
 * the Core facts and sibling routes it depends on, under the enrollment lock.
 */
export const applySymmyRouteEnrollment = Effect.fn('SymmyRouteEnrollment.apply')(function* applyEnrollment(
  transaction: SymmyRouteEnrollmentTransaction,
  input: SymmyRouteEnableData & {
    readonly attribution: SymmyRouteEnrollmentAttribution;
    readonly change: Exclude<SymmyRouteChange, { readonly kind: 'deactivate' }>;
    readonly grantExecutorWorkloads: SymmyExecutorWorkloadGrantor;
    readonly inventory: SymmyRouteInventory;
    readonly plan: Pick<SymmyRouteBindingPlan, 'bindings' | 'moduleKeys'>;
    readonly request: SymmyRouteEnrollmentRequest;
  },
) {
  const { attribution, change, inventory, plan, request } = input;
  yield* lockEnrollment(transaction, request);
  const bySelector = yield* readSelector(transaction, request, 'update');
  // The selector's row is the route id's row, or another route the decision refuses: no second row is locked.
  const byRouteId = Option.isNone(bySelector)
    ? yield* readRouteId(transaction, request, 'update')
    : Option.none<RouteRow>();
  const decision = decideSymmyRouteWrite(request, { byRouteId, bySelector }, change);
  if (isRefused(decision)) {
    return yield* decision;
  }
  // The executor's missing workloads are granted first, so the binding checks read them; a refusal rolls them back.
  const [executorWorkloads, checked] = yield* Effect.all(
    [
      input.grantExecutorWorkloads({ bindings: plan.bindings, legalEntityId: request.legalEntityId }),
      routeChecks(transaction, { inventory, plan, request }),
    ],
    // In order: the checks read what the grant wrote.
    { concurrency: 1 },
  );
  yield* refused(checked.refusals);
  const receipt = (outcome: SymmyRouteEnrollmentReceipt['outcome'], changeToken: number) =>
    decodeReceipt({
      changeToken,
      executors: checked.executors,
      executorWorkloads,
      outcome,
      requiredBindings: plan.bindings,
      routeId: request.routeId,
      routeKey: request.routeKey,
      sourcePeers: checked.peers,
    }).pipe(Effect.mapError(unavailable('The enrollment receipt could not be built')));
  const settings = writeRouteSettings(transaction, request, input);
  if (decision.kind === 'unchanged') {
    yield* settings;
    const stored = Option.getOrThrow(Option.orElse(bySelector, () => byRouteId));
    return yield* receipt('unchanged', stored.changeToken);
  }
  if (decision.kind === 'replace') {
    yield* refused(symmyOutstandingRefusals(yield* outstandingWork(transaction, request, decision.admissions)));
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
  yield* settings;
  yield* recordChange(transaction, attribution, recordedWrite(request, decision, changeToken));
  return yield* receipt(writtenOutcome[decision.kind], changeToken);
});

/**
 * Enrolls or replaces one route, or finds it enrolled unchanged, with its retention policy and price read source.
 * Checked against its inventory, the active composition's bindings, the Core facts and the sibling routes it depends
 * on; under the enrollment lock, the decided change, the write, its read-back and its record.
 */
export const enableSymmyRoute = Effect.fn('SymmyRouteEnrollment.enable')(function* enableSymmyRoute(
  transaction: SymmyRouteEnrollmentTransaction,
  input: SymmyRouteEnableData & {
    readonly attribution: SymmyRouteEnrollmentAttribution;
    readonly change: Exclude<SymmyRouteChange, { readonly kind: 'deactivate' }>;
    readonly contracts: SymmyRouteContracts;
    readonly grantExecutorWorkloads: SymmyExecutorWorkloadGrantor;
    readonly request: SymmyRouteEnrollmentRequest;
  },
) {
  const { contracts, request } = input;
  const found = symmyRouteInventoryOf(request.routeKey);
  if (Option.isNone(found)) {
    return yield* refuse(
      refusalOf('route_not_inventoried', `${request.routeKey} is an operator fixture route, not a Symmy route`),
    );
  }
  const inventory = found.value;
  yield* refused(symmyRouteRequestRefusals(request, inventory));
  const plan = deriveSymmyRouteBindings({
    companyScoped: request.legalEntityId !== undefined,
    contracts,
    enrolled: symmyEnrolledInventory(inventory, request.configuration),
    inventory,
  });
  yield* refused(plan.refusals);
  yield* refused(symmyRetentionRefusals(request, Option.toArray(input.retentionPolicy)));
  return yield* applySymmyRouteEnrollment(transaction, { ...input, inventory, plan });
});

/**
 * Deactivates the stored route the reference names at the change token the administrator read, whatever its kind and
 * whatever it enrolls or admitted. It reads that route and its outstanding work and nothing else (no inventory,
 * binding, Core fact or sibling route, so a route stops even once they are gone), records what the locked route row
 * holds, and its receipt lists the work it strands.
 */
export const deactivateSymmyRoute = Effect.fn('SymmyRouteEnrollment.deactivate')(function* deactivateSymmyRoute(
  transaction: SymmyRouteEnrollmentTransaction,
  input: {
    readonly attribution: SymmyRouteEnrollmentAttribution;
    readonly expectedChangeToken: number;
    readonly reference: SymmyRouteReference;
  },
) {
  const { attribution, expectedChangeToken, reference } = input;
  yield* lockEnrollment(transaction, reference);
  const stored = yield* readRouteId(transaction, reference, 'update');
  const decision = decideSymmyRouteDeactivation(reference, stored, expectedChangeToken);
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
      executorWorkloads: [],
      outcome,
      requiredBindings: [],
      routeId: route.routeId,
      routeKey: route.routeKey,
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
  const stranded = yield* outstandingWork(transaction, route);
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
  yield* recordChange(transaction, attribution, {
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
  return yield* receipt('deactivated', changeToken, Option.some(stranded));
});

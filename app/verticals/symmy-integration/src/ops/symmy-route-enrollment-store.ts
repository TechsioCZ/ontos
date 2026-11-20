/**
 * One operator enrollment of one Symmy route, over the administrative Core database.
 *
 * The runtime role only reads `symmy_integration.job_routes`; the route is written by the migration and operator
 * login, whose writes the route trigger publishes as the route's execution gate. Every check reads published or Core
 * facts through their owners' exported readers, the route rows and outstanding work are read under the route's row
 * lock, and the write is read back in the same transaction. No owner Action or read is called, so the lock is never
 * held across one.
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
  decideSymmyRouteWrite,
  symmyCoreRefusals,
  symmyEnrolledInventory,
  symmyOutstandingRefusals,
  symmyPlannedRouteRow,
  symmyRelatedRouteRefusals,
  symmyRetentionRefusals,
  symmyRouteDifferences,
  symmyRouteInventoryOf,
  symmyRouteRequestRefusals,
  symmySourceFamilyPeers,
} from './symmy-route-enrollment.ts';
import type { SymmyRouteEnrollmentRequest, SymmyRouteInventory } from './symmy-route-enrollment.ts';
import type { SymmyRouteBindingPlan } from './symmy-route-bindings.ts';

/** The outstanding work a refusal names; the operator re-runs once it has been resolved. */
const OUTSTANDING_LIMIT = 50;

type CoreExecutor = (typeof CoreDatabase)['Service']['executor'];
type Transaction = Parameters<Parameters<CoreExecutor['transaction']>[0]>[0];

export const SymmyRouteEnrollmentModeSchema = Schema.Literals(['dry-run', 'apply', 'verify']);
export type SymmyRouteEnrollmentMode = typeof SymmyRouteEnrollmentModeSchema.Type;

export const SymmyRouteEnrollmentReceiptSchema = Schema.Struct({
  /** The one active system principal that runs each executor workload of the route. */
  executors: Schema.Array(
    Schema.Struct({
      principalId: PrincipalIdSchema,
      workloadKey: Schema.String.pipe(Schema.brand('SymmyRouteExecutorWorkloadKey')),
    }),
  ),
  mode: SymmyRouteEnrollmentModeSchema,
  outcome: Schema.Literals(['enrolled', 'replaced', 'unchanged', 'would_enroll', 'would_replace', 'verified']),
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
});
export type SymmyRouteEnrollmentReceipt = typeof SymmyRouteEnrollmentReceiptSchema.Type;

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

/** The route of one kind and code for the request's Tenant, principal and company, locked for this transaction. */
const lockSelector = (transaction: Transaction, request: SymmyRouteEnrollmentRequest) =>
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
    .for('update')
    .pipe(
      Effect.map(([row]) => Option.fromUndefinedOr(row)),
      Effect.mapError(unavailable('The enrolled routes could not be read')),
    );

const readRouteId = (transaction: Transaction, routeId: string) =>
  transaction
    .select()
    .from(symmyJobRoutes)
    .where(eq(symmyJobRoutes.routeId, routeId))
    .limit(1)
    .for('update')
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

const writeRoute = Effect.fn('SymmyRouteEnrollment.writeRoute')(function* writeRoute(
  transaction: Transaction,
  request: SymmyRouteEnrollmentRequest,
  replace: boolean,
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
  const written = replace
    ? transaction
        .update(symmyJobRoutes)
        .set(row)
        .where(and(eq(symmyJobRoutes.tenantId, request.tenantId), eq(symmyJobRoutes.routeId, request.routeId)))
    : transaction.insert(symmyJobRoutes).values(row);
  yield* written.pipe(Effect.mapError(unavailable('The route could not be written')));
});

/**
 * The transaction of one enrollment, for a request already checked against its inventory, the active composition and
 * the retention configuration: the Core facts, the bindings by name, the related routes, then the decided write.
 */
export const enrollSymmyRoute = Effect.fn('SymmyRouteEnrollment.enroll')(function* enrollSymmyRoute(input: {
  readonly inventory: SymmyRouteInventory;
  readonly mode: SymmyRouteEnrollmentMode;
  readonly plan: Pick<SymmyRouteBindingPlan, 'bindings' | 'moduleKeys'>;
  readonly replace: boolean;
  readonly request: SymmyRouteEnrollmentRequest;
}) {
  const { inventory, plan, request } = input;
  const { executor } = yield* CoreDatabase;
  return yield* executor
    .transaction(
      Effect.fn('SymmyRouteEnrollment.transaction')(function* enrollment(transaction) {
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
        const bindings = checkSymmyRouteBindings({
          bindings: plan.bindings,
          holders,
          principalId: request.principalId,
        });
        const bySelector = yield* lockSelector(transaction, request);
        const byRouteId = yield* readRouteId(transaction, request.routeId);
        const related = symmyRelatedRouteRefusals(request, inventory, yield* readRelatedRoutes(transaction, request));
        yield* refused([...core, ...bindings.refusals, ...related.refusals]);
        const receipt = (outcome: SymmyRouteEnrollmentReceipt['outcome']) =>
          decodeReceipt({
            executors: [...bindings.executors].map(([workloadKey, principalId]) => ({ principalId, workloadKey })),
            mode: input.mode,
            outcome,
            requiredBindings: plan.bindings,
            routeId: request.routeId,
            routeKey: request.routeKey,
            sourcePeers: related.peers,
          }).pipe(Effect.mapError(unavailable('The enrollment receipt could not be built')));
        if (input.mode === 'verify') {
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
          return yield* receipt('verified');
        }
        const decision = decideSymmyRouteWrite(request, { byRouteId, bySelector }, input.replace);
        if (isRefused(decision)) {
          return yield* decision;
        }
        if (decision.kind === 'unchanged') {
          return yield* receipt('unchanged');
        }
        if (decision.kind === 'replace') {
          yield* refused(yield* outstandingWork(transaction, request, inventory));
        }
        if (input.mode === 'dry-run') {
          return yield* receipt(decision.kind === 'insert' ? 'would_enroll' : 'would_replace');
        }
        yield* writeRoute(transaction, request, decision.kind === 'replace');
        const stored = yield* readRouteId(transaction, request.routeId);
        if (Option.isNone(stored) || symmyRouteDifferences(request, stored.value).length > 0) {
          return yield* unavailable('The enrolled route does not read back as written')();
        }
        return yield* receipt(decision.kind === 'insert' ? 'enrolled' : 'replaced');
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
 * Runs one enrollment of one route. dry-run and verify write nothing; apply inserts the route, replaces it when
 * `replace` is set, or leaves an identical route unchanged, and reads it back. Any refusal or failure rolls back.
 */
export const runSymmyRouteEnrollment = Effect.fn('SymmyRouteEnrollment.run')(function* runSymmyRouteEnrollment(input: {
  readonly mode: SymmyRouteEnrollmentMode;
  readonly replace: boolean;
  readonly request: unknown;
}) {
  const request = yield* decodeRequest(input.request).pipe(
    Effect.catchTag('SchemaError', ({ message }) => refuse(refusalOf('invalid_request', message))),
  );
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
  yield* refused(symmyRouteRequestRefusals(request, inventory));
  const authority = yield* ActiveApplicationCompositionService;
  const { catalog } = yield* loadCheckedActiveApplicationComposition(authority).pipe(
    Effect.mapError(unavailable('The active Application Composition could not be read')),
  );
  const plan = deriveSymmyRouteBindings({
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
  return yield* enrollSymmyRoute({ inventory, mode: input.mode, plan, replace: input.replace, request });
});

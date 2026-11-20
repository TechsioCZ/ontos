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
 * admitted; the refusal lists those jobs.
 */
import {
  ActiveApplicationCompositionService,
  loadCheckedActiveApplicationComposition,
  makeLegalEntityContext,
  makeSystemPrincipalContextResolver,
  makeTenantModuleStateService,
  principalEligibilityForTransaction,
  registerSystemWorkload,
  registeredWorkloadCallReceiverIssue,
} from '@app/core-runtime';
import type { OntosModuleDeploymentContract } from '@app/core-runtime';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { Config, Effect, Option, Schema } from 'effect';

import { SymmyFixtureExecutionPlanSchema } from '../../shared/domain/symmy-job-execution.ts';
import { SymmyJobLifecyclePolicyRefSchema } from '../../shared/domain/symmy-job-notification.ts';
import { SymmyJobRetentionPolicySchema } from '../../shared/domain/symmy-job-retention.ts';
import { symmyImportJobs, symmyJobEffects, symmyJobRoutes } from '../db/schema.ts';
import { SymmyRouteEnrollmentRefused } from './symmy-route-enrollment-refused.ts';
import type { SymmyRouteEnrollmentRefusal } from './symmy-route-enrollment-refused.ts';
import { SymmyRouteEnrollmentUnavailable } from './symmy-route-enrollment-unavailable.ts';
import {
  SymmyRouteCallerSchema,
  SymmyRouteEnrollmentRequestSchema,
  decideSymmyRouteWrite,
  symmyCounterpartRefusals,
  symmyPlannedRouteRow,
  symmyRetentionRefusals,
  symmyRouteDifferences,
  symmyRouteInventoryOf,
  symmyRouteRequestRefusals,
  symmyWorkerCallOf,
} from './symmy-route-enrollment.ts';
import type { SymmyRouteEnrollmentRequest, SymmyRouteInventoryOperation } from './symmy-route-enrollment.ts';

const SYMMY_MODULE = 'integration.symmy';
const WORKER_JOB_KEY = 'integration.symmy.execute-symmy-job';
/** The outstanding jobs a refusal names; the operator re-runs once these have drained. */
const OUTSTANDING_LIMIT = 50;

type CoreExecutor = (typeof CoreDatabase)['Service']['executor'];
type Transaction = Parameters<Parameters<CoreExecutor['transaction']>[0]>[0];
type RouteRow = typeof symmyJobRoutes.$inferSelect;

export const SymmyRouteEnrollmentModeSchema = Schema.Literals(['dry-run', 'apply', 'verify']);
export type SymmyRouteEnrollmentMode = typeof SymmyRouteEnrollmentModeSchema.Type;

/** A binding one of the two route identities needs. Core is the only writer of bindings; this command grants none. */
const RequiredBindingSchema = Schema.Struct({
  identity: SymmyRouteCallerSchema,
  purpose: Schema.String,
  workloadKey: Schema.String.pipe(Schema.brand('SymmyRouteRequiredWorkloadKey')),
});
type RequiredBinding = typeof RequiredBindingSchema.Type;
const requiredWorkload = (workloadKey: string) => RequiredBindingSchema.fields.workloadKey.make(workloadKey);

export const SymmyRouteEnrollmentReceiptSchema = Schema.Struct({
  counterpart: Schema.Literals(['matches', 'not_enrolled']),
  mode: SymmyRouteEnrollmentModeSchema,
  outcome: Schema.Literals(['enrolled', 'replaced', 'unchanged', 'would_enroll', 'would_replace', 'verified']),
  requiredBindings: Schema.Array(RequiredBindingSchema),
  routeId: SymmyRouteEnrollmentRequestSchema.fields.routeId,
  routeKey: SymmyRouteEnrollmentRequestSchema.fields.routeKey,
  workerPrincipalId: Schema.OptionFromNullOr(Schema.String),
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
const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(SymmyFixtureExecutionPlanSchema));
const encodePolicy = Schema.encodeEffect(Schema.fromJsonString(SymmyJobLifecyclePolicyRefSchema));
const decodeConfiguration = Schema.decodeUnknownOption(SymmyFixtureExecutionPlanSchema);
const isRefused = Schema.is(SymmyRouteEnrollmentRefused);
const isUnavailable = Schema.is(SymmyRouteEnrollmentUnavailable);

/** The workloads a published operation admits: an Action's own carrier or a read's published carrier. */
const publishedWorkloads = (
  contract: OntosModuleDeploymentContract | undefined,
  operation: Pick<SymmyRouteInventoryOperation, 'entrypointKey' | 'schemaVersion'>,
): Option.Option<readonly string[]> => {
  if (contract === undefined) {
    return Option.none();
  }
  const { actions, operationContracts } = contract.manifest.publicSurface;
  const matches = (candidate: {
    readonly entrypoint: { readonly entrypointKey: string };
    readonly schemaVersion: string;
  }) =>
    candidate.entrypoint.entrypointKey === operation.entrypointKey &&
    candidate.schemaVersion === operation.schemaVersion;
  const declared = [
    ...actions.flatMap((action) => (matches(action) ? [action.accessWorkload?.workloads ?? []] : [])),
    ...(operationContracts ?? []).flatMap((read) => (matches(read) ? [read.workloadCarrier?.workloads ?? []] : [])),
  ];
  return declared.length === 0 ? Option.none() : Option.some(declared.flat());
};

/** What Symmy itself publishes for the Shell to admit and poll a route of this kind. */
const symmyAdmissionOperations = (durableJobs: boolean) => [
  { entrypointKey: 'integration.symmy.api.symmy-route-context', purpose: 'route context', schemaVersion: '1' },
  ...(durableJobs
    ? [
        { entrypointKey: 'integration.symmy.admit-symmy-job', purpose: 'admission', schemaVersion: '1' },
        { entrypointKey: 'integration.symmy.api.symmy-job-status', purpose: 'polling', schemaVersion: '1' },
      ]
    : []),
];

/**
 * Checks every operation the route enrolls against the active Application Composition and derives the bindings each
 * identity needs: the worker's published registered call (receiver, version, declaration, workload, company scope)
 * and, for a Shell read, the receiver's published workloads.
 */
const checkComposition = Effect.fn('SymmyRouteEnrollment.checkComposition')(function* checkComposition(
  operations: readonly SymmyRouteInventoryOperation[],
  durableJobs: boolean,
) {
  const authority = yield* ActiveApplicationCompositionService;
  const { catalog } = yield* loadCheckedActiveApplicationComposition(authority).pipe(
    Effect.mapError(unavailable('The active Application Composition could not be read')),
  );
  const byModule = (moduleId: string) => catalog.contracts.find((contract) => contract.manifest.module.id === moduleId);
  const byAppId = (appId: string) => catalog.contracts.find((contract) => contract.deployment.appId === appId);
  const refusals: SymmyRouteEnrollmentRefusal[] = [];
  const bindings: RequiredBinding[] = [];
  for (const admission of symmyAdmissionOperations(durableJobs)) {
    const workloads = publishedWorkloads(byModule(SYMMY_MODULE), admission);
    if (Option.isNone(workloads)) {
      refusals.push(
        refusalOf('operation_not_published', `${admission.entrypointKey} is not published by ${SYMMY_MODULE}`),
      );
    } else {
      bindings.push(
        ...workloads.value.map((workloadKey) => ({
          identity: 'integration' as const,
          purpose: admission.purpose,
          workloadKey: requiredWorkload(workloadKey),
        })),
      );
    }
  }
  for (const operation of operations) {
    const name = `${operation.entrypointKey}@${operation.schemaVersion}`;
    if (operation.caller === 'worker') {
      const call = symmyWorkerCallOf(operation);
      const issue =
        call === undefined
          ? `Symmy registers no worker call of ${name}`
          : registeredWorkloadCallReceiverIssue(call, byAppId(call.audience));
      if (issue !== undefined || call === undefined) {
        refusals.push(refusalOf('operation_not_published', issue ?? name));
      } else {
        bindings.push({ identity: 'worker', purpose: name, workloadKey: requiredWorkload(call.workloadKey) });
      }
    } else {
      const workloads = publishedWorkloads(byModule(operation.moduleId), operation);
      if (Option.isNone(workloads)) {
        refusals.push(refusalOf('operation_not_published', `${name} is not published by ${operation.moduleId}`));
      } else {
        bindings.push(
          ...workloads.value.map((workloadKey) => ({
            identity: 'integration' as const,
            purpose: name,
            workloadKey: requiredWorkload(workloadKey),
          })),
        );
      }
    }
  }
  if (durableJobs) {
    bindings.push({ identity: 'worker', purpose: 'job execution', workloadKey: requiredWorkload(WORKER_JOB_KEY) });
  }
  const unique = new Map(bindings.map((binding) => [`${binding.identity} ${binding.workloadKey}`, binding]));
  yield* refused(refusals);
  return [...unique.values()];
});

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
  const company =
    request.legalEntityId === undefined
      ? []
      : yield* makeLegalEntityContext({ executor: transaction })
          .validateSelection(request.tenantId, request.legalEntityId)
          .pipe(
            Effect.as([]),
            Effect.catchTag('LegalEntityContextUnavailableError', (cause) =>
              Effect.fail(unavailable('The company could not be read')(cause)),
            ),
            Effect.orElseSucceed(() => [
              refusalOf('company_not_active', 'The company is not an active company of the Tenant'),
            ]),
          );
  const principal = yield* principalEligibilityForTransaction(transaction).resolve({
    principalId: request.principalId,
    tenantId: request.tenantId,
  });
  if (principal.decision === 'unavailable') {
    return yield* unavailable('The integration principal could not be read')();
  }
  return [
    ...moduleKeys.flatMap((moduleKey) =>
      active.has(moduleKey) ? [] : [refusalOf('module_not_active', `Module ${moduleKey} is not active in the Tenant`)],
    ),
    ...company,
    ...(principal.decision === 'eligible'
      ? []
      : [refusalOf('integration_principal_not_active', `The integration principal is ${principal.reason}`)]),
  ];
});

/** Exactly one active system principal of the Tenant runs Symmy jobs, as the worker resolves it. */
const resolveWorker = Effect.fn('SymmyRouteEnrollment.resolveWorker')(function* resolveWorker(
  executor: CoreExecutor,
  tenantId: string,
) {
  return yield* makeSystemPrincipalContextResolver({ executor })
    .resolveEnrolled({
      registration: registerSystemWorkload({ jobKey: WORKER_JOB_KEY }),
      runReference: 'symmy-route-enrollment',
      tenantId,
    })
    .pipe(
      Effect.map(({ principalId }) => Option.some<string>(principalId)),
      Effect.catchTag('SystemPrincipalContextDeniedError', ({ reason }) =>
        Effect.fail(new SymmyRouteEnrollmentRefused({ refusals: [refusalOf('worker_principal_not_unique', reason)] })),
      ),
      Effect.catchTags({
        SystemPrincipalContextInvalidError: unavailable('The worker principal could not be resolved'),
        SystemPrincipalContextUnavailableError: unavailable('The worker principal could not be resolved'),
      }),
    );
});

const companyMatch = (legalEntityId: string | undefined) =>
  legalEntityId === undefined ? isNull(symmyJobRoutes.legalEntityId) : eq(symmyJobRoutes.legalEntityId, legalEntityId);

/** The uncoded route of one kind for the request's Tenant, principal and company, locked for this transaction. */
const lockSelector = (transaction: Transaction, request: SymmyRouteEnrollmentRequest, routeKey: RouteRow['routeKey']) =>
  transaction
    .select()
    .from(symmyJobRoutes)
    .where(
      and(
        eq(symmyJobRoutes.tenantId, request.tenantId),
        eq(symmyJobRoutes.principalId, request.principalId),
        companyMatch(request.legalEntityId),
        eq(symmyJobRoutes.routeKey, routeKey),
        isNull(symmyJobRoutes.routeCode),
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

/** Jobs of the route with an effect that has not settled: replacing the route would close their fences. */
const outstandingJobs = (transaction: Transaction, tenantId: string, routeId: string) =>
  transaction
    .selectDistinct({ jobId: symmyImportJobs.jobId, state: symmyJobEffects.state })
    .from(symmyImportJobs)
    .innerJoin(
      symmyJobEffects,
      and(eq(symmyJobEffects.tenantId, symmyImportJobs.tenantId), eq(symmyJobEffects.jobId, symmyImportJobs.jobId)),
    )
    .where(
      and(
        eq(symmyImportJobs.tenantId, tenantId),
        eq(symmyImportJobs.routeId, routeId),
        ne(symmyJobEffects.state, 'settled'),
      ),
    )
    .orderBy(symmyImportJobs.jobId)
    .limit(OUTSTANDING_LIMIT)
    .pipe(Effect.mapError(unavailable('The outstanding jobs of the route could not be read')));

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
  const inventory = symmyRouteInventoryOf(request.routeKey);
  if (!Option.isOption(inventory)) {
    return yield* refuse(inventory);
  }
  if (Option.isNone(inventory)) {
    return yield* refuse(
      refusalOf('route_not_inventoried', `${request.routeKey} has no operation inventory and cannot be enrolled yet`),
    );
  }
  const { counterpart, durableJobs, operations } = inventory.value;
  yield* refused(symmyRouteRequestRefusals(request, inventory.value));
  const enrolled = operations.filter((operation) =>
    request.configuration.items.some(({ effects }) =>
      effects.some(
        ({ operation: candidate }) =>
          candidate.moduleId === operation.moduleId &&
          candidate.entrypointKey === operation.entrypointKey &&
          candidate.schemaVersion === operation.schemaVersion,
      ),
    ),
  );
  const bindings = yield* checkComposition(enrolled, durableJobs);
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
  const { executor } = yield* CoreDatabase;
  const workerPrincipalId = durableJobs ? yield* resolveWorker(executor, request.tenantId) : Option.none<string>();
  const moduleKeys = [...new Set([SYMMY_MODULE, ...enrolled.map(({ moduleId }) => moduleId)])].toSorted();
  return yield* executor
    .transaction(
      Effect.fn('SymmyRouteEnrollment.transaction')(function* enrollment(transaction) {
        const core = yield* coreRefusals(transaction, request, moduleKeys);
        const bySelector = yield* lockSelector(transaction, request, request.routeKey);
        const byRouteId = yield* readRouteId(transaction, request.routeId);
        const partner = yield* lockSelector(transaction, request, counterpart);
        const partnerPlan = partner.pipe(
          Option.flatMap((row) =>
            row.active
              ? decodeConfiguration(row.fixturePlan).pipe(
                  Option.map((configuration) => ({ configuration, routeId: row.routeId })),
                )
              : Option.none(),
          ),
        );
        yield* refused([...core, ...symmyCounterpartRefusals(request, partnerPlan)]);
        const receipt = (outcome: SymmyRouteEnrollmentReceipt['outcome']): SymmyRouteEnrollmentReceipt => ({
          counterpart: Option.isSome(partnerPlan) ? 'matches' : 'not_enrolled',
          mode: input.mode,
          outcome,
          requiredBindings: bindings,
          routeId: request.routeId,
          routeKey: request.routeKey,
          workerPrincipalId,
        });
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
          return receipt('verified');
        }
        const decision = decideSymmyRouteWrite(request, { byRouteId, bySelector }, input.replace);
        if (isRefused(decision)) {
          return yield* decision;
        }
        if (decision.kind === 'unchanged') {
          return receipt('unchanged');
        }
        if (decision.kind === 'replace') {
          const outstanding = yield* outstandingJobs(transaction, request.tenantId, request.routeId);
          yield* refused(
            outstanding.length === 0
              ? []
              : [
                  refusalOf(
                    'outstanding_work',
                    `Drain or reconcile these jobs first: ${outstanding
                      .map(({ jobId, state }) => `${jobId} (${state})`)
                      .join(', ')}`,
                  ),
                ],
          );
        }
        if (input.mode === 'dry-run') {
          return receipt(decision.kind === 'insert' ? 'would_enroll' : 'would_replace');
        }
        yield* writeRoute(transaction, request, decision.kind === 'replace');
        const stored = yield* readRouteId(transaction, request.routeId);
        if (Option.isNone(stored) || symmyRouteDifferences(request, stored.value).length > 0) {
          return yield* unavailable('The enrolled route does not read back as written')();
        }
        return receipt(decision.kind === 'insert' ? 'enrolled' : 'replaced');
      }),
    )
    .pipe(
      Effect.catchIf(
        (failure) => !(isRefused(failure) || isUnavailable(failure)),
        (cause) => Effect.fail(unavailable('The enrollment transaction did not commit')(cause)),
      ),
    );
});

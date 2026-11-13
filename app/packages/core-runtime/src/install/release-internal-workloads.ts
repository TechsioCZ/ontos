import { and, eq, inArray, sql } from 'drizzle-orm';
import { DateTime, Effect, Match, Result, Schema } from 'effect';

import { AccessReleaseStore } from '../access/changes/persistence/release-store.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../access/ids.ts';
import type { AccessIntentDatabase } from '../access/intent/persistence.ts';
import { runScoped } from '../access/intent/persistence.ts';
import { RELEASE_ACTOR_DISPLAY_NAME, releaseActorId } from '../access/release/activation.ts';
import { makeAccessWorkloadBindingDrizzleStore, writeWorkloadBindings } from '../access/workloads/binding-store.ts';
import {
  makeAccessWorkloadCompanyBindingDrizzleStore,
  writeWorkloadCompanyBindings,
} from '../access/workloads/company-bindings.ts';
import { AccessWorkloadCompanyBindingIdSchema } from '../access/workloads/company-store.ts';
import { AccessWorkloadBindingIdSchema } from '../access/workloads/store.ts';
import { WorkloadKeySchema } from '../authorization/access-declaration.ts';
import { internalWorkloadPrincipalId, tenantServesPeople } from '../auth/module-credentials.ts';
import {
  INTERNAL_WORKLOAD_PLATFORM_ROLE,
  principalManagementRepositoryFromTransaction,
} from '../auth/principal-management.ts';
import { makeSystemPrincipalContextResolver, registerSystemWorkload } from '../auth/system-principal-context.ts';
import { preserveSystemPrincipalContextTrust } from '../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../db/client.ts';
import {
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  auditEvents,
  legalEntities,
  principals,
  tenantModuleStates,
  tenants,
} from '../db/schema.ts';
import type { OperationalScope } from '../operations/context.ts';
import { planTenantInternalWorkloads } from './internal-workload-plan.ts';
import type {
  InternalWorkloadDeclaration,
  InternalWorkloadStep,
  PlatformRegistration,
  TenantWorkloadState,
} from './internal-workload-plan.ts';

/**
 * Release-time registration of the modules' own declared internal workloads (O73), the platform's step so that no
 * person ever registers or keys one:
 *
 * - For every tenant that serves people, for each module installed (`active`) there, for each internal workload that
 *   module declares in the reviewed catalogue, and for each active company of the tenant: one service principal, one
 *   workload binding and one company binding. The principal holds no role, grant or relationship; it is never a person
 *   and never an owner. Admission stays where it is: the carriers that declare that workload with that module as caller.
 * - Converges: a registration no longer wanted (module not active, workload no longer declared, company not active) is
 *   retired (company binding and workload binding revoked, principal disabled), never deleted; the platform's key
 *   provisioning then stops keying it and retires its key at its next pass.
 * - Recognises only what it made: the principal carries the platform's `internal_workload` marker (set only by Core's
 *   platform writer when it creates the principal; no Action or API sets it, and the database refuses any later change)
 *   AND its id is the one derived from tenant, workload and company (`internalWorkloadPrincipalId`). Two Actions accept
 *   a caller-chosen principal id (agent configuration, demo accounts), so the id alone is not proof. The name is never
 *   read for this: it is what a person reads, e.g. `CRM · zakládání klientů · Obchodní firma`, and follows a renamed
 *   company. A registration someone made by hand is neither adopted nor touched, and key provisioning keys none.
 * - Acts as the tenant's platform release actor (the system principal the access release activation uses), through
 *   Core's own writers, which take the tenant's workload fence; each tenant is read and written in its own scope.
 * - Each tenant is decided on its own; a failure is reported by name and the next run heals from what is true.
 */

export const RELEASE_INTERNAL_WORKLOAD_JOB = registerSystemWorkload({
  jobKey: 'release-internal-workload-registration',
});
const NO_CONSTRAINTS: ReadonlySet<string> = new Set();
const RETIREMENT_REASON = 'The internal workload is no longer wanted here (module, catalogue or company)';

export class ReleaseInternalWorkloadError extends Schema.TaggedError<ReleaseInternalWorkloadError>()(
  'ReleaseInternalWorkloadError',
  { reason: Schema.String },
) {}
const refusal = (reason: string) => new ReleaseInternalWorkloadError({ reason });

/** What one tenant holds after the run, as counts of registrations; never an identifier of a key. */
export interface ReleaseInternalWorkloadTenantReport {
  readonly failed: string | null;
  readonly held: number;
  readonly registered: number;
  readonly renamed: number;
  readonly retired: number;
  readonly tenantId: string;
  readonly unchanged: number;
}

const principalStatusOf = (status: string): PlatformRegistration['principalStatus'] =>
  status === 'active' || status === 'disabled' || status === 'archived' ? status : 'archived';

/**
 * Everything the plan needs of one tenant, read in that tenant's own scope. A principal is the platform's only when it
 * carries the platform's internal workload marker AND its id is the one derived from a workload (declared now, or the
 * one its bindings name) and a company of this tenant. Its name is never read for that: it is what a person reads.
 */
const readTenant = Effect.fn('ReleaseInternalWorkloads.readTenant')(function* readTenant(
  tenantId: string,
  declaredWorkloadKeys: readonly string[],
) {
  const { executor } = yield* CoreDatabase;
  return yield* executor
    .transaction(
      Effect.fn('ReleaseInternalWorkloads.readTenantRows')(function* readRows(transaction) {
        yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${tenantId}, true)`);
        const [modules, companies, candidates] = yield* Effect.all(
          [
            transaction
              .select({ moduleKey: tenantModuleStates.moduleKey })
              .from(tenantModuleStates)
              .where(and(eq(tenantModuleStates.tenantId, tenantId), eq(tenantModuleStates.state, 'active'))),
            transaction
              .select({
                legalEntityId: legalEntities.legalEntityId,
                legalName: legalEntities.legalName,
                status: legalEntities.status,
              })
              .from(legalEntities)
              .where(eq(legalEntities.tenantId, tenantId)),
            transaction
              .select({
                displayName: principals.displayName,
                principalId: principals.principalId,
                status: principals.status,
              })
              .from(principals)
              .where(
                and(
                  eq(principals.tenantId, tenantId),
                  eq(principals.kind, 'service'),
                  eq(principals.platformRole, INTERNAL_WORKLOAD_PLATFORM_ROLE),
                ),
              ),
          ],
          { concurrency: 1 },
        );
        const candidateIds = candidates.map(({ principalId }) => principalId);
        const bindings =
          candidateIds.length === 0
            ? []
            : yield* transaction
                .select({
                  bindingId: accessWorkloadBindings.bindingId,
                  principalId: accessWorkloadBindings.principalId,
                  status: accessWorkloadBindings.status,
                  workloadKey: accessWorkloadBindings.workloadKey,
                })
                .from(accessWorkloadBindings)
                .where(
                  and(
                    eq(accessWorkloadBindings.tenantId, tenantId),
                    inArray(accessWorkloadBindings.principalId, candidateIds),
                  ),
                );
        // The (workload, company) each derived id stands for; a candidate whose id is none of them is not the platform's.
        const workloadKeys = new Set([...declaredWorkloadKeys, ...bindings.map(({ workloadKey }) => workloadKey)]);
        const derived = new Map(
          [...workloadKeys].flatMap((workloadKey) =>
            companies.map(
              ({ legalEntityId }) =>
                [
                  internalWorkloadPrincipalId({ legalEntityId, tenantId, workloadKey }),
                  { legalEntityId, workloadKey },
                ] as const,
            ),
          ),
        );
        const owned = candidates.flatMap((candidate) => {
          const registration = derived.get(candidate.principalId);
          return registration === undefined ? [] : [{ ...candidate, ...registration }];
        });
        const bindingIds = bindings.map(({ bindingId }) => bindingId);
        const companyBindings =
          bindingIds.length === 0
            ? []
            : yield* transaction
                .select({
                  companyBindingId: accessWorkloadCompanyBindings.companyBindingId,
                  legalEntityId: accessWorkloadCompanyBindings.legalEntityId,
                  status: accessWorkloadCompanyBindings.status,
                  workloadBindingId: accessWorkloadCompanyBindings.workloadBindingId,
                })
                .from(accessWorkloadCompanyBindings)
                .where(
                  and(
                    eq(accessWorkloadCompanyBindings.tenantId, tenantId),
                    inArray(accessWorkloadCompanyBindings.workloadBindingId, bindingIds),
                  ),
                );
        const registrations = owned.map((principal): PlatformRegistration => {
          const own = bindings.filter(
            (binding) => binding.principalId === principal.principalId && binding.workloadKey === principal.workloadKey,
          );
          const active = own.find((binding) => binding.status === 'active');
          const written = companyBindings.filter((company) => company.workloadBindingId === active?.bindingId);
          return {
            activeCompanyBindingId:
              written.find(
                (company) => company.status === 'active' && company.legalEntityId === principal.legalEntityId,
              )?.companyBindingId ?? null,
            activeWorkloadBindingId: active?.bindingId ?? null,
            companyBindingCount: written.length,
            displayName: principal.displayName,
            legalEntityId: principal.legalEntityId,
            principalId: principal.principalId,
            principalStatus: principalStatusOf(principal.status),
            workloadBindingCount: own.length,
            workloadKey: principal.workloadKey,
          };
        });
        return {
          activeCompanies: new Set(
            companies.flatMap(({ legalEntityId, status }) => (status === 'active' ? [legalEntityId] : [])),
          ),
          activeModuleKeys: new Set(modules.map(({ moduleKey }) => moduleKey)),
          companyNames: new Map(companies.map(({ legalEntityId, legalName }) => [legalEntityId, legalName])),
          registrations,
          tenantId,
        } satisfies TenantWorkloadState;
      }),
    )
    .pipe(Effect.mapError((cause) => refusal(`the tenant could not be read (${cause._tag})`)));
});

/** The tenant's platform release actor, ensured and resolved as a trusted system scope (never minted). */
const releaseScopeOf = Effect.fn('ReleaseInternalWorkloads.releaseScope')(function* releaseScope(
  tenantId: string,
  runReference: string,
) {
  const releases = yield* AccessReleaseStore;
  const { executor } = yield* CoreDatabase;
  yield* releases
    .ensureReleaseActor({ displayName: RELEASE_ACTOR_DISPLAY_NAME, principalId: releaseActorId(tenantId), tenantId })
    .pipe(Effect.mapError((cause) => refusal(`the release actor could not be ensured: ${cause.reason}`)));
  const resolved = yield* makeSystemPrincipalContextResolver({ executor })
    .resolve({
      principalId: releaseActorId(tenantId),
      registration: RELEASE_INTERNAL_WORKLOAD_JOB,
      runReference,
      tenantId,
    })
    .pipe(Effect.mapError((cause) => refusal(`the release actor could not act: ${cause.reason}`)));
  return preserveSystemPrincipalContextTrust(resolved, {
    ...resolved,
    correlationId: `release-internal-workloads:${runReference}`,
  }) satisfies OperationalScope;
});

/** A step's failure, with what failed and the writer's own reason. */
const stepFailed =
  (what: string) =>
  (cause: { readonly reason?: string }): ReleaseInternalWorkloadError =>
    refusal(`${what}: ${cause.reason ?? 'unavailable'}`);

/** Performs one planned step through Core's own writer for it, as the release actor. */
const performStep = (
  database: AccessIntentDatabase,
  scope: OperationalScope,
  step: InternalWorkloadStep,
  at: Date,
): Effect.Effect<void, ReleaseInternalWorkloadError> => {
  const { tenantId } = scope;
  const principalStatus = (principalId: string, reactivate: boolean) =>
    runScoped(database, scope, NO_CONSTRAINTS, (transaction) =>
      principalManagementRepositoryFromTransaction(transaction)
        .changePrincipalStatus({
          expectedStatus: reactivate ? 'disabled' : 'active',
          newStatus: reactivate ? 'active' : 'disabled',
          principalId,
          reason: reactivate ? 'The internal workload is wanted here again' : RETIREMENT_REASON,
          tenantId,
        })
        .pipe(Effect.orDie),
    ).pipe(Effect.asVoid, Effect.mapError(stepFailed('the workload principal status could not be changed')));
  return Match.value(step).pipe(
    Match.discriminatorsExhaustive('kind')({
      'bind-company': (company) =>
        writeWorkloadCompanyBindings(database, scope, {
          bindings: [
            {
              companyBindingId: AccessWorkloadCompanyBindingIdSchema.make(company.companyBindingId),
              createdAt: at,
              incarnation: AccessWorkloadCompanyBindingIdSchema.make(company.incarnation),
              legalEntityId: LegalEntityIdSchema.make(company.legalEntityId),
              tenantId: TenantIdSchema.make(tenantId),
              workloadBindingId: AccessWorkloadBindingIdSchema.make(company.workloadBindingId),
            },
          ],
        }).pipe(Effect.mapError(stepFailed('the company binding could not be written'))),
      'bind-workload': (binding) =>
        writeWorkloadBindings(database, scope, {
          bindings: [
            {
              bindingId: AccessWorkloadBindingIdSchema.make(binding.bindingId),
              createdAt: at,
              incarnation: AccessWorkloadBindingIdSchema.make(binding.incarnation),
              principalId: PrincipalIdSchema.make(binding.principalId),
              tenantId: TenantIdSchema.make(tenantId),
              workloadKey: WorkloadKeySchema.make(binding.workloadKey),
            },
          ],
        }).pipe(Effect.mapError(stepFailed('the workload binding could not be written'))),
      'create-principal': (principal) =>
        runScoped(database, scope, NO_CONSTRAINTS, (transaction) =>
          principalManagementRepositoryFromTransaction(transaction)
            .createPlatformServicePrincipal({
              displayName: principal.displayName,
              principalId: principal.principalId,
              tenantId,
            })
            .pipe(Effect.orDie),
        ).pipe(Effect.asVoid, Effect.mapError(stepFailed('the workload principal could not be created'))),
      'disable-principal': (principal) => principalStatus(principal.principalId, false),
      'reactivate-principal': (principal) => principalStatus(principal.principalId, true),
      'rename-principal': (principal) =>
        runScoped(database, scope, NO_CONSTRAINTS, (transaction) =>
          principalManagementRepositoryFromTransaction(transaction)
            .renamePlatformServicePrincipal({
              displayName: principal.displayName,
              principalId: principal.principalId,
              tenantId,
            })
            .pipe(Effect.orDie),
        ).pipe(Effect.asVoid, Effect.mapError(stepFailed('the workload principal could not be renamed'))),
      'revoke-company': (company) =>
        makeAccessWorkloadCompanyBindingDrizzleStore(database)
          .revokeCompanyBinding(scope, {
            companyBindingId: AccessWorkloadCompanyBindingIdSchema.make(company.companyBindingId),
            revokedAt: at,
          })
          .pipe(Effect.asVoid, Effect.mapError(stepFailed('the company binding could not be revoked'))),
      'revoke-workload': (binding) =>
        makeAccessWorkloadBindingDrizzleStore(database)
          .revokeBinding(scope, { bindingId: AccessWorkloadBindingIdSchema.make(binding.bindingId), revokedAt: at })
          .pipe(Effect.asVoid, Effect.mapError(stepFailed('the workload binding could not be revoked'))),
    }),
  );
};

/** One tenant: read, plan, perform; never fails, the report says what is true. */
const registerTenant = Effect.fn('ReleaseInternalWorkloads.registerTenant')(function* registerTenant(
  database: AccessIntentDatabase,
  tenantId: string,
  declarations: readonly InternalWorkloadDeclaration[],
  runReference: string,
) {
  const outcome = yield* Effect.gen(function* decideAndPerform() {
    const plan = planTenantInternalWorkloads(
      yield* readTenant(
        tenantId,
        declarations.map(({ workloadKey }) => workloadKey),
      ),
      declarations,
    );
    const report: ReleaseInternalWorkloadTenantReport = {
      failed: null,
      held: plan.held.length,
      registered: plan.registered,
      renamed: plan.renamed,
      retired: plan.retired,
      tenantId,
      unchanged: plan.unchanged,
    };
    if (plan.steps.length === 0) {
      return report;
    }
    const scope = yield* releaseScopeOf(tenantId, runReference);
    const at = yield* DateTime.nowAsDate;
    // In order: a principal before its bindings, a binding before its company; retirement company-first.
    yield* Effect.forEach(plan.steps, (step) => performStep(database, scope, step, at), {
      concurrency: 1,
      discard: true,
    });
    yield* runScoped(database, scope, NO_CONSTRAINTS, (transaction) =>
      transaction
        .insert(auditEvents)
        .values({
          auditProfile: 'sensitive',
          authContextRef: `job:${RELEASE_INTERNAL_WORKLOAD_JOB.jobKey}:run:${runReference}`,
          authMethod: 'system',
          eventType: 'core.access.internal-workloads-registered-by-release',
          evidenceJson: {
            held: report.held,
            registered: report.registered,
            renamed: report.renamed,
            retired: report.retired,
            runReference,
            unchanged: report.unchanged,
          },
          outcome: 'succeeded',
          outcomeCode: 'internal_workloads_converged',
          outcomeStage: 'execution',
          principalId: releaseActorId(tenantId),
          targetResourceId: tenantId,
          targetResourceType: 'internal-workload-registrations',
          tenantId,
        })
        .pipe(Effect.orDie),
    ).pipe(Effect.mapError((cause) => refusal(`the registration audit record could not be written (${cause._tag})`)));
    return report;
  }).pipe(Effect.result);
  return Result.isSuccess(outcome)
    ? outcome.success
    : ({
        failed: outcome.failure.reason,
        held: 0,
        registered: 0,
        renamed: 0,
        retired: 0,
        tenantId,
        unchanged: 0,
      } satisfies ReleaseInternalWorkloadTenantReport);
});

/**
 * Registers the declared internal workloads in every tenant that serves people (the platform tenant is skipped), each
 * tenant on its own.
 */
export const registerReleaseInternalWorkloads = Effect.fn('ReleaseInternalWorkloads.register')(function* register(
  database: AccessIntentDatabase,
  input: {
    readonly declarations: readonly InternalWorkloadDeclaration[];
    /** Names this run in the release actor's trusted context and the audit, e.g. the composition revision. */
    readonly runReference: string;
  },
) {
  const { executor } = yield* CoreDatabase;
  const active = yield* executor
    .select({ tenantId: tenants.tenantId })
    .from(tenants)
    .where(eq(tenants.status, 'active'))
    .pipe(Effect.mapError((cause) => refusal(`the tenants could not be read (${cause._tag})`)));
  return yield* Effect.forEach(
    active
      .filter(({ tenantId }) => tenantServesPeople(tenantId))
      .toSorted((left, right) => left.tenantId.localeCompare(right.tenantId)),
    ({ tenantId }) => registerTenant(database, tenantId, input.declarations, input.runReference),
    { concurrency: 1 },
  );
});

import { and, eq, inArray } from 'drizzle-orm';
import { DateTime, Duration, Effect, Match, Result, Schema } from 'effect';

import { AccessReleaseStore } from '../access/changes/persistence/release-store.ts';
import { AccessProjectionWriter } from '../access/intent/projection-writer.ts';
import type { TenantProjectionWrite } from '../access/intent/projection-writer.ts';
import type { AccessProjectionWriteError } from '../access/intent/projection-write-error.ts';
import { RELEASE_ACTOR_DISPLAY_NAME, releaseActorId } from '../access/release/activation.ts';
import { makeSystemPrincipalContextResolver, registerSystemWorkload } from '../auth/system-principal-context.ts';
import { preserveSystemPrincipalContextTrust } from '../auth/system-principal-context-provenance.ts';
import { CoreDatabase } from '../db/client.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../db/types.ts';
import type { OperationalScope } from '../operations/context.ts';
import { auditEvents, tenantModuleStateChanges, tenantModuleStates, tenants } from '../db/schema.ts';
import type { InstalledModuleCatalog } from '../modules/catalog.ts';
import { OntosModuleIdSchema } from '../modules/manifest.ts';
import {
  tenantModuleIntrinsicDependencyClosure,
  validateTenantModuleIntrinsicDependencyStates,
  validateTenantModuleStateTransition,
} from '../modules/tenant-module-state-service.ts';

/**
 * Release-time installation of the modules a deployment declares per Tenant ("Tenant → modules that must be
 * active"). It is the platform's own step, so routine module installation never needs a person or a host shell:
 *
 * - Additive only. A module with no state row is installed `active`; an `active` module is left alone; a module a
 *   person has set to any other state (inactive, suspended, …) is left exactly as set and reported. It never
 *   deactivates anything.
 * - The module must be published by the active composition, and its intrinsic dependencies must be active; a module
 *   that needs a selling Tenant is installed only where one of its selling modules is already active.
 * - The write is the one `core.modules.change-tenant-module-state` makes: the state row and its history row in one
 *   transaction under the Tenant's row lock, recorded as `system` with no person and no Action invocation. It writes
 *   no Outbox wake-up: the Action's consumer, `core.authorization.reconcile-module-installation`, admits only a claim
 *   attested by a real Action invocation, and this step has none (a wake-up without one could never be processed,
 *   would die in the Outbox and block the next deploy). Instead the step reconciles the Tenant itself, through the
 *   same one Core writer, under the Tenant's platform release actor (the system principal the access release
 *   activation already uses), so the installation relations are in the engine when the step returns.
 * - Healing: the direct projection is tried again a few times within the run's budget. A projection that failed
 *   after it wrote to the engine keeps the Tenant's fence closed, and the access fence sweeper of the Outbox host
 *   reconciles it once its lease lapses; one that failed before any engine write leaves the module's rights
 *   unprojected (denied, never granted) until the next reconcile of the Tenant — at the latest the next deploy's
 *   catalog activation, which reconciles every Tenant.
 * - Every module is decided on its own; one failure is reported by name and never stops the others or the boot.
 */

/** How often, and how far apart, the direct projection is tried again after losing to a concurrent one. */
export const RELEASE_RECONCILE_RETRIES = 3;
export const RELEASE_RECONCILE_RETRY_SPACING = Duration.seconds(2);

export const RELEASE_MODULE_INSTALLATION_JOB = registerSystemWorkload({ jobKey: 'release-module-installation' });
const INSTALLATION_REASON = 'Platform release installation declared by the deployment';

/** One module that must be active in one Tenant after every release. */
export interface ReleaseTenantModule {
  readonly moduleKey: string;
  /** When not empty, the Tenant must already have one of these modules active (it sells or invoices). */
  readonly sellingModuleKeys: readonly string[];
  readonly tenantId: string;
}

export const ReleaseModuleOutcomeSchema = Schema.Literals([
  'already_active',
  'deferred',
  'failed',
  'installed',
  'left_as_set',
  'not_published',
  'selling_module_missing',
  'tenant_absent',
]);
export type ReleaseModuleOutcome = typeof ReleaseModuleOutcomeSchema.Type;

export interface ReleaseModuleReport {
  readonly detail: string;
  readonly moduleKey: string;
  readonly outcome: ReleaseModuleOutcome;
  readonly tenantId: string;
}

export interface ReleaseTenantReconcile {
  readonly deletions: number;
  readonly failure?: string;
  readonly tenantId: string;
  readonly touches: number;
}

export interface ReleaseTenantModulesReport {
  readonly modules: readonly ReleaseModuleReport[];
  readonly reconciles: readonly ReleaseTenantReconcile[];
}

export class ReleaseTenantModuleError extends Schema.TaggedError<ReleaseTenantModuleError>()(
  'ReleaseTenantModuleError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
const refusal = (reason: string, cause?: unknown) =>
  new ReleaseTenantModuleError(cause === undefined ? { reason } : { cause, reason });

const report = (entry: ReleaseTenantModule, outcome: ReleaseModuleOutcome, detail: string): ReleaseModuleReport => ({
  detail,
  moduleKey: entry.moduleKey,
  outcome,
  tenantId: entry.tenantId,
});

/** The module rows of one Tenant that the decision reads: the module itself and the modules it needs. */
const moduleStatesOf = (
  executor: Pick<CoreDatabaseExecutor, 'select'>,
  tenantId: string,
  moduleKeys: readonly string[],
) =>
  executor
    .select({ moduleKey: tenantModuleStates.moduleKey, state: tenantModuleStates.state })
    .from(tenantModuleStates)
    .where(and(eq(tenantModuleStates.tenantId, tenantId), inArray(tenantModuleStates.moduleKey, [...moduleKeys])))
    .pipe(Effect.mapError((cause) => refusal('the module states could not be read', cause)));

/**
 * The install itself, in one transaction under the Tenant's row lock, exactly as the module-state Action persists a
 * change: dependency states re-read under the lock, then the history row and the state row that points at it.
 * `false` when another writer installed the module first.
 */
/** What the install under the Tenant's row lock found: it installed, the module was already there, or no selling. */
export const LockedInstallSchema = Schema.Union([
  Schema.TaggedStruct('Installed', {}),
  Schema.TaggedStruct('AlreadyPresent', { state: Schema.String }),
  Schema.TaggedStruct('NotSelling', {}),
]);
export type LockedInstall = typeof LockedInstallSchema.Type;

export const installUnderLock = Effect.fn('ReleaseTenantModules.installUnderLock')(function* installModuleUnderLock(
  transaction: CoreTransaction,
  entry: ReleaseTenantModule,
  dependencies: readonly string[],
  /** Names the release in the audit record: the composition revision the step ran against. */
  runReference: string,
) {
  const locked = yield* transaction
    .select({ tenantId: tenants.tenantId })
    .from(tenants)
    .where(eq(tenants.tenantId, entry.tenantId))
    .for('update')
    .pipe(Effect.mapError((cause) => refusal('the Tenant could not be locked', cause)));
  if (locked.length !== 1) {
    return yield* refusal('the Tenant disappeared before its module could be installed');
  }
  if (dependencies.length > 0) {
    const rows = yield* moduleStatesOf(transaction, entry.tenantId, dependencies);
    yield* validateTenantModuleIntrinsicDependencyStates(dependencies, rows).pipe(
      Effect.mapError((cause) => refusal(`a module it needs is not active (${cause.reason})`, cause)),
    );
  }
  // Decided under the lock, so a selling module ended between the first read and here is seen.
  if (entry.sellingModuleKeys.length > 0) {
    const selling = yield* moduleStatesOf(transaction, entry.tenantId, entry.sellingModuleKeys);
    if (!selling.some(({ state }) => state === 'active')) {
      return LockedInstallSchema.members[2].make({});
    }
  }
  const [current] = yield* moduleStatesOf(transaction, entry.tenantId, [entry.moduleKey]);
  if (current !== undefined) {
    return LockedInstallSchema.members[1].make({ state: current.state });
  }
  const changedAt = yield* DateTime.nowAsDate;
  const history = yield* transaction
    .insert(tenantModuleStateChanges)
    .values({
      changeSource: 'system',
      moduleKey: entry.moduleKey,
      newState: 'active',
      occurredAt: changedAt,
      previousState: null,
      reason: INSTALLATION_REASON,
      tenantId: entry.tenantId,
    })
    .returning({ moduleStateChangeId: tenantModuleStateChanges.moduleStateChangeId })
    .pipe(Effect.mapError((cause) => refusal('the installation history could not be written', cause)));
  const [change] = history;
  if (change === undefined) {
    return yield* refusal('the installation history was not written');
  }
  yield* transaction
    .insert(tenantModuleStates)
    .values({
      lastChangeId: change.moduleStateChangeId,
      moduleKey: entry.moduleKey,
      state: 'active',
      tenantId: entry.tenantId,
      updatedAt: changedAt,
    })
    .pipe(Effect.mapError((cause) => refusal('the module state could not be written', cause)));
  // The Action rates this change critical and audits it as sensitive; the platform's install is audited the same
  // way, by the Tenant's release actor (a system principal), with the release that made it. No secret is recorded.
  yield* transaction
    .insert(auditEvents)
    .values({
      auditProfile: 'sensitive',
      authContextRef: `job:${RELEASE_MODULE_INSTALLATION_JOB.jobKey}:run:${runReference}`,
      authMethod: 'system',
      eventType: 'core.modules.tenant-module-installed-by-release',
      evidenceJson: {
        compositionRevision: runReference,
        moduleKey: entry.moduleKey,
        newState: 'active',
        previousState: null,
        risk: 'critical',
      },
      outcome: 'succeeded',
      outcomeCode: 'module_installed',
      outcomeStage: 'execution',
      principalId: releaseActorId(entry.tenantId),
      targetModuleKey: entry.moduleKey,
      targetResourceId: entry.moduleKey,
      targetResourceType: 'tenant-module-state',
      tenantId: entry.tenantId,
    })
    .pipe(Effect.mapError((cause) => refusal('the installation audit record could not be written', cause)));
  return LockedInstallSchema.members[0].make({});
});

/**
 * The outcome of the locked install, as the run reports it. A row somebody wrote between the step's first read and
 * its lock is reported with the state it actually has: active is `already_active`, anything else is a state a
 * person set, which a release never changes.
 */
export const lockedInstallReport = (entry: ReleaseTenantModule, locked: LockedInstall): ReleaseModuleReport =>
  Match.valueTags(locked, {
    AlreadyPresent: ({ state }) =>
      state === 'active'
        ? report(entry, 'already_active', 'installed concurrently')
        : report(
            entry,
            'left_as_set',
            `set ${state} by someone else while this release decided; a release never changes that`,
          ),
    Installed: () => report(entry, 'installed', 'installed active by the release'),
    NotSelling: () =>
      report(entry, 'selling_module_missing', `none of ${entry.sellingModuleKeys.join(', ')} is active`),
  });

/** Decide and, when the module is missing, install one module of one Tenant. Never fails: the outcome says why. */
const installOne = Effect.fn('ReleaseTenantModules.installOne')(
  function* installReleaseModule(
    executor: CoreDatabaseExecutor,
    catalog: InstalledModuleCatalog,
    entry: ReleaseTenantModule,
    runReference: string,
  ) {
    const tenantRows = yield* executor
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.tenantId, entry.tenantId))
      .pipe(Effect.mapError((cause) => refusal('the Tenant could not be read', cause)));
    const [tenant] = tenantRows;
    if (tenant?.status !== 'active') {
      return report(
        entry,
        'tenant_absent',
        tenant === undefined ? 'no such Tenant here' : `Tenant is ${tenant.status}`,
      );
    }
    const moduleId = yield* Schema.decodeUnknownEffect(OntosModuleIdSchema)(entry.moduleKey).pipe(
      Effect.mapError((cause) => refusal('the module key is not a module id', cause)),
    );
    if (catalog.getByModuleId(moduleId) === undefined) {
      return report(entry, 'not_published', 'the active composition does not publish this module');
    }
    const [current] = yield* moduleStatesOf(executor, entry.tenantId, [entry.moduleKey]);
    if (current !== undefined) {
      return current.state === 'active'
        ? report(entry, 'already_active', 'active')
        : report(entry, 'left_as_set', `a person set it ${current.state}; a release never changes that`);
    }
    yield* validateTenantModuleStateTransition(catalog, moduleId, 'active').pipe(
      Effect.mapError((cause) => refusal(cause.reason, cause)),
    );
    const dependencies = yield* tenantModuleIntrinsicDependencyClosure(catalog, entry.moduleKey).pipe(
      Effect.mapError((cause) => refusal(`its dependencies could not be resolved (${cause.reason})`, cause)),
    );
    // The release actor is the audited author of the install, so it exists before the install transaction starts.
    const releases = yield* AccessReleaseStore;
    yield* releases
      .ensureReleaseActor({
        displayName: RELEASE_ACTOR_DISPLAY_NAME,
        principalId: releaseActorId(entry.tenantId),
        tenantId: entry.tenantId,
      })
      .pipe(Effect.mapError((cause) => refusal(`${cause.code}: ${cause.reason}`, cause)));
    const installed = yield* executor
      .transaction((transaction) => installUnderLock(transaction, entry, dependencies, runReference))
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(ReleaseTenantModuleError)(cause) ? cause : refusal('the transaction failed', cause),
        ),
      );
    return lockedInstallReport(entry, installed);
  },
  (effect, _executor, _catalog, entry) =>
    effect.pipe(
      Effect.catchTag('ReleaseTenantModuleError', (problem) => Effect.succeed(report(entry, 'failed', problem.reason))),
    ),
);

/** The Tenant's platform release actor, ensured and resolved as a trusted system scope (never minted). */
const releaseScopeOf = Effect.fn('ReleaseTenantModules.releaseScope')(function* releaseInstallationScope(
  tenantId: string,
  runReference: string,
) {
  const releases = yield* AccessReleaseStore;
  const { executor } = yield* CoreDatabase;
  yield* releases
    .ensureReleaseActor({ displayName: RELEASE_ACTOR_DISPLAY_NAME, principalId: releaseActorId(tenantId), tenantId })
    .pipe(Effect.mapError((cause) => refusal(`${cause.code}: ${cause.reason}`, cause)));
  const resolved = yield* makeSystemPrincipalContextResolver({ executor })
    .resolve({
      principalId: releaseActorId(tenantId),
      registration: RELEASE_MODULE_INSTALLATION_JOB,
      runReference,
      tenantId,
    })
    .pipe(Effect.mapError((cause) => refusal(`the release actor could not act: ${cause.reason}`, cause)));
  return preserveSystemPrincipalContextTrust(resolved, {
    ...resolved,
    correlationId: `release-module-installation:${runReference}`,
  }) satisfies OperationalScope;
});

/** A projection is started only with at least this much of the budget left, so it never has to be cut short. */
export const RELEASE_RECONCILE_RESERVE = Duration.minutes(1);

/** Whether the run's budget still covers `reserve` from now; a run with no deadline always has time. */
const withinBudget = (deadline: DateTime.Utc | undefined, reserve: Duration.Duration) =>
  DateTime.now.pipe(
    Effect.map(
      (now) => deadline === undefined || DateTime.isLessThanOrEqualTo(DateTime.addDuration(now, reserve), deadline),
    ),
  );

/**
 * One projection, and after a failure another one `retrySpacing` later, at most `retriesLeft` more times and each
 * only while the run's budget still holds `RELEASE_RECONCILE_RESERVE`: a retry is a new projection, and is started
 * under the same rule as the first.
 */
const reconcileWithinBudget = Effect.fn('ReleaseTenantModules.reconcileWithinBudget')(
  function* reconcileWithinBudgetEffect(
    scope: OperationalScope,
    deadline: DateTime.Utc | undefined,
    retrySpacing: Duration.Duration,
    retriesLeft: number,
  ): Effect.fn.Return<TenantProjectionWrite, AccessProjectionWriteError, AccessProjectionWriter> {
    const writer = yield* AccessProjectionWriter;
    const written = yield* Effect.result(writer.reconcileTenant({ scope }));
    if (Result.isSuccess(written)) {
      return written.success;
    }
    if (retriesLeft === 0) {
      return yield* written.failure;
    }
    yield* Effect.sleep(retrySpacing);
    if (!(yield* withinBudget(deadline, RELEASE_RECONCILE_RESERVE))) {
      return yield* written.failure;
    }
    return yield* reconcileWithinBudget(scope, deadline, retrySpacing, retriesLeft - 1);
  },
);

/** Project a Tenant whose modules changed, through the one Core writer, as the Outbox worker would. */
const reconcileInstalledTenant = Effect.fn('ReleaseTenantModules.reconcileTenant')(
  function* reconcileReleaseTenant(
    tenantId: string,
    runReference: string,
    retrySpacing: Duration.Duration,
    deadline: DateTime.Utc | undefined,
  ) {
    const scope = yield* releaseScopeOf(tenantId, runReference);
    // A concurrent projection that read the tenant before the install committed can win the fence: try again a few
    // times so the rights are live quickly. A Tenant left closed is the fence sweeper's; see the module comment.
    const written = yield* reconcileWithinBudget(scope, deadline, retrySpacing, RELEASE_RECONCILE_RETRIES).pipe(
      Effect.mapError((cause) => refusal(`the projection could not be reconciled: ${cause.reason}`, cause)),
    );
    return { deletions: written.deletions, tenantId, touches: written.touches } satisfies ReleaseTenantReconcile;
  },
  (effect, tenantId) =>
    effect.pipe(
      Effect.catchTag('ReleaseTenantModuleError', (problem) =>
        Effect.succeed({
          deletions: 0,
          failure: problem.reason,
          tenantId,
          touches: 0,
        } satisfies ReleaseTenantReconcile),
      ),
    ),
);

/**
 * Installs every declared module that a Tenant still lacks, then reconciles each Tenant that gained one. A second
 * run over the same state installs and reconciles nothing.
 */

export const installReleaseTenantModules = Effect.fn('ReleaseTenantModules.install')(
  function* installReleaseModules(input: {
    readonly catalog: InstalledModuleCatalog;
    /**
     * The run's time limit. Installs (short transactions) stop being started at the deadline; a Tenant's projection,
     * which takes the Tenant's access fence, is started only with `RELEASE_RECONCILE_RESERVE` left and then always
     * runs to its end. Anything not reached is reported `deferred` for the next release.
     */
    readonly deadline?: DateTime.Utc;
    readonly modules: readonly ReleaseTenantModule[];
    /** How far apart a lost projection is tried again; `RELEASE_RECONCILE_RETRY_SPACING` unless a suite sets it. */
    readonly reconcileRetrySpacing?: Duration.Duration;
    /** Names this run in the release actor's trusted context, e.g. the composition revision. */
    readonly runReference: string;
  }) {
    const { executor } = yield* CoreDatabase;
    const modules = yield* Effect.forEach(
      input.modules,
      (entry) =>
        withinBudget(input.deadline, Duration.zero).pipe(
          Effect.flatMap((open) =>
            open
              ? installOne(executor, input.catalog, entry, input.runReference)
              : Effect.succeed(
                  report(entry, 'deferred', 'the release step ran out of time; the next release installs it'),
                ),
          ),
        ),
      { concurrency: 1 },
    );
    const changedTenants = new Set<string>();
    for (const { outcome, tenantId } of modules) {
      if (outcome === 'installed') {
        changedTenants.add(tenantId);
      }
    }
    const reconciles = yield* Effect.forEach(
      [...changedTenants],
      (tenantId) =>
        withinBudget(input.deadline, RELEASE_RECONCILE_RESERVE).pipe(
          Effect.flatMap((open) =>
            open
              ? reconcileInstalledTenant(
                  tenantId,
                  input.runReference,
                  input.reconcileRetrySpacing ?? RELEASE_RECONCILE_RETRY_SPACING,
                  input.deadline,
                )
              : Effect.succeed({
                  deletions: 0,
                  failure: 'deferred: too little of the release budget was left to start the projection',
                  tenantId,
                  touches: 0,
                } satisfies ReleaseTenantReconcile),
          ),
        ),
      { concurrency: 1 },
    );
    const result: ReleaseTenantModulesReport = { modules, reconciles };
    return result;
  },
);

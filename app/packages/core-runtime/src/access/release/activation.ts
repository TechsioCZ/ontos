import { eq } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Result, Schema } from 'effect';

import { TrustedPrincipalContextSchema } from '../../actions/principal-context.ts';
import { PLATFORM_TENANT } from '../../auth/module-credentials.ts';
import { makeSystemPrincipalContextResolver, registerSystemWorkload } from '../../auth/system-principal-context.ts';
import { preserveSystemPrincipalContextTrust } from '../../auth/system-principal-context-provenance.ts';
import type { AccessCatalogModule } from '../../authorization/access-declaration.ts';
import { CoreDatabase } from '../../db/client.ts';
import { tenants } from '../../db/schema.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { FULL_ACCESS_ROLE_TEMPLATE_KEY, compileFullAccessRole } from '../bootstrap/full-access-role.ts';
import { buildDeploymentCatalogRelease } from '../catalog/release.ts';
import type { CatalogReleaseOrdering } from '../catalog/release-ordering.ts';
import { stableUuid } from '../catalog/stable-id.ts';
import { diffCatalogSnapshots } from '../changes/catalog-diff.ts';
import { blueprintChangeItems, changeItemIdentityKey, planChangeItems } from '../changes/items.ts';
import { AccessReleaseStore } from '../changes/persistence/release-store.ts';
import type { RecordReleaseFollowInput } from '../changes/persistence/release-store.ts';
import { AccessChangesStore } from '../changes/persistence/store.ts';
import type { AccessChangesState } from '../changes/persistence/store.ts';
import { RoleCellEditSchema, planRoleCellEdit } from '../changes/role-edits.ts';
import type { RoleCellEdit, RoleWithRevision } from '../changes/role-edits.ts';
import type { CapabilityKey } from '../ids.ts';
import { AccessProjectionWriter } from '../intent/projection-writer.ts';
import type { AccessChangeItem, CatalogSnapshot } from '../model.ts';
import { ACCESS_MODEL_PARSE_OPTIONS } from '../model.ts';

/*
 * Release activation (ADR-0030, "Novinky"): what a deployment's access catalog does to every tenant when the
 * deployment activates. It runs once per activation, after the migrations and before the release takes the
 * authority (`scripts/activate-access-catalog-release.mts`, called by the migrator):
 *
 *   1. The deployment's catalog becomes the newest release when it is newer than every published release
 *      (`orderCatalogRelease`, under one global lock), so an older deployment that starts again while a newer
 *      one serves can never move the catalog back. An older catalog changes nothing at all.
 *   2. In every active tenant, "Plný přístup" (the `full_access` template preset, found by its template key,
 *      never by its name) follows the newest release: an additions-only successor revision, so every holder in
 *      every company where the role is held gains exactly the new capabilities, and nothing is ever narrowed.
 *      A preset a person has changed (`customer_changed`) is a role like any other and does not follow.
 *   3. Every other role adopts nothing automatically: the release's changes are recorded as pending Novinky
 *      items for an administrator to adopt, exactly as `docs/architecture/AUTHORIZATION.md` describes.
 *   4. The tenant's projection is reconciled from intent, so the engine serves what intent now says.
 *
 * The writes are the platform's: each tenant has one `system` principal, the release actor, which authors the
 * preset's successor revision. It is never a person, holds no Role and is never a v2 subject. Agents, service
 * principals, workload bindings and agent write policies are untouched.
 *
 * Failure is fail-closed and retried: a tenant whose follow fails keeps its previous release (new capabilities
 * stay denied there), the report names it, and the next activation repeats the idempotent writes.
 */

/** The job a release actor's trusted system context is resolved for. */
export const RELEASE_ACTIVATION_JOB = registerSystemWorkload({ jobKey: 'access-release-activation' });

/** The name role history shows for the platform's own role revisions. */
export const RELEASE_ACTOR_DISPLAY_NAME = 'OntOS · vydání oprávnění';

/** The tenant's release actor: derived from the tenant, so every activation names the same principal. */
export const releaseActorId = (tenantId: string): string => stableUuid(`ontos.access.release-actor:${tenantId}`);

/** The preset successor a release follow writes: one per role and release, so a retry names the same one. */
const presetFollowRevisionId = (tenantId: string, roleId: string, catalogSnapshotId: string): string =>
  stableUuid(['ontos.access.release-follow.revision', tenantId, roleId, catalogSnapshotId].join(':'));

/** One Novinky item per change, release and tenant: a retried activation records the same item. */
const releaseItemId = (tenantId: string, catalogSnapshotId: string, identity: string): string =>
  stableUuid(['ontos.access.release-item', tenantId, catalogSnapshotId, identity].join(':'));

export class AccessReleaseActivationError extends Schema.TaggedError<AccessReleaseActivationError>()(
  'AccessReleaseActivationError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}
const refusal = (reason: string, cause?: unknown) =>
  new AccessReleaseActivationError(cause === undefined ? { reason } : { cause, reason });

/** The untouched full-access preset of a tenant, when it has one. */
export const fullAccessPresetOf = (roles: readonly RoleWithRevision[]): Option.Option<RoleWithRevision> =>
  Option.fromUndefinedOr(
    roles.find(
      ({ revision }) => revision.provenance === 'template' && revision.templateKey === FULL_ACCESS_ROLE_TEMPLATE_KEY,
    ),
  );

export interface TenantReleaseFollowInput {
  readonly createdAt: Date;
  readonly newest: CatalogSnapshot;
  /** The release published immediately before `newest`; without one there is no change to list. */
  readonly previous: Option.Option<CatalogSnapshot>;
  /** The tenant's roles and the Novinky items it already holds, so a repeated follow plans nothing twice. */
  readonly state: Pick<AccessChangesState, 'items' | 'roles'>;
  readonly tenantId: string;
}

export interface TenantReleaseFollowPlan {
  /** Capabilities the preset still holds that the newest release no longer declares: inert, reported. */
  readonly inertKeys: readonly CapabilityKey[];
  /** Pending Novinky items for the tenant's other roles; empty when it has no other role behind the release. */
  readonly items: readonly AccessChangeItem[];
  /** The preset's additions-only successor; none without a preset or when it already holds everything. */
  readonly presetEdit: Option.Option<RoleCellEdit>;
}

const decodeEdit = Schema.decodeUnknownResult(RoleCellEditSchema, ACCESS_MODEL_PARSE_OPTIONS);

/** What the preset gains: every cell "Plný přístup" holds over the newest release that it does not hold yet. */
const presetEditOf = (
  preset: RoleWithRevision,
  input: TenantReleaseFollowInput,
): Result.Result<Option.Option<RoleCellEdit>, AccessReleaseActivationError> => {
  const compiled = compileFullAccessRole(input.newest);
  if (Result.isFailure(compiled)) {
    const reasons = compiled.failure.map(({ reason }) => reason).join('; ');
    return Result.fail(refusal(`"Plný přístup" cannot be compiled over release ${input.newest.id}: ${reasons}`));
  }
  // Additions only: a release follow never removes a cell, so it can never narrow what the preset grants.
  const draft = planRoleCellEdit(
    preset,
    compiled.success.cells,
    [],
    presetFollowRevisionId(input.tenantId, preset.role.id, input.newest.id),
  );
  if (draft === undefined) {
    return Result.succeed(Option.none());
  }
  const decoded = decodeEdit(draft);
  return Result.isSuccess(decoded)
    ? Result.succeed(Option.some(decoded.success))
    : Result.fail(refusal(`the preset successor of role ${preset.role.id} is invalid`, decoded.failure));
};

/** The Novinky of the newest release for the roles that do not follow it: they adopt, or they do not. */
const itemsOf = (
  others: readonly RoleWithRevision[],
  previous: CatalogSnapshot,
  input: TenantReleaseFollowInput,
): Result.Result<readonly AccessChangeItem[], AccessReleaseActivationError> => {
  const { newest } = input;
  const drafts = diffCatalogSnapshots(previous, newest);
  if (Result.isFailure(drafts)) {
    return Result.fail(refusal(`${drafts.failure.code}: ${drafts.failure.reason}`, drafts.failure));
  }
  const blueprints = blueprintChangeItems({ drafts: drafts.success, entries: newest.entries, roles: others });
  if (Result.isFailure(blueprints)) {
    return Result.fail(refusal(`${blueprints.failure.code}: ${blueprints.failure.reason}`, blueprints.failure));
  }
  const planned = planChangeItems({
    // The affected-holder preview is computed when an administrator opens the item, never stored with it.
    assignments: [],
    blueprints: blueprints.success,
    catalogSnapshotId: newest.id,
    createdAt: input.createdAt,
    itemIds: new Map(
      blueprints.success.map(({ capabilityKey, kind }) => {
        const identity = changeItemIdentityKey(kind, capabilityKey);
        return [identity, releaseItemId(input.tenantId, newest.id, identity)] as const;
      }),
    ),
    tenantId: input.tenantId,
  });
  if (Result.isFailure(planned)) {
    return Result.fail(refusal(`${planned.failure.code}: ${planned.failure.reason}`, planned.failure));
  }
  // An item the tenant already holds for this release is the same item: it is never planned twice.
  const recorded = new Set<string>();
  for (const { capabilityKey, catalogSnapshotId, kind } of input.state.items) {
    if (catalogSnapshotId === newest.id) {
      recorded.add(changeItemIdentityKey(kind, capabilityKey));
    }
  }
  return Result.succeed(
    planned.success.items.filter(
      ({ capabilityKey, kind }) => !recorded.has(changeItemIdentityKey(kind, capabilityKey)),
    ),
  );
};

/** Capabilities the preset holds that the newest release no longer declares: inert, kept, reported. */
const inertKeysOf = (preset: Option.Option<RoleWithRevision>, newest: CatalogSnapshot): readonly CapabilityKey[] => {
  const declared = new Set<string>(newest.entries.map(({ key }) => key));
  const inert = new Set<CapabilityKey>();
  for (const { capabilityKey } of Option.match(preset, {
    onNone: () => [],
    onSome: ({ revision }) => revision.cells,
  })) {
    if (!declared.has(capabilityKey)) {
      inert.add(capabilityKey);
    }
  }
  return [...inert].toSorted();
};

/**
 * What one tenant takes from the newest release: the preset's successor and the other roles' Novinky. Pure,
 * and idempotent by construction: a tenant that already took the release plans no edit, and the items it
 * plans are the ones it already recorded.
 */
export const planTenantReleaseFollow = (
  input: TenantReleaseFollowInput,
): Result.Result<TenantReleaseFollowPlan, AccessReleaseActivationError> => {
  const preset = fullAccessPresetOf(input.state.roles);
  const others = input.state.roles.filter((role) => Option.getOrUndefined(preset) !== role);
  const presetEdit = Option.match(preset, {
    onNone: () => Result.succeed(Option.none<RoleCellEdit>()),
    onSome: (role) => presetEditOf(role, input),
  });
  if (Result.isFailure(presetEdit)) {
    return Result.fail(presetEdit.failure);
  }
  // A role created against the newest release already chose from it; only a role behind it has news.
  const behind = others.some(({ revision }) => revision.catalogSnapshotId !== input.newest.id);
  const items = Option.match(input.previous, {
    onNone: () => Result.succeed<readonly AccessChangeItem[]>([]),
    onSome: (previous) => (behind ? itemsOf(others, previous, input) : Result.succeed([])),
  });
  if (Result.isFailure(items)) {
    return Result.fail(items.failure);
  }
  return Result.succeed({
    inertKeys: inertKeysOf(preset, input.newest),
    items: items.success,
    presetEdit: presetEdit.success,
  });
};

export interface TenantReleaseReport {
  readonly inertKeys: readonly string[];
  readonly items: number;
  readonly outcome: 'failed' | 'followed' | 'planned' | 'unchanged';
  readonly presetCellsAdded: number;
  readonly reason?: string;
  readonly tenantId: string;
}

export interface CatalogReleaseActivationReport {
  readonly entries: number;
  readonly ordering: CatalogReleaseOrdering;
  readonly previousEntries: number | undefined;
  readonly releaseId: string;
  readonly tenants: readonly TenantReleaseReport[];
}

export interface ActivateCatalogReleaseInput {
  /** Plan and report without a single write. */
  readonly dryRun: boolean;
  /** Every module the deployed catalog declares (`topology/authorization-catalog.json`). */
  readonly modules: readonly AccessCatalogModule[];
}

interface FollowedRelease {
  readonly newest: CatalogSnapshot;
  readonly previous: Option.Option<CatalogSnapshot>;
}

/** The tenants a release reaches: every active one except the platform tenant, which serves no person. */
const activeTenantIds = Effect.gen(function* readActiveTenants() {
  const { executor } = yield* CoreDatabase;
  const rows = yield* executor
    .select({ tenantId: tenants.tenantId })
    .from(tenants)
    .where(eq(tenants.status, 'active'))
    .pipe(Effect.mapError((failure) => refusal('The active tenants could not be read', failure)));
  const reached: string[] = [];
  for (const { tenantId } of rows) {
    if (tenantId !== PLATFORM_TENANT.tenantId) {
      reached.push(tenantId);
    }
  }
  return reached.toSorted();
});

/** The release actor's trusted system scope; the actor exists before it is resolved, and it is resolved, never minted. */
const releaseScopeOf = Effect.fn('AccessReleaseActivation.scope')(function* releaseScopeEffect(
  tenantId: string,
  catalogSnapshotId: string,
) {
  const { executor } = yield* CoreDatabase;
  const resolved = yield* makeSystemPrincipalContextResolver({ executor })
    .resolve({
      principalId: releaseActorId(tenantId),
      registration: RELEASE_ACTIVATION_JOB,
      runReference: `release-${catalogSnapshotId}`,
      tenantId,
    })
    .pipe(Effect.mapError((failure) => refusal(`the release actor could not act: ${failure.reason}`, failure)));
  return preserveSystemPrincipalContextTrust(resolved, {
    ...resolved,
    correlationId: `access-release-activation:${catalogSnapshotId}`,
  }) satisfies OperationalScope;
});

/** A dry run reads the roles under a scope it never writes with; the release actor may not exist yet. */
const readOnlyChanges = Effect.fn('AccessReleaseActivation.readOnlyChanges')(function* readOnlyChangesEffect(
  tenantId: string,
) {
  const changes = yield* AccessChangesStore;
  const context = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: `job:${RELEASE_ACTIVATION_JOB.jobKey}:run:dry-run`,
    authMethod: 'system',
    principalId: releaseActorId(tenantId),
    tenantId,
  }).pipe(Effect.mapError((failure) => refusal('the dry-run scope is invalid', failure)));
  return yield* changes
    .loadTenantChanges({ ...context, correlationId: 'access-release-activation:dry-run' })
    .pipe(Effect.mapError((failure) => refusal(`the roles could not be read: ${failure.reason}`, failure)));
});

/** The follow as one store write: the items, and the preset's successor when there is one. */
const followInputOf = (
  scope: OperationalScope,
  release: FollowedRelease,
  plan: TenantReleaseFollowPlan,
  decidedAt: Date,
): RecordReleaseFollowInput => {
  const base = { catalogSnapshotId: release.newest.id, decidedAt, items: plan.items, scope };
  return Option.match(plan.presetEdit, { onNone: () => base, onSome: (presetEdit) => ({ ...base, presetEdit }) });
};

const reportOf = (
  tenantId: string,
  plan: TenantReleaseFollowPlan,
  outcome: TenantReleaseReport['outcome'],
): TenantReleaseReport => ({
  inertKeys: plan.inertKeys,
  items: plan.items.length,
  outcome,
  presetCellsAdded: Option.match(plan.presetEdit, { onNone: () => 0, onSome: ({ addedCells }) => addedCells.length }),
  tenantId,
});

const planFor = (tenantId: string, release: FollowedRelease, state: AccessChangesState, createdAt: Date) =>
  planTenantReleaseFollow({ createdAt, newest: release.newest, previous: release.previous, state, tenantId });

/** One tenant's dry run: the plan, never a write. */
const planTenant = Effect.fn('AccessReleaseActivation.planTenant')(function* planTenantEffect(
  tenantId: string,
  release: FollowedRelease,
) {
  const state = yield* readOnlyChanges(tenantId);
  const plan = planFor(tenantId, release, state, yield* DateTime.nowAsDate);
  return Result.isFailure(plan) ? yield* plan.failure : reportOf(tenantId, plan.success, 'planned');
});

/** One tenant's follow: its actor, its writes in one transaction, and a reconcile that always runs. */
const followTenant = Effect.fn('AccessReleaseActivation.followTenant')(function* followTenantEffect(
  tenantId: string,
  release: FollowedRelease,
) {
  const releases = yield* AccessReleaseStore;
  const changes = yield* AccessChangesStore;
  const projection = yield* AccessProjectionWriter;
  yield* releases
    .ensureReleaseActor({ displayName: RELEASE_ACTOR_DISPLAY_NAME, principalId: releaseActorId(tenantId), tenantId })
    .pipe(Effect.mapError((failure) => refusal(`${failure.code}: ${failure.reason}`, failure)));
  const scope = yield* releaseScopeOf(tenantId, release.newest.id);
  const state = yield* changes
    .loadTenantChanges(scope)
    .pipe(Effect.mapError((failure) => refusal(`the roles could not be read: ${failure.reason}`, failure)));
  const decidedAt = yield* DateTime.nowAsDate;
  const planned = planFor(tenantId, release, state, decidedAt);
  if (Result.isFailure(planned)) {
    return yield* planned.failure;
  }
  const plan = planned.success;
  const changed = Option.isSome(plan.presetEdit) || plan.items.length > 0;
  if (changed) {
    yield* releases
      .recordReleaseFollow(followInputOf(scope, release, plan, decidedAt))
      .pipe(Effect.mapError((failure) => refusal(`${failure.code}: ${failure.reason}`, failure)));
  }
  // Always: a previous activation may have recorded intent and failed before its projection was written.
  yield* projection
    .reconcileTenant({ scope })
    .pipe(Effect.mapError((failure) => refusal(`the projection could not be reconciled: ${failure.reason}`, failure)));
  return reportOf(tenantId, plan, changed ? 'followed' : 'unchanged');
});

const failedTenant = (tenantId: string, failure: AccessReleaseActivationError): TenantReleaseReport => ({
  inertKeys: [],
  items: 0,
  outcome: 'failed',
  presetCellsAdded: 0,
  reason: failure.reason,
  tenantId,
});

/**
 * Activates the deployment's access catalog (see the module note). A tenant's failure is reported and never
 * stops the others; the caller decides what a failed report means for the release.
 */
export const activateCatalogRelease = Effect.fn('AccessReleaseActivation.activate')(function* activateEffect(
  input: ActivateCatalogReleaseInput,
) {
  const releases = yield* AccessReleaseStore;
  const candidate = buildDeploymentCatalogRelease({ modules: input.modules, publishedAt: yield* DateTime.nowAsDate });
  if (Result.isFailure(candidate)) {
    return yield* refusal(`${candidate.failure.code}: ${candidate.failure.reason}`, candidate.failure);
  }
  const activation = yield* (input.dryRun ? releases.previewRelease : releases.activateRelease)(candidate.success).pipe(
    Effect.mapError((failure) => refusal(`${failure.code}: ${failure.reason}`, failure)),
  );
  const release: FollowedRelease = { newest: activation.newest, previous: activation.previous };
  // An older catalog changes no tenant; the newest release keeps serving exactly as it is.
  const reached = Match.value(activation.ordering).pipe(
    Match.tag('Superseded', () => false),
    Match.orElse(() => true),
  );
  const tenantIds = reached ? yield* activeTenantIds : [];
  const reports = yield* Effect.all(
    tenantIds.map((tenantId) =>
      (input.dryRun ? planTenant(tenantId, release) : followTenant(tenantId, release)).pipe(
        Effect.catchTag('AccessReleaseActivationError', (failure) => Effect.succeed(failedTenant(tenantId, failure))),
      ),
    ),
    { concurrency: 1 },
  );
  return {
    entries: activation.newest.entries.length,
    ordering: activation.ordering,
    previousEntries: activation.previous.pipe(
      Option.map(({ entries }) => entries.length),
      Option.getOrUndefined,
    ),
    releaseId: activation.newest.id,
    tenants: reports,
  } satisfies CatalogReleaseActivationReport;
});

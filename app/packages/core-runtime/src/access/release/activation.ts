import { eq } from 'drizzle-orm';
import { Clock, DateTime, Duration, Effect, Match, Option, Result, Schema } from 'effect';

import { TrustedPrincipalContextSchema } from '../../actions/principal-context.ts';
import {
  SystemPrincipalContextResolverFromCoreDatabase,
  registerSystemWorkload,
} from '../../auth/system-principal-context.ts';
import { preserveSystemPrincipalContextTrust } from '../../auth/system-principal-context-provenance.ts';
import type { AccessCatalogModule } from '../../authorization/access-declaration.ts';
import { CoreDatabase } from '../../db/client.ts';
import { tenantServesPeople } from '../../auth/module-credentials.ts';
import { tenants } from '../../db/schema.ts';
import type { OperationalScope } from '../../operations/context.ts';
import {
  FULL_ACCESS_ROLE_TEMPLATE_KEY,
  compileFullAccessRole,
  fullAccessPresetRoleId,
} from '../bootstrap/full-access-role.ts';
import { buildDeploymentCatalogRelease } from '../catalog/release.ts';
import type { CatalogReleaseOrdering } from '../catalog/release-ordering.ts';
import { stableUuid } from '../catalog/stable-id.ts';
import { diffCatalogSnapshots } from '../changes/catalog-diff.ts';
import { blueprintChangeItems, changeItemIdentityKey, planChangeItems } from '../changes/items.ts';
import type { ChangeItemBlueprint } from '../changes/items.ts';
import { AccessReleaseStore } from '../changes/persistence/release-store.ts';
import type { RecordReleaseFollowInput } from '../changes/persistence/release-store.ts';
import { AccessChangesStore } from '../changes/persistence/store.ts';
import type { AccessChangesState } from '../changes/persistence/store.ts';
import { RoleCellEditSchema, planRoleCellEdit } from '../changes/role-edits.ts';
import type { RoleCellEdit, RoleWithRevision } from '../changes/role-edits.ts';
import type { CapabilityKey, CatalogSnapshotId } from '../ids.ts';
import { AccessProjectionWriter, isFenceBusy } from '../intent/projection-writer.ts';
import type { TenantProjectionWrite } from '../intent/projection-writer.ts';
import type { AccessChangeItem, CatalogSnapshot } from '../model.ts';
import { ACCESS_MODEL_PARSE_OPTIONS } from '../model.ts';

/*
 * Release activation (ADR-0030, "Novinky"): what a deployment's access catalog does to every tenant when the
 * deployment activates. It runs once per activation, after the migrations and before the release takes the
 * authority (`scripts/activate-access-catalog-release.mts`, called by the migrator):
 *
 *   1. The deployment's catalog becomes the newest release when it is new and covers the newest release
 *      (`orderCatalogRelease`: nothing the newest release declares is dropped or narrowed without declared
 *      lineage), decided under one global lock. Anything else changes nothing at all, and the script reports a
 *      catalog that is not a successor as a failed activation (see `AUTHORIZATION.md` for the remedy).
 *   2. In every active tenant, "Plný přístup" (the tenant-wide role its bootstrap created, found by its derived
 *      id, never by its name, and only while no person has written a revision of it after the first) follows the
 *      newest release: an additions-only successor revision, so every holder in every company where the role is
 *      held gains exactly the new capabilities, and nothing is ever narrowed. A preset a person has changed is a
 *      role like any other: it does not follow and gets Novinky, and the tenant still takes the release. The
 *      write holds the same lock in shared mode and proves its release is still the newest, so a follow planned
 *      against a superseded release writes nothing.
 *   3. Every other role adopts nothing automatically: the changes between the release it is pinned to and the
 *      newest one are recorded as pending Novinky items for an administrator to adopt, exactly as
 *      `docs/architecture/AUTHORIZATION.md` describes.
 *   4. The tenant's projection is reconciled from intent, so the engine serves what intent now says.
 *
 * The writes are the platform's: each tenant has one `system` principal whose `platform_role` is
 * `access_release_actor`, which authors the preset's successor revision. It is never a person, holds no Role and is
 * never a v2 subject; the database accepts it as an author for exactly that successor and nothing else
 * (`core.require_role_revision_author`). Agents, service principals, workload bindings and agent write policies
 * are untouched.
 *
 * Failure is fail-closed. A tenant whose follow fails keeps its previous release, so new capabilities stay denied
 * there, and the report names it. If intent was recorded but its projection could not be written, the release
 * access verification that follows the migrator finds intent and engine apart and stops the boot before the release
 * takes the authority (`scripts/zerops/app-host.mts`, `verifyReleaseAccessIntent` before `publishSnapshot`); the
 * restarted host activates again, and this module reconciles every tenant on every activation.
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

/**
 * The tenant's untouched "Plný přístup", when it has one: the role its permission bootstrap created
 * (`fullAccessPresetRoleId`), tenant-wide, still the `full_access` template, and written after its first revision only
 * by this tenant's release actor — the same history `core.require_role_revision_author` demands. Any other role is
 * a role like every other one: it does not follow, and it gets Novinky.
 */
export const fullAccessPresetOf = (
  tenantId: string,
  roles: readonly RoleWithRevision[],
): Option.Option<RoleWithRevision> => {
  const presetId = fullAccessPresetRoleId(tenantId);
  const actorId = releaseActorId(tenantId);
  return Option.fromUndefinedOr(
    roles.find(
      ({ revision, role }) =>
        role.id === presetId &&
        role.legalEntityId === undefined &&
        revision.provenance === 'template' &&
        revision.templateKey === FULL_ACCESS_ROLE_TEMPLATE_KEY &&
        (revision.revision === 1 || revision.createdBy === actorId),
    ),
  );
};

export interface TenantReleaseFollowInput {
  readonly createdAt: Date;
  readonly newest: CatalogSnapshot;
  /**
   * The releases the tenant's other roles are pinned to. Each role's Novinky are the difference between the release
   * it is pinned to and the newest one, so a tenant that skipped a release still sees every change since.
   */
  readonly pinnedReleases: ReadonlyMap<string, CatalogSnapshot>;
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
  /** Whether the tenant has an untouched preset to follow at all (`fullAccessPresetOf`). */
  readonly presetFound: boolean;
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

/** One release's changes as Novinky blueprints, suggested to the roles pinned to that release. */
const blueprintsSince = (
  pinned: CatalogSnapshot,
  roles: readonly RoleWithRevision[],
  newest: CatalogSnapshot,
): Result.Result<readonly ChangeItemBlueprint[], AccessReleaseActivationError> => {
  const drafts = diffCatalogSnapshots(pinned, newest);
  if (Result.isFailure(drafts)) {
    return Result.fail(refusal(`${drafts.failure.code}: ${drafts.failure.reason}`, drafts.failure));
  }
  const blueprints = blueprintChangeItems({ drafts: drafts.success, entries: newest.entries, roles });
  return Result.isSuccess(blueprints)
    ? Result.succeed(blueprints.success)
    : Result.fail(refusal(`${blueprints.failure.code}: ${blueprints.failure.reason}`, blueprints.failure));
};

/** One change seen from several pinned releases is one item, suggested to every role it reaches. */
const mergeBlueprints = (groups: readonly (readonly ChangeItemBlueprint[])[]): readonly ChangeItemBlueprint[] => {
  const merged = new Map<string, ChangeItemBlueprint>();
  for (const blueprint of groups.flat()) {
    const identity = changeItemIdentityKey(blueprint.kind, blueprint.capabilityKey);
    const known = merged.get(identity);
    merged.set(
      identity,
      known === undefined
        ? blueprint
        : {
            ...known,
            suggestedRoleIds: [...new Set([...known.suggestedRoleIds, ...blueprint.suggestedRoleIds])].toSorted(),
          },
    );
  }
  return [...merged.values()];
};

/** The Novinky of the newest release for the roles that do not follow it: they adopt, or they do not. */
const itemsOf = (
  others: readonly RoleWithRevision[],
  input: TenantReleaseFollowInput,
): Result.Result<readonly AccessChangeItem[], AccessReleaseActivationError> => {
  const { newest } = input;
  // A role created against the newest release already chose from it; only a role behind it has news.
  const behind = new Map<string, RoleWithRevision[]>();
  for (const role of others) {
    const pinnedId = role.revision.catalogSnapshotId;
    if (pinnedId !== newest.id) {
      behind.set(pinnedId, [...(behind.get(pinnedId) ?? []), role]);
    }
  }
  const groups: (readonly ChangeItemBlueprint[])[] = [];
  for (const [catalogSnapshotId, roles] of behind) {
    const pinned = input.pinnedReleases.get(catalogSnapshotId);
    if (pinned === undefined) {
      return Result.fail(refusal(`release ${catalogSnapshotId}, which a role is pinned to, is not published`));
    }
    const blueprints = blueprintsSince(pinned, roles, newest);
    if (Result.isFailure(blueprints)) {
      return Result.fail(blueprints.failure);
    }
    groups.push(blueprints.success);
  }
  const blueprints = mergeBlueprints(groups);
  if (blueprints.length === 0) {
    return Result.succeed([]);
  }
  const planned = planChangeItems({
    // The affected-holder preview is computed when an administrator opens the item, never stored with it.
    assignments: [],
    blueprints,
    catalogSnapshotId: newest.id,
    createdAt: input.createdAt,
    itemIds: new Map(
      blueprints.map(({ capabilityKey, kind }) => {
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
  const preset = fullAccessPresetOf(input.tenantId, input.state.roles);
  const others = input.state.roles.filter((role) => Option.getOrUndefined(preset) !== role);
  const presetEdit = Option.match(preset, {
    onNone: () => Result.succeed(Option.none<RoleCellEdit>()),
    onSome: (role) => presetEditOf(role, input),
  });
  if (Result.isFailure(presetEdit)) {
    return Result.fail(presetEdit.failure);
  }
  const items = itemsOf(others, input);
  if (Result.isFailure(items)) {
    return Result.fail(items.failure);
  }
  return Result.succeed({
    inertKeys: inertKeysOf(preset, input.newest),
    items: items.success,
    presetEdit: presetEdit.success,
    presetFound: Option.isSome(preset),
  });
};

export interface TenantReleaseReport {
  /** Wall time of this tenant's plan or follow, its projection reconcile included. */
  readonly elapsedMillis: number;
  readonly inertKeys: readonly string[];
  readonly items: number;
  /**
   * `deferred`: another writer held the tenant's fence for the whole of this activation's waiting budget, so it was
   * not followed this deploy (nothing was recorded) and the next activation follows it. `skipped`: a tenant that
   * serves no people (the platform's own) has no access to follow or reconcile.
   */
  readonly outcome: 'deferred' | 'failed' | 'followed' | 'planned' | 'skipped' | 'unchanged';
  readonly presetCellsAdded: number;
  /** Whether the tenant had an untouched "Plný přístup" to follow; false for a tenant that failed. */
  readonly presetFound: boolean;
  readonly reason?: string;
  /** The SpiceDB relationships the reconcile touched and deleted; 0 for a plan. */
  readonly relationshipDeletions: number;
  readonly relationshipTouches: number;
  readonly tenantId: string;
}

export interface CatalogReleaseActivationReport {
  /** The release identity of the deployment's own catalog, whatever the ordering decided. */
  readonly deployedReleaseId: string;
  readonly entries: number;
  readonly ordering: CatalogReleaseOrdering;
  readonly previousEntries: number | undefined;
  readonly releaseId: string;
  readonly tenants: readonly TenantReleaseReport[];
}

export interface ActivateCatalogReleaseInput {
  /**
   * How long, across all tenants together, this activation may wait for fences other writers hold;
   * `ACTIVATION_BUSY_FENCE_BUDGET` unless a suite sets it.
   */
  readonly busyFenceBudget?: Duration.Duration;
  /** Every module the deployed catalog declares (`topology/authorization-catalog.json`). */
  readonly modules: readonly AccessCatalogModule[];
}

interface FollowedRelease {
  readonly newest: CatalogSnapshot;
  readonly previous: Option.Option<CatalogSnapshot>;
}

/** The tenants a release reaches: every active one, as the release access verification proves them. */
const activeTenantIds = Effect.gen(function* readActiveTenants() {
  const { executor } = yield* CoreDatabase;
  const rows = yield* executor
    .select({ tenantId: tenants.tenantId })
    .from(tenants)
    .where(eq(tenants.status, 'active'))
    .pipe(Effect.mapError((failure) => refusal('The active tenants could not be read', failure)));
  return rows.map(({ tenantId }) => tenantId).toSorted();
});

/** The release actor's trusted system scope; the actor exists before it is resolved, and it is resolved, never minted. */
const releaseScopeOf = Effect.fn('AccessReleaseActivation.scope')(function* releaseScopeEffect(
  tenantId: string,
  catalogSnapshotId: string,
) {
  const resolver = yield* SystemPrincipalContextResolverFromCoreDatabase;
  const resolved = yield* resolver
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

/** A dry run reads the roles under a scope it never writes with, read-only; the release actor may not exist yet. */
const readOnlyChanges = Effect.fn('AccessReleaseActivation.readOnlyChanges')(function* readOnlyChangesEffect(
  tenantId: string,
) {
  const releases = yield* AccessReleaseStore;
  const context = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authContextRef: `job:${RELEASE_ACTIVATION_JOB.jobKey}:run:dry-run`,
    authMethod: 'system',
    principalId: releaseActorId(tenantId),
    tenantId,
  }).pipe(Effect.mapError((failure) => refusal('the dry-run scope is invalid', failure)));
  return yield* releases
    .previewTenantChanges({ ...context, correlationId: 'access-release-activation:dry-run' })
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
  measured: Pick<TenantReleaseReport, 'elapsedMillis' | 'relationshipDeletions' | 'relationshipTouches'>,
): TenantReleaseReport => ({
  ...measured,
  inertKeys: plan.inertKeys,
  items: plan.items.length,
  outcome,
  presetCellsAdded: Option.match(plan.presetEdit, { onNone: () => 0, onSome: ({ addedCells }) => addedCells.length }),
  presetFound: plan.presetFound,
  tenantId,
});

/** The plan of one tenant, over the releases its other roles are actually pinned to. */
const planFor = Effect.fn('AccessReleaseActivation.planFor')(function* planForEffect(
  tenantId: string,
  release: FollowedRelease,
  state: AccessChangesState,
  createdAt: Date,
) {
  const releases = yield* AccessReleaseStore;
  const pinnedIds = new Set<CatalogSnapshotId>();
  for (const { revision } of state.roles) {
    if (revision.catalogSnapshotId !== release.newest.id) {
      pinnedIds.add(revision.catalogSnapshotId);
    }
  }
  const pinned =
    pinnedIds.size === 0
      ? []
      : yield* releases
          .loadReleases([...pinnedIds])
          .pipe(Effect.mapError((failure) => refusal(`${failure.code}: ${failure.reason}`, failure)));
  const planned = planTenantReleaseFollow({
    createdAt,
    newest: release.newest,
    pinnedReleases: new Map(pinned.map((snapshot) => [snapshot.id, snapshot] as const)),
    state,
    tenantId,
  });
  return Result.isFailure(planned) ? yield* planned.failure : planned.success;
});

/** One tenant's dry run: the plan, never a write. */
const planTenant = Effect.fn('AccessReleaseActivation.planTenant')(function* planTenantEffect(
  tenantId: string,
  release: FollowedRelease,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const state = yield* readOnlyChanges(tenantId);
  const plan = yield* planFor(tenantId, release, state, yield* DateTime.nowAsDate);
  const elapsedMillis = (yield* Clock.currentTimeMillis) - startedAt;
  return reportOf(tenantId, plan, 'planned', { elapsedMillis, relationshipDeletions: 0, relationshipTouches: 0 });
});

/**
 * How long one activation, across all its tenants together, waits for fences other writers hold (the fence sweep, a
 * live reconcile). The migrator stops the activation after five minutes, so this leaves two for the reconciles
 * themselves. A tenant whose fence stays held past it is not followed this deploy; the next activation follows it.
 */
export const ACTIVATION_BUSY_FENCE_BUDGET = Duration.minutes(3);
const ACTIVATION_BUSY_FENCE_SPACING = Duration.seconds(2);

/**
 * Reconcile, and while another writer holds the fence try again every two seconds, as long as the activation's shared
 * waiting budget (an instant, on this process's clock) allows. `None`: the budget ran out with the fence still held.
 */
const reconcileWhenFenceFree = Effect.fn('AccessReleaseActivation.reconcileWhenFenceFree')(
  function* reconcileWhenFenceFreeEffect(
    scope: OperationalScope,
    waitUntil: number,
  ): Effect.fn.Return<Option.Option<TenantProjectionWrite>, AccessReleaseActivationError, AccessProjectionWriter> {
    const projection = yield* AccessProjectionWriter;
    const written = yield* Effect.result(projection.reconcileTenant({ scope }));
    if (Result.isSuccess(written)) {
      return Option.some(written.success);
    }
    if (!isFenceBusy(written.failure)) {
      return yield* refusal(`the projection could not be reconciled: ${written.failure.reason}`, written.failure);
    }
    const now = yield* Clock.currentTimeMillis;
    if (now + Duration.toMillis(ACTIVATION_BUSY_FENCE_SPACING) > waitUntil) {
      return Option.none();
    }
    yield* Effect.sleep(ACTIVATION_BUSY_FENCE_SPACING);
    return yield* reconcileWhenFenceFree(scope, waitUntil);
  },
);

const NOT_FOLLOWED =
  'another writer held its access fence for the whole waiting budget; not followed this deploy, the next activation follows it';

const deferredTenant = (tenantId: string): TenantReleaseReport => ({
  elapsedMillis: 0,
  inertKeys: [],
  items: 0,
  outcome: 'deferred',
  presetCellsAdded: 0,
  presetFound: false,
  reason: NOT_FOLLOWED,
  relationshipDeletions: 0,
  relationshipTouches: 0,
  tenantId,
});

/**
 * One tenant's follow: its actor, a reconcile, its writes in one transaction, and a reconcile of those writes.
 *
 * The first reconcile runs before anything is recorded: it waits out another writer holding the fence, and a tenant
 * whose fence stays held past the shared budget is left exactly as it was (`deferred`), its projection still the
 * projection of its intent, which the boot's access verification requires. It also repairs a previous activation that
 * recorded intent and failed before its projection was written. A tenant the release changes is then recorded and
 * reconciled again; an unchanged one costs that one reconcile.
 */
const followTenant = Effect.fn('AccessReleaseActivation.followTenant')(function* followTenantEffect(
  tenantId: string,
  release: FollowedRelease,
  waitUntil: number,
) {
  const releases = yield* AccessReleaseStore;
  const changes = yield* AccessChangesStore;
  const startedAt = yield* Clock.currentTimeMillis;
  yield* releases
    .ensureReleaseActor({ displayName: RELEASE_ACTOR_DISPLAY_NAME, principalId: releaseActorId(tenantId), tenantId })
    .pipe(Effect.mapError((failure) => refusal(`${failure.code}: ${failure.reason}`, failure)));
  const scope = yield* releaseScopeOf(tenantId, release.newest.id);
  const before = yield* reconcileWhenFenceFree(scope, waitUntil);
  if (Option.isNone(before)) {
    return { ...deferredTenant(tenantId), elapsedMillis: (yield* Clock.currentTimeMillis) - startedAt };
  }
  const state = yield* changes
    .loadTenantChanges(scope)
    .pipe(Effect.mapError((failure) => refusal(`the roles could not be read: ${failure.reason}`, failure)));
  const decidedAt = yield* DateTime.nowAsDate;
  const plan = yield* planFor(tenantId, release, state, decidedAt);
  const changed = Option.isSome(plan.presetEdit) || plan.items.length > 0;
  if (!changed) {
    return reportOf(tenantId, plan, 'unchanged', {
      elapsedMillis: (yield* Clock.currentTimeMillis) - startedAt,
      relationshipDeletions: before.value.deletions,
      relationshipTouches: before.value.touches,
    });
  }
  yield* releases
    .recordReleaseFollow(followInputOf(scope, release, plan, decidedAt))
    .pipe(Effect.mapError((failure) => refusal(`${failure.code}: ${failure.reason}`, failure)));
  const written = yield* reconcileWhenFenceFree(scope, waitUntil);
  if (Option.isNone(written)) {
    return yield* refusal(
      'the follow was recorded, but another writer held the access fence for the rest of the waiting budget; the next reconcile of the tenant projects it',
    );
  }
  return reportOf(tenantId, plan, 'followed', {
    elapsedMillis: (yield* Clock.currentTimeMillis) - startedAt,
    relationshipDeletions: before.value.deletions + written.value.deletions,
    relationshipTouches: before.value.touches + written.value.touches,
  });
});

/** The platform tenant: no access scope, so nothing to follow; it gets no release actor either. */
const skippedTenant = (tenantId: string): TenantReleaseReport => ({
  elapsedMillis: 0,
  inertKeys: [],
  items: 0,
  outcome: 'skipped',
  presetCellsAdded: 0,
  presetFound: false,
  reason: 'no access scope; nothing to follow',
  relationshipDeletions: 0,
  relationshipTouches: 0,
  tenantId,
});

const failedTenant = (tenantId: string, failure: AccessReleaseActivationError): TenantReleaseReport => ({
  elapsedMillis: 0,
  inertKeys: [],
  items: 0,
  outcome: 'failed',
  presetCellsAdded: 0,
  presetFound: false,
  reason: failure.reason,
  relationshipDeletions: 0,
  relationshipTouches: 0,
  tenantId,
});

/** The deployment's catalog as a candidate release, and the ordering against what is published. */
const orderedRelease = Effect.fn('AccessReleaseActivation.order')(function* orderedReleaseEffect(
  input: ActivateCatalogReleaseInput,
  publish: boolean,
) {
  const releases = yield* AccessReleaseStore;
  const candidate = buildDeploymentCatalogRelease({ modules: input.modules, publishedAt: yield* DateTime.nowAsDate });
  if (Result.isFailure(candidate)) {
    return yield* refusal(`${candidate.failure.code}: ${candidate.failure.reason}`, candidate.failure);
  }
  const activation = yield* (publish ? releases.activateRelease : releases.previewRelease)(candidate.success).pipe(
    Effect.mapError((failure) => refusal(`${failure.code}: ${failure.reason}`, failure)),
  );
  // Only a published or current release reaches the tenants; anything else changes no tenant at all.
  const reached = Match.value(activation.ordering).pipe(
    Match.tags({ Current: () => true, Publish: () => true }),
    Match.orElse(() => false),
  );
  return {
    activation,
    deployedReleaseId: candidate.success.id,
    release: { newest: activation.newest, previous: activation.previous } satisfies FollowedRelease,
    tenantIds: reached ? yield* activeTenantIds : [],
  };
});

const reportOfRelease = (
  ordered: Effect.Success<ReturnType<typeof orderedRelease>>,
  tenantReports: readonly TenantReleaseReport[],
): CatalogReleaseActivationReport => ({
  deployedReleaseId: ordered.deployedReleaseId,
  entries: ordered.activation.newest.entries.length,
  ordering: ordered.activation.ordering,
  previousEntries: ordered.activation.previous.pipe(
    Option.map(({ entries }) => entries.length),
    Option.getOrUndefined,
  ),
  releaseId: ordered.activation.newest.id,
  tenants: tenantReports,
});

/**
 * Activates the deployment's access catalog (see the module note). A tenant's failure is reported and never
 * stops the others; the caller decides what a failed report means for the release.
 */
export const activateCatalogRelease = Effect.fn('AccessReleaseActivation.activate')(function* activateEffect(
  input: ActivateCatalogReleaseInput,
) {
  const ordered = yield* orderedRelease(input, true);
  // One waiting budget for the whole activation, never one per tenant.
  const waitUntil =
    (yield* Clock.currentTimeMillis) + Duration.toMillis(input.busyFenceBudget ?? ACTIVATION_BUSY_FENCE_BUDGET);
  const tenantReports = yield* Effect.all(
    ordered.tenantIds.map((tenantId) =>
      // The platform's own tenant is skipped before any waiting, reconcile or release actor; every tenant that
      // serves people goes through the budgeted follow.
      tenantServesPeople(tenantId)
        ? followTenant(tenantId, ordered.release, waitUntil).pipe(
            Effect.catchTag('AccessReleaseActivationError', (failure) =>
              Effect.succeed(failedTenant(tenantId, failure)),
            ),
          )
        : Effect.succeed(skippedTenant(tenantId)),
    ),
    { concurrency: 1 },
  );
  return reportOfRelease(ordered, tenantReports);
});

/**
 * The same decision and per-tenant plan as `activateCatalogRelease`, without a single write: nothing is published,
 * no release actor is created, no role or item is recorded and the engine is never touched, so it needs the
 * database alone. Every read runs in a read-only transaction, so PostgreSQL itself refuses a write. It takes no
 * lock: the ordering is decided against the releases as they stand, and an activation running beside it may
 * publish right after.
 */
export const planCatalogRelease = Effect.fn('AccessReleaseActivation.plan')(function* planEffect(
  input: ActivateCatalogReleaseInput,
) {
  const ordered = yield* orderedRelease(input, false);
  const tenantReports = yield* Effect.all(
    ordered.tenantIds.map((tenantId) =>
      tenantServesPeople(tenantId)
        ? planTenant(tenantId, ordered.release).pipe(
            Effect.catchTag('AccessReleaseActivationError', (failure) =>
              Effect.succeed(failedTenant(tenantId, failure)),
            ),
          )
        : Effect.succeed(skippedTenant(tenantId)),
    ),
    { concurrency: 1 },
  );
  return reportOfRelease(ordered, tenantReports);
});

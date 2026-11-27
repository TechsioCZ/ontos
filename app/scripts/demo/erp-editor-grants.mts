#!/usr/bin/env node
/**
 * App boot step of every deployment, stage and stable alike: each reviewed shop operator login edits its tenant's
 * ERP products in OntOS (/cs/katalog/produkty: rename, category, lifecycle, price, customer-group price, stock, main
 * image) through one tenant role this step owns, "Úpravy produktů z ERP". Nothing it relies on is made by hand:
 *
 * - each login in `ERP_EDITOR_LOGINS` is found as the active human Principal its staff binding names, in every
 *   tenant; a tenant whose Catalog module is not active has no ERP products, so its operator gets nothing, and a tenant
 *   owner already holds everything;
 * - the role has one stable id per tenant, so renaming it never makes a second one. It is created empty and revised to
 *   exactly `ERP_EDITOR_CAPABILITIES`, the run cells the editor and its dialogs call, through Core's own role writers
 *   (`writeRoleCreation`, `writeRoleRevision`) authored by the tenant owner; a cell added by hand is removed again;
 * - each operator holds one live tenant assignment of it, made through Core's people commands (`assignRole`).
 *
 * A second run writes nothing. An operator it cannot grant fails the run (exit 1), so the app host's boot line
 * `host.erp-editor-grants` says `failed`. The operator must already be a member of the tenant: the account setup
 * admits people, this step does not.
 *
 *   node scripts/demo/erp-editor-grants.mts
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import { Cause, Config, Console, DateTime, Effect, Exit, Layer, Match, Option, Redacted, Schema } from 'effect';

import { user } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { stableUuid } from '../../packages/core-runtime/src/access/catalog/stable-id.ts';
import { AccessChangesStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import { isActiveAssignment } from '../../packages/core-runtime/src/access/changes/preview.ts';
import {
  AccessChangesStore,
  CatalogSnapshotIdSchema,
  CellSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  planRoleRevision,
  planRoleRevisionPreview,
  writeRoleCreation,
  writeRoleRevision,
} from '../../packages/core-runtime/src/access/changes/role-revision.ts';
import type {
  CatalogSnapshot,
  Cell,
  Holder,
  RoleId,
} from '../../packages/core-runtime/src/access/changes/role-revision.ts';
import { CoreAuthorizationProjectionCompilerLive } from '../../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import { AssignmentIncarnationIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { AccessMembershipStoreLive } from '../../packages/core-runtime/src/access/intent/memberships.ts';
import { AccessPeopleStoreLive } from '../../packages/core-runtime/src/access/intent/people-store.ts';
import { AccessProjectionWriterLive } from '../../packages/core-runtime/src/access/intent/projection-writer.ts';
import { AccessTeamStoreLive } from '../../packages/core-runtime/src/access/intent/teams.ts';
import {
  TenantIntentLoader,
  TenantIntentLoaderLive,
} from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { membershipIsLive } from '../../packages/core-runtime/src/access/lifecycle/people-commands.ts';
import {
  AccessPeopleCommands,
  AccessPeopleCommandsLive,
} from '../../packages/core-runtime/src/access/lifecycle/people-service.ts';
import { AccessWriteJournalStoreLive } from '../../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import { TrustedPrincipalContextSchema } from '../../packages/core-runtime/src/actions/principal-context.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../packages/core-runtime/src/auth/staff-authentication-namespace.ts';
import { CoreDatabase, CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import { principalAuthBindings, principals, tenantModuleStates } from '../../packages/core-runtime/src/db/schema.ts';
import { loadSpiceDbConfig, SpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';

const LOG = '[erp-editor-grants]';

/** The reviewed shop operator logins: AKROS, ŠroubShop and N1 on stage. A login a deployment lacks gets nothing. */
export const ERP_EDITOR_LOGINS: readonly string[] = ['eshop@akros.demo', 'eshop@sroubarna.demo', 'admin@n1.ontos.demo'];

/** A tenant has ERP products to edit exactly while this module is active (/cs/katalog/produkty is its page). */
const CATALOG_MODULE = 'commerce.catalog';

export const ERP_EDITOR_ROLE_NAME = 'Úpravy produktů z ERP';

/** What the ERP editor (verticals/catalog/src/products-admin) and its dialogs call, each as a run cell on all records. */
export const ERP_EDITOR_CAPABILITIES: readonly string[] = [
  // The page and its navigation entry (routes/[lang]/katalog/produkty), and page-data.ts.
  'commerce.catalog.products.view',
  'commerce.catalog.navigation-products.read',
  'commerce.catalog.product-page.read',
  // page-data.ts pages RETIRED products too, which product-page.read admits only with the product detail read.
  'commerce.catalog.product-detail.read',
  // product-edit-dialog.tsx: name, lifecycle, variants and categories.
  'commerce.catalog.product.update',
  'commerce.catalog.product.retire',
  'commerce.catalog.product.reactivate',
  'commerce.catalog.variant.retire',
  'commerce.catalog.variant.reactivate',
  'commerce.catalog.sku.rename',
  'commerce.catalog.sku.assign',
  'commerce.catalog.product-localized-facts.set',
  'commerce.catalog.variant-localized-facts.set',
  'commerce.catalog.product-category-assignment.add',
  'commerce.catalog.product-category-assignment.remove',
  'commerce.catalog.product-category.create',
  'commerce.catalog.variant-axes.govern',
  'commerce.catalog.variant-combination.confirm',
  // erp-media-section.tsx: the main image.
  'commerce.catalog.catalog-media-current.read',
  'commerce.catalog.api-catalog-media-content.read',
  'commerce.catalog.catalog-media.assign',
  'commerce.catalog.catalog-media.remove',
  // erp-variant-editor.tsx and page-data.ts: the price and the customer-group prices.
  'commerce.pricing.price.read-catalog-page',
  'commerce.pricing.price.read-schedule',
  'commerce.pricing.external-price-source-authority.grant',
  'commerce.pricing.price.revise',
  // erp-variant-editor.tsx and page-data.ts: the stock.
  'commerce.inventory.catalog-variant-on-hand-page.read',
  'commerce.inventory.staff-stock-source-authority.grant',
  'commerce.inventory.source-assertion.import',
  'commerce.inventory.stock-position.receive',
  'commerce.inventory.stock-position.issue',
];

export class ErpEditorGrantsFailure extends Schema.TaggedError<ErpEditorGrantsFailure>()('ErpEditorGrantsFailure', {
  message: Schema.String,
}) {}
const failure = (message: string) => new ErpEditorGrantsFailure({ message });

/** The editor's cells in this release; a capability the release does not publish fails the step instead of shrinking it. */
export const erpEditorCells = (catalog: CatalogSnapshot) => {
  const published = new Set(catalog.entries.map(({ key }) => String(key)));
  const missing = ERP_EDITOR_CAPABILITIES.filter((key) => !published.has(key));
  if (missing.length > 0) {
    return Effect.fail(failure(`the published access catalog ${catalog.id} lacks ${missing.join(', ')}`));
  }
  return Effect.all(
    ERP_EDITOR_CAPABILITIES.map((capabilityKey) =>
      Schema.decodeUnknownEffect(CellSchema)({ capabilityKey, mode: 'run', selector: { _tag: 'all' } }).pipe(
        Effect.mapError(() => failure(`${capabilityKey} is not a role cell`)),
      ),
    ),
  );
};

interface Operator {
  readonly catalogActive: boolean;
  readonly email: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** Every tenant Principal a reviewed login signs in as: an active human named by an active staff Better Auth binding. */
const findOperators = Effect.gen(function* findOperators() {
  const { executor } = yield* CoreDatabase;
  const rows = yield* executor
    .select({
      catalogState: tenantModuleStates.state,
      email: user.email,
      principalId: principals.principalId,
      tenantId: principals.tenantId,
    })
    .from(user)
    .innerJoin(
      principalAuthBindings,
      and(
        eq(principalAuthBindings.providerSubjectId, user.id),
        eq(principalAuthBindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
        eq(principalAuthBindings.provider, 'better_auth'),
        eq(principalAuthBindings.subjectType, 'user'),
        eq(principalAuthBindings.status, 'active'),
      ),
    )
    .innerJoin(
      principals,
      and(
        eq(principals.tenantId, principalAuthBindings.tenantId),
        eq(principals.principalId, principalAuthBindings.principalId),
        eq(principals.kind, 'human'),
        eq(principals.status, 'active'),
      ),
    )
    .leftJoin(
      tenantModuleStates,
      and(eq(tenantModuleStates.tenantId, principals.tenantId), eq(tenantModuleStates.moduleKey, CATALOG_MODULE)),
    )
    .where(inArray(user.email, [...ERP_EDITOR_LOGINS]))
    .pipe(Effect.mapError(() => failure('the shop operator logins could not be read')));
  return rows.map(({ catalogState, email, principalId, tenantId }): Operator => ({
    catalogActive: catalogState === 'active',
    email,
    principalId,
    tenantId,
  }));
});

const scopeOf = (tenantId: string, principalId: string) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId: stableUuid('ontos.erp-editor-grants.auth-binding'),
    authContextRef: 'system:erp-editor-grants',
    authMethod: 'session',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'erp-editor-grants' })),
    Effect.mapError(() => failure(`tenant ${tenantId}: ${principalId} is not a trusted principal context`)),
  );

type Scope = Effect.Success<ReturnType<typeof scopeOf>>;

const RuntimeLive = Layer.unwrap(
  Effect.gen(function* erpEditorGrantsRuntime() {
    const url = yield* Config.Redacted('DATABASE_URL').pipe(Effect.mapError(() => failure('DATABASE_URL is required')));
    const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(url) }).pipe(
      Effect.mapError(() => failure('DATABASE_URL is not a runtime database address')),
    );
    const spiceDb = yield* loadSpiceDbConfig().pipe(Effect.mapError(() => failure('The SpiceDB settings are missing')));
    const database = Layer.mergeAll(
      CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration))),
      Layer.succeed(DatabaseIdentityEnrollmentContext, APP_DATABASE_IDENTITY_ENROLLMENT),
    );
    const engine = CoreAuthorizationProjectionCompilerLive.pipe(Layer.provide(Layer.succeed(SpiceDbConfig, spiceDb)));
    const stores = Layer.mergeAll(
      TenantIntentLoaderLive,
      AccessWriteJournalStoreLive,
      AccessChangesStoreLive,
      AccessMembershipStoreLive,
      AccessPeopleStoreLive,
      AccessTeamStoreLive,
    ).pipe(Layer.provideMerge(Layer.merge(database, engine)));
    const access = Layer.merge(stores, AccessProjectionWriterLive.pipe(Layer.provide(stores)));
    return AccessPeopleCommandsLive.pipe(Layer.provideMerge(access));
  }),
);

/** The tenant's ERP editor role by its stable id: created empty when absent, then revised to exactly `wanted`. */
const reconcileRole = Effect.fn('ErpEditorGrants.reconcileRole')(function* reconcileRole(
  scope: Scope,
  catalog: CatalogSnapshot,
  wanted: readonly Cell[],
) {
  const store = yield* AccessChangesStore;
  const roleId = RoleIdSchema.make(stableUuid(`ontos.erp-editor-grants.role:${scope.tenantId}`));
  const label = `tenant ${scope.tenantId}: role "${ERP_EDITOR_ROLE_NAME}" (${roleId})`;
  const load = store.loadTenantChanges(scope).pipe(
    Effect.mapError(() => failure(`${label} could not be read`)),
    Effect.map(({ roles }) => Option.fromUndefinedOr(roles.find(({ role }) => role.id === roleId))),
  );
  const existing = yield* load;
  if (Option.isNone(existing)) {
    yield* writeRoleCreation({
      catalogSnapshotId: CatalogSnapshotIdSchema.make(catalog.id),
      cells: [],
      decidedAt: yield* DateTime.nowAsDate,
      name: ERP_EDITOR_ROLE_NAME,
      scope,
      targetRevisionId: RoleRevisionIdSchema.make(
        stableUuid(`ontos.erp-editor-grants.role-revision:${roleId}:created`),
      ),
      targetRoleId: roleId,
    }).pipe(Effect.mapError((error) => failure(`${label} creation refused: ${error._tag}`)));
    yield* Console.log(`${LOG} ${label} created`);
  }
  const role = Option.isSome(existing) ? existing.value : Option.getOrUndefined(yield* load);
  if (role === undefined) {
    return yield* failure(`${label} is missing after its creation`);
  }
  const planned = {
    catalog,
    cells: wanted,
    expectedRoleRevisionId: role.revision.id,
    role,
    targetRevisionId: RoleRevisionIdSchema.make(
      stableUuid(`ontos.erp-editor-grants.role-revision:${roleId}:${role.revision.id}:${catalog.id}`),
    ),
  };
  const preview = yield* planRoleRevisionPreview({ ...planned, confirmedEffects: [] }).pipe(
    Effect.mapError(({ reason }) => failure(`${label} preview refused: ${reason}`)),
  );
  const plan = yield* planRoleRevision({
    ...planned,
    confirmedEffects: preview.dangerous.map(({ effect, slot }) => ({ effect, slot })),
  }).pipe(Effect.mapError(({ reason }) => failure(`${label} plan refused: ${reason}`)));
  if (Option.isNone(plan.edit)) {
    yield* Console.log(`${LOG} ${label} unchanged, ${String(wanted.length)} cells`);
    return roleId;
  }
  const written = yield* writeRoleRevision({
    catalogSnapshotId: CatalogSnapshotIdSchema.make(catalog.id),
    decidedAt: yield* DateTime.nowAsDate,
    edit: plan.edit.value,
    scope,
  }).pipe(Effect.mapError((error) => failure(`${label} revision refused: ${error._tag}`)));
  yield* Console.log(
    `${LOG} ${label} now ${String(wanted.length)} cells (+${String(plan.addedCells.length)} -${String(plan.removedCells.length)}), revision ${written.roleRevisionId}`,
  );
  return roleId;
});

const holdsPrincipal = (holder: Holder, principalId: string) =>
  Match.value(holder).pipe(
    Match.tag('Principal', (person) => person.principalId === principalId),
    Match.orElse(() => false),
  );

/** One live tenant assignment of the role to the operator; an assignment already live is left as it is. */
const assignOperator = Effect.fn('ErpEditorGrants.assignOperator')(function* assignOperator(
  scope: Scope,
  roleId: RoleId,
  operator: Operator,
) {
  const commands = yield* AccessPeopleCommands;
  const label = `tenant ${scope.tenantId}: ${operator.email} (${operator.principalId})`;
  const view = yield* commands
    .read(scope)
    .pipe(Effect.mapError(({ reason }) => failure(`${label}: people could not be read: ${reason}`)));
  const held = view.assignments.filter(
    (assignment) =>
      assignment.roleId === roleId &&
      assignment.scopeId === view.tenantScopeId &&
      holdsPrincipal(assignment.holder, operator.principalId),
  );
  const live = held.find((assignment) => isActiveAssignment(assignment, view.at));
  if (live !== undefined) {
    return yield* Console.log(`${LOG} ${label} already assigned (${live.incarnationId})`);
  }
  const member = view.memberships.some(
    (membership) =>
      membership.scopeId === view.tenantScopeId &&
      membership.kind === 'member' &&
      holdsPrincipal(membership.holder, operator.principalId) &&
      membershipIsLive(membership, view.at),
  );
  if (!member) {
    return yield* failure(`${label} is no live member of the tenant; the account setup admits people, not this step`);
  }
  const head = view.roles.find(({ role }) => role.id === roleId);
  if (head === undefined) {
    return yield* failure(`${label}: role ${roleId} is not in the people view`);
  }
  // Ended assignments keep their incarnation for good, so each new one is numbered after them; a retry repeats it.
  const incarnationId = AssignmentIncarnationIdSchema.make(
    stableUuid(`ontos.erp-editor-grants.assignment:${roleId}:${operator.principalId}:${String(held.length)}`),
  );
  yield* commands
    .assignRole(scope, {
      holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(operator.principalId) },
      incarnationId,
      roleId,
      roleRevisionId: head.revision.id,
      scopeId: view.tenantScopeId,
    })
    .pipe(Effect.mapError(({ code, reason }) => failure(`${label}: assignment refused (${code}): ${reason}`)));
  return yield* Console.log(`${LOG} ${label} assigned (${incarnationId})`);
});

/** One tenant with ERP products: its owner authors the role, and every operator who is not an owner is assigned it. */
const grantTenant = Effect.fn('ErpEditorGrants.grantTenant')(function* grantTenant(
  tenantId: string,
  operators: readonly Operator[],
  catalog: CatalogSnapshot,
  wanted: readonly Cell[],
) {
  const loader = yield* TenantIntentLoader;
  const [first] = operators;
  if (first === undefined) {
    return yield* Effect.void;
  }
  const intent = yield* loader
    .loadProjection(yield* scopeOf(tenantId, first.principalId))
    .pipe(Effect.mapError(() => failure(`tenant ${tenantId}: the access intent could not be read`)));
  const owners = new Set(intent.owners.map(String));
  const [owner] = intent.owners;
  if (owner === undefined) {
    return yield* failure(`tenant ${tenantId} has no owner to author the ERP editor role`);
  }
  yield* Effect.forEach(
    operators.filter(({ principalId }) => owners.has(principalId)),
    ({ email }) => Console.log(`${LOG} tenant ${tenantId}: ${email} is an owner; nothing to grant`),
    { discard: true },
  );
  const editors = operators.filter(({ principalId }) => !owners.has(principalId));
  if (editors.length === 0) {
    return yield* Effect.void;
  }
  const scope = yield* scopeOf(tenantId, String(owner));
  const roleId = yield* reconcileRole(scope, catalog, wanted);
  return yield* Effect.forEach(editors, (operator) => assignOperator(scope, roleId, operator), { discard: true });
});

export const grantErpEditors = Effect.gen(function* grantErpEditors() {
  const store = yield* AccessChangesStore;
  const published = yield* store
    .loadPublishedCatalog()
    .pipe(Effect.mapError(() => failure('the published access catalog could not be read')));
  if (Option.isNone(published)) {
    return yield* failure('no access catalog is published');
  }
  const catalog = published.value;
  const wanted = yield* erpEditorCells(catalog);
  yield* Console.log(`${LOG} catalog ${catalog.id}: ${String(wanted.length)} ERP editor cells`);
  const operators = yield* findOperators;
  yield* Effect.forEach(
    ERP_EDITOR_LOGINS.filter((email) => !operators.some((operator) => operator.email === email)),
    (email) => Console.log(`${LOG} ${email} has no staff login in this deployment; nothing to grant`),
    { discard: true },
  );
  yield* Effect.forEach(
    operators.filter(({ catalogActive }) => !catalogActive),
    ({ email, tenantId }) =>
      Console.log(`${LOG} tenant ${tenantId}: ${email} has no ERP products (Catalog is not active); nothing to grant`),
    { discard: true },
  );
  const tenants = Map.groupBy(
    operators.filter(({ catalogActive }) => catalogActive),
    ({ tenantId }) => tenantId,
  );
  const outcomes = yield* Effect.forEach([...tenants], ([tenantId, members]) =>
    grantTenant(tenantId, members, catalog, wanted).pipe(
      Effect.tapError(({ message }) => Console.error(`${LOG} FAILED ${message}`)),
      Effect.exit,
    ),
  );
  const failed = outcomes.filter(Exit.isFailure).length;
  if (failed > 0) {
    return yield* failure(`${String(failed)} of ${String(outcomes.length)} tenants with ERP products were not granted`);
  }
  return yield* Console.log(`${LOG} done`);
});

if (import.meta.main) {
  NodeRuntime.runMain(
    grantErpEditors.pipe(
      Effect.provide(RuntimeLive),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Console.error(`${LOG} FAILED: ${Cause.pretty(exit.cause)}`) : Effect.void,
      ),
    ),
  );
}

#!/usr/bin/env node
/**
 * App boot step of every deployment, stage and stable alike: each reviewed shop operator login edits its tenant's
 * ERP products in OntOS (/cs/katalog/produkty: rename, category, lifecycle, price, customer-group price, stock, main
 * image) through one tenant role this step owns, "Úpravy produktů z ERP". Nothing it relies on is made by hand:
 *
 * - each login in `ERP_EDITOR_LOGINS` is found as the active human Principal its staff binding names, in every
 *   tenant; a tenant whose Catalog module is not active has no ERP products, so its operator gets nothing, and a tenant
 *   owner already holds everything;
 * - the role exists twice, each under a stable id, so renaming it never makes a second one: a tenant role with
 *   exactly `ERP_EDITOR_TENANT_CAPABILITIES` (the calls Core decides in the tenant context), and a role of each company
 *   the operator is a live member of with exactly `ERP_EDITOR_COMPANY_CAPABILITIES` (the calls decided in the selected
 *   company: the page and its navigation entry, prices, stock, the current image). Each is created empty and revised
 *   through Core's own role writers (`writeRoleCreation`, `writeRoleRevision`) authored by the tenant owner; a cell
 *   added by hand is removed again;
 * - each operator holds one live assignment of the tenant role in the tenant context and of each company role in its
 *   company, made through Core's people commands (`assignRole`).
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
import type { AccessScopeId, LegalEntityId } from '../../packages/core-runtime/src/access/ids.ts';
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

/**
 * What the ERP editor (verticals/catalog/src/products-admin) and its dialogs call, each as a run cell on all records,
 * split by where Core decides the call. An entrypoint whose `legalEntityScope` is `optional` or `forbidden` (and every
 * page and navigation entry) is decided in the tenant context; one whose `legalEntityScope` is `required` is decided
 * in the selected company's scope, where only an assignment of a role of that company counts (O7): a tenant role's
 * cells are no authority there.
 */
export const ERP_EDITOR_TENANT_CAPABILITIES: readonly string[] = [
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
  'commerce.catalog.catalog-media.assign',
  'commerce.catalog.catalog-media.remove',
  // erp-price-groups.ts: the company's customer Price Groups and their names.
  'pricing.price-group-catalog.price-group-source-associations.read',
  'pricing.price-group-catalog.price-group.read.definition',
  // erp-variant-editor.tsx: the stock source authority and the ERP stock assertion.
  'commerce.inventory.staff-stock-source-authority.grant',
  'commerce.inventory.source-assertion.import',
];

/**
 * The editor's calls decided in the selected company (`legalEntityScope: 'required'`), held by a company role. The
 * Shell opens a page and lists its navigation entry through the company module target whenever the session has a
 * selected company, as every shop operator's session does, so the page and its navigation entry are decided there too.
 */
export const ERP_EDITOR_COMPANY_CAPABILITIES: readonly string[] = [
  // The page and its navigation entry, as the Shell's company module target asks them.
  'commerce.catalog.products.view',
  'commerce.catalog.navigation-products.read',
  // erp-media-section.tsx: the current image and its preview.
  'commerce.catalog.catalog-media-current.read',
  'commerce.catalog.api-catalog-media-content.read',
  // erp-variant-editor.tsx and page-data.ts: the price and the customer-group prices; a group the Variant has no
  // Price in gets its first one (define).
  'commerce.pricing.price.read-catalog-page',
  'commerce.pricing.price.read-schedule',
  'commerce.pricing.external-price-source-authority.grant',
  'commerce.pricing.price.revise',
  'commerce.pricing.price.define',
  // erp-variant-editor.tsx and page-data.ts: the stock.
  'commerce.inventory.catalog-variant-on-hand-page.read',
  'commerce.inventory.stock-position.receive',
  'commerce.inventory.stock-position.issue',
];

export class ErpEditorGrantsFailure extends Schema.TaggedError<ErpEditorGrantsFailure>()('ErpEditorGrantsFailure', {
  message: Schema.String,
}) {}
const failure = (message: string) => new ErpEditorGrantsFailure({ message });

/** The editor's cells in this release; a capability the release does not publish fails the step instead of shrinking it. */
export const erpEditorCells = (catalog: CatalogSnapshot, capabilities: readonly string[]) => {
  const published = new Set(catalog.entries.map(({ key }) => String(key)));
  const missing = capabilities.filter((key) => !published.has(key));
  if (missing.length > 0) {
    return Effect.fail(failure(`the published access catalog ${catalog.id} lacks ${missing.join(', ')}`));
  }
  return Effect.all(
    capabilities.map((capabilityKey) =>
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

/**
 * The ERP editor role of the tenant context (no company) or of one company, by its stable id: created empty when
 * absent, then revised to exactly `wanted`.
 */
const reconcileRole = Effect.fn('ErpEditorGrants.reconcileRole')(function* reconcileRole(
  scope: Scope,
  catalog: CatalogSnapshot,
  wanted: readonly Cell[],
  legalEntityId: LegalEntityId | undefined,
) {
  const store = yield* AccessChangesStore;
  const roleId = RoleIdSchema.make(
    stableUuid(
      legalEntityId === undefined
        ? `ontos.erp-editor-grants.role:${scope.tenantId}`
        : `ontos.erp-editor-grants.company-role:${scope.tenantId}:${legalEntityId}`,
    ),
  );
  const label = `tenant ${scope.tenantId}${legalEntityId === undefined ? '' : ` company ${legalEntityId}`}: role "${ERP_EDITOR_ROLE_NAME}" (${roleId})`;
  const load = store.loadTenantChanges(scope).pipe(
    Effect.mapError(() => failure(`${label} could not be read`)),
    Effect.map(({ roles }) => Option.fromUndefinedOr(roles.find(({ role }) => role.id === roleId))),
  );
  const existing = yield* load;
  if (Option.isSome(existing) && existing.value.role.legalEntityId !== legalEntityId) {
    return yield* failure(`${label} exists for another company`);
  }
  if (Option.isNone(existing)) {
    const creation = {
      catalogSnapshotId: CatalogSnapshotIdSchema.make(catalog.id),
      cells: [],
      decidedAt: yield* DateTime.nowAsDate,
      name: ERP_EDITOR_ROLE_NAME,
      scope,
      targetRevisionId: RoleRevisionIdSchema.make(
        stableUuid(`ontos.erp-editor-grants.role-revision:${roleId}:created`),
      ),
      targetRoleId: roleId,
    };
    yield* writeRoleCreation(legalEntityId === undefined ? creation : { ...creation, legalEntityId }).pipe(
      Effect.mapError((error) => failure(`${label} creation refused: ${error._tag}`)),
    );
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

/**
 * One live assignment of the role to the operator in one scope (the tenant context, or the company the role belongs
 * to); an assignment already live is left as it is.
 */
const assignOperator = Effect.fn('ErpEditorGrants.assignOperator')(function* assignOperator(
  scope: Scope,
  roleId: RoleId,
  operator: Operator,
  scopeId: AccessScopeId | undefined,
) {
  const commands = yield* AccessPeopleCommands;
  const view = yield* commands
    .read(scope)
    .pipe(
      Effect.mapError(({ reason }) =>
        failure(`tenant ${scope.tenantId}: ${operator.email}: people could not be read: ${reason}`),
      ),
    );
  const target = scopeId ?? view.tenantScopeId;
  const label = `tenant ${scope.tenantId} scope ${target}: ${operator.email} (${operator.principalId})`;
  const held = view.assignments.filter(
    (assignment) =>
      assignment.roleId === roleId &&
      assignment.scopeId === target &&
      holdsPrincipal(assignment.holder, operator.principalId),
  );
  const live = held.find((assignment) => isActiveAssignment(assignment, view.at));
  if (live !== undefined) {
    return yield* Console.log(`${LOG} ${label} already assigned (${live.incarnationId})`);
  }
  const member = view.memberships.some(
    (membership) =>
      membership.scopeId === target &&
      membership.kind === 'member' &&
      holdsPrincipal(membership.holder, operator.principalId) &&
      membershipIsLive(membership, view.at),
  );
  if (!member) {
    return yield* failure(`${label} is no live member of this scope; the account setup admits people, not this step`);
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
      scopeId: target,
    })
    .pipe(Effect.mapError(({ code, reason }) => failure(`${label}: assignment refused (${code}): ${reason}`)));
  return yield* Console.log(`${LOG} ${label} assigned (${incarnationId})`);
});

/** One tenant with ERP products: its owner authors the role, and every operator who is not an owner is assigned it. */
const grantTenant = Effect.fn('ErpEditorGrants.grantTenant')(function* grantTenant(
  tenantId: string,
  operators: readonly Operator[],
  catalog: CatalogSnapshot,
  wanted: { readonly company: readonly Cell[]; readonly tenant: readonly Cell[] },
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
  const roleId = yield* reconcileRole(scope, catalog, wanted.tenant, undefined);
  yield* Effect.forEach(editors, (operator) => assignOperator(scope, roleId, operator, undefined), { discard: true });
  // The calls decided in a company need a role of that company, in every company the operator is a live member of.
  const commands = yield* AccessPeopleCommands;
  const view = yield* commands
    .read(scope)
    .pipe(Effect.mapError(({ reason }) => failure(`tenant ${tenantId}: people could not be read: ${reason}`)));
  const companies = view.scopes.flatMap(({ legalEntityId, scopeId }) =>
    legalEntityId === undefined || scopeId === view.tenantScopeId ? [] : [{ legalEntityId, scopeId }],
  );
  const companiesOf = (operator: Operator) =>
    companies.filter(({ scopeId }) =>
      view.memberships.some(
        (membership) =>
          membership.scopeId === scopeId &&
          membership.kind === 'member' &&
          holdsPrincipal(membership.holder, operator.principalId) &&
          membershipIsLive(membership, view.at),
      ),
    );
  const unplaced = editors.filter((operator) => companiesOf(operator).length === 0);
  if (unplaced.length > 0) {
    return yield* failure(
      `tenant ${tenantId}: ${unplaced.map(({ email }) => email).join(', ')} is no live member of any company, so prices, stock and images stay refused; the account setup admits people, not this step`,
    );
  }
  const reached = companies.filter(({ scopeId }) =>
    editors.some((operator) => companiesOf(operator).some((company) => company.scopeId === scopeId)),
  );
  return yield* Effect.forEach(
    reached,
    ({ legalEntityId, scopeId }) =>
      Effect.gen(function* grantCompany() {
        const companyRoleId = yield* reconcileRole(scope, catalog, wanted.company, legalEntityId);
        yield* Effect.forEach(
          editors.filter((operator) => companiesOf(operator).some((company) => company.scopeId === scopeId)),
          (operator) => assignOperator(scope, companyRoleId, operator, scopeId),
          { discard: true },
        );
      }),
    { discard: true },
  );
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
  const wanted = {
    company: yield* erpEditorCells(catalog, ERP_EDITOR_COMPANY_CAPABILITIES),
    tenant: yield* erpEditorCells(catalog, ERP_EDITOR_TENANT_CAPABILITIES),
  };
  yield* Console.log(
    `${LOG} catalog ${catalog.id}: ${String(wanted.tenant.length)} tenant and ${String(wanted.company.length)} company ERP editor cells`,
  );
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

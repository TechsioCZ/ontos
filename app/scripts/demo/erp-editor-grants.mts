#!/usr/bin/env node
/**
 * App boot step of every deployment, stage and stable alike: each reviewed shop operator login edits its tenant's
 * ERP products in OntOS (/cs/katalog/produkty: rename, category, lifecycle, price, customer-group price, stock, main
 * image) through one tenant role this step owns, "Úpravy produktů z ERP". Nothing it relies on is made by hand:
 *
 * - each login in `ERP_EDITOR_LOGINS` is found as the active human Principal its staff binding names, in every
 *   tenant; a tenant whose Catalog module is not active has no ERP products, so its operator gets nothing, and a tenant
 *   owner already holds everything;
 * - a login the stage accounts bootstrap only attaches to its tenant (`attachedLogins`: a Principal and a staff
 *   binding, no access) is made a member of the company it works for (`ERP_EDITOR_ADMISSIONS`), the way an
 *   administrator does it in People: its company directory membership first, then Core's admit-member
 *   (`admitMember`), which writes its tenant and company member rows;
 * - the role exists twice, each under a stable id, so renaming it never makes a second one: a tenant role with
 *   exactly `ERP_EDITOR_TENANT_CAPABILITIES` (the calls Core decides in the tenant context), and a role of each company
 *   the operator is a live member of with exactly `ERP_EDITOR_COMPANY_CAPABILITIES` (the calls decided in the selected
 *   company: the page and its navigation entry, prices, stock, the current image). Each is created empty and revised
 *   through Core's own role writers (`writeRoleCreation`, `writeRoleRevision`) authored by the tenant owner; a cell
 *   added by hand is removed again;
 * - each operator holds one live assignment of the tenant role in the tenant context and of each company role in its
 *   company, made through Core's people commands (`assignRole`);
 * - the authority made by hand before this step owned these grants (`RETIRED_ERP_AUTHORITY`) ends through the same
 *   commands once the editor roles are held: the operators' assignments of the retired tenant role (`unassignRole`),
 *   and the retired modules' cells of the company role they were added to (`writeRoleRevision`);
 * - each operator keeps its company's customers in Zákazníci (/cs/prodej/zakaznici and a customer's detail) through a
 *   second tenant role this step owns, "Zákazníci e-shopu", with exactly `CUSTOMER_REGISTER_TENANT_CAPABILITIES`,
 *   made and assigned in the tenant context the same way, whether or not Catalog is active. The customer list, a new
 *   customer's onboarding and the pages are decided in the company, where the operator's company role "Správce
 *   e-shopu" already holds them.
 *
 * A second run writes nothing. An operator it cannot grant fails the run (exit 1), so the app host's boot line
 * `host.erp-editor-grants` says `failed`. Any other operator must already be a member of its tenant and a company: its
 * account setup admits it, this step does not.
 *
 *   node scripts/demo/erp-editor-grants.mts [--dry-run]
 *
 * With --dry-run it reads everything and prints each write it would make (`would …`) without making it.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import {
  Cause,
  Config,
  Console,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
} from 'effect';
import { Command, Flag } from 'effect/cli';

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
  Assignment,
  CatalogSnapshot,
  Cell,
  Holder,
  RoleId,
  RoleRevisionPlanRequest,
} from '../../packages/core-runtime/src/access/changes/role-revision.ts';
import { CoreAuthorizationProjectionCompilerLive } from '../../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import { AssignmentIncarnationIdSchema, LegalEntityIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import type { AccessScopeId, LegalEntityId } from '../../packages/core-runtime/src/access/ids.ts';
import {
  AccessMembershipIdSchema,
  AccessMembershipStoreLive,
} from '../../packages/core-runtime/src/access/intent/memberships.ts';
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
import type { AccessPeopleView } from '../../packages/core-runtime/src/access/lifecycle/people-service.ts';
import { AccessWriteJournalStoreLive } from '../../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import { TrustedPrincipalContextSchema } from '../../packages/core-runtime/src/actions/principal-context.ts';
import { companyMembershipManagementFromTransaction } from '../../packages/core-runtime/src/auth/company-membership-management.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../packages/core-runtime/src/auth/staff-authentication-namespace.ts';
import { CoreDatabase, CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import {
  principalAuthBindings,
  principalCompanyMemberships,
  principals,
  tenantModuleStates,
} from '../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { CompanyAffiliation } from '../../packages/core-runtime/src/permissions/company-membership.ts';
import { loadSpiceDbConfig, SpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';

const LOG = '[erp-editor-grants]';

/** The reviewed shop operator logins: AKROS, ŠroubShop and N1 on stage. A login a deployment lacks gets nothing. */
export const ERP_EDITOR_LOGINS: readonly string[] = ['eshop@akros.demo', 'eshop@sroubarna.demo', 'admin@n1.ontos.demo'];

/** AKROS, stage and stable alike: the tenant its operator logins are attached to and the one company they work for. */
const AKROS_TENANT_ID = 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9';
const AKROS_LEGAL_ENTITY_ID = 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7';

export interface ErpEditorAdmission {
  readonly email: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
}

/**
 * The company a login works for when the stage accounts bootstrap only attaches it to its tenant (`attachedLogins`),
 * so nothing else makes it a member there. Every other operator is a member through its own tenant's account setup.
 */
export const ERP_EDITOR_ADMISSIONS: readonly ErpEditorAdmission[] = [
  { email: 'eshop@akros.demo', legalEntityId: AKROS_LEGAL_ENTITY_ID, tenantId: AKROS_TENANT_ID },
];

export interface RetiredErpAuthority {
  /** Company roles, by company and exact name, whose cells of `modules` are revised out; their other cells stay. */
  readonly companyRoles: readonly { readonly legalEntityId: string; readonly name: string }[];
  readonly modules: readonly string[];
  readonly tenantId: string;
  /** Tenant roles, by exact name, whose live assignments to the operators end. */
  readonly tenantRoleNames: readonly string[];
}

/**
 * Authority made by hand on AKROS before this step owned the ERP editor's grants, which its roles replace: the tenant
 * role "AKROS ERP katalog, ceny a sklad", and the Catalog, Pricing, Inventory and Price Group cells the deleted boot
 * step `akros-erp-staff-grants.mts` added to the company role "Správce e-shopu".
 */
export const RETIRED_ERP_AUTHORITY: readonly RetiredErpAuthority[] = [
  {
    companyRoles: [{ legalEntityId: AKROS_LEGAL_ENTITY_ID, name: 'Správce e-shopu' }],
    modules: ['commerce.catalog', 'commerce.inventory', 'commerce.pricing', 'pricing.price-group-catalog'],
    tenantId: AKROS_TENANT_ID,
    tenantRoleNames: ['AKROS ERP katalog, ceny a sklad'],
  },
];

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
  // erp-categories-section.tsx: a category is renamed, and an empty one is retired.
  'commerce.catalog.product-category.rename',
  'commerce.catalog.product-category.retire',
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
  // erp-offer.ts: the company's ERP offer, from its standing price source policy and its Symmy stock source.
  'commerce.pricing.external-price-source-scopes.read',
  'integration.symmy.symmy-company-stock-source.read',
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

export const CUSTOMER_REGISTER_ROLE_NAME = 'Zákazníci e-shopu';

/**
 * What Zákazníci (verticals/party-registry/src/routes/[lang]/prodej/zakaznici) and a customer's detail call that Core
 * decides in the tenant context (`legalEntityScope: 'optional'`), each as a run cell on all records. The operator's
 * company role "Správce e-shopu" holds the same keys, but a company role is no authority in the tenant context, so
 * without these every detail read answers 403 while the list, decided in the company, loads.
 */
export const CUSTOMER_REGISTER_TENANT_CAPABILITIES: readonly string[] = [
  // customers-data.ts loadCustomerDetail: the Counterparty, the Party's identity, its contacts and its identifiers.
  'party.registry.counterparty.read',
  'party.registry.counterparty-identity.read',
  'party.registry.party.read',
  'party.registry.party-identity.read',
  'party.registry.contact-point.list',
  'party.registry.contact-point-value.list',
  'party.registry.official-identifier.read-history',
  'party.registry.official-identifier-value.read-history',
  // party-command-client.ts: the outcome of a write whose answer was lost.
  'party.registry.owned-command-result.read',
  // customers-data.ts saveCustomerFact and the bulk edit: name, archive, contacts and identifiers.
  'party.registry.party.update',
  'party.registry.party-fact.correct',
  'party.registry.party.archive',
  'party.registry.party.unarchive',
  'party.registry.contact-point.add',
  'party.registry.contact-point.update',
  'party.registry.contact-point.end',
  'party.registry.official-identifier.add',
  'party.registry.official-identifier.end',
  // customer-create-dialog.tsx: "Nový zákazník" and its ARES prefill.
  'party.registry.party.create',
  'party.registry.ares-subject.lookup',
  // customer-identity-review-panel.tsx: "Kontrola identit".
  'party.registry.duplicate-candidate.list',
  'party.registry.duplicate-candidate.read',
  'party.registry.identity-review-evidence.read',
  'party.registry.duplicate-candidate.dismiss',
  'party.registry.duplicate-candidate.request-evidence',
  'party.registry.duplicate-candidate.resolve-create',
  'party.registry.duplicate-candidate.resolve-match',
];

export class ErpEditorGrantsFailure extends Schema.TaggedError<ErpEditorGrantsFailure>()('ErpEditorGrantsFailure', {
  message: Schema.String,
}) {}
const failure = (message: string) => new ErpEditorGrantsFailure({ message });

/** Set by `--dry-run`: every write is printed as `would …` and not made. */
export const ErpEditorGrantsDryRun = Context.Reference<boolean>('@app/scripts/demo/erp-editor-grants/DryRun', {
  defaultValue: () => false,
});

/** One write, answered as Some; with --dry-run only the line naming it, answered as None. */
const write = <A, E, R>(planned: string, effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Effect.service(ErpEditorGrantsDryRun), (dryRun) =>
    dryRun
      ? Console.log(`${LOG} would ${planned}`).pipe(Effect.as(Option.none<A>()))
      : effect.pipe(Effect.map((value) => Option.some(value))),
  );

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

const scopeOf = (tenantId: string, principalId: string, legalEntityId?: LegalEntityId) => {
  const session = {
    authBindingId: stableUuid('ontos.erp-editor-grants.auth-binding'),
    authContextRef: 'system:erp-editor-grants',
    authMethod: 'session',
    principalId,
    tenantId,
  };
  return Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'erp-editor-grants' })),
    Effect.mapError(() => failure(`tenant ${tenantId}: ${principalId} is not a trusted principal context`)),
  );
};

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

type RoleHead = RoleRevisionPlanRequest['role'];

/**
 * One role revised to exactly `wanted` through Core's role writer, authored by the tenant owner; a role that already
 * holds exactly these cells is left as it is. The successor revision's id is stable over the role's head and the
 * catalog, so a retry resumes instead of forking.
 */
const reviseRole = Effect.fn('ErpEditorGrants.reviseRole')(function* reviseRole(
  scope: Scope,
  catalog: CatalogSnapshot,
  role: RoleHead,
  wanted: readonly Cell[],
  label: string,
  revisionKey: string,
) {
  const planned = {
    catalog,
    cells: wanted,
    expectedRoleRevisionId: role.revision.id,
    role,
    targetRevisionId: RoleRevisionIdSchema.make(
      stableUuid(`${revisionKey}:${role.role.id}:${role.revision.id}:${catalog.id}`),
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
    return yield* Console.log(`${LOG} ${label} unchanged, ${String(wanted.length)} cells`);
  }
  const edit = plan.edit.value;
  const change = `(+${String(plan.addedCells.length)} -${String(plan.removedCells.length)})`;
  const written = yield* write(
    `revise ${label} ${String(role.revision.cells.length)} → ${String(wanted.length)} cells ${change}`,
    DateTime.nowAsDate.pipe(
      Effect.flatMap((decidedAt) =>
        writeRoleRevision({ catalogSnapshotId: CatalogSnapshotIdSchema.make(catalog.id), decidedAt, edit, scope }),
      ),
      Effect.mapError((error) => failure(`${label} revision refused: ${error._tag}`)),
    ),
  );
  return yield* Option.match(written, {
    onNone: () => Effect.void,
    onSome: ({ roleRevisionId }) =>
      Console.log(`${LOG} ${label} now ${String(wanted.length)} cells ${change}, revision ${roleRevisionId}`),
  });
});

/** A role this step owns: its name, and the seed of its stable id. */
interface OwnedRole {
  readonly idSeed: string;
  readonly name: string;
}

/**
 * A role this step owns, of the tenant context (no company) or of one company, by its stable id: created empty when
 * absent, then revised to exactly `wanted`.
 */
const reconcileRole = Effect.fn('ErpEditorGrants.reconcileRole')(function* reconcileRole(
  scope: Scope,
  catalog: CatalogSnapshot,
  wanted: readonly Cell[],
  legalEntityId: LegalEntityId | undefined,
  owned: OwnedRole,
) {
  const store = yield* AccessChangesStore;
  const roleId = RoleIdSchema.make(stableUuid(owned.idSeed));
  const label = `tenant ${scope.tenantId}${legalEntityId === undefined ? '' : ` company ${legalEntityId}`}: role "${owned.name}" (${roleId})`;
  const load = store.loadTenantChanges(scope).pipe(
    Effect.mapError(() => failure(`${label} could not be read`)),
    Effect.map(({ roles }) => Option.fromUndefinedOr(roles.find(({ role }) => role.id === roleId))),
  );
  const existing = yield* load;
  if (Option.isSome(existing) && existing.value.role.legalEntityId !== legalEntityId) {
    return yield* failure(`${label} exists for another company`);
  }
  if (Option.isNone(existing) && (yield* Effect.service(ErpEditorGrantsDryRun))) {
    yield* Console.log(`${LOG} would create ${label} with ${String(wanted.length)} cells`);
    return roleId;
  }
  if (Option.isNone(existing)) {
    const creation = {
      catalogSnapshotId: CatalogSnapshotIdSchema.make(catalog.id),
      cells: [],
      decidedAt: yield* DateTime.nowAsDate,
      name: owned.name,
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
  yield* reviseRole(scope, catalog, role, wanted, label, 'ontos.erp-editor-grants.role-revision');
  return roleId;
});

const holdsPrincipal = (holder: Holder, principalId: string) =>
  Match.value(holder).pipe(
    Match.tag('Principal', (person) => person.principalId === principalId),
    Match.orElse(() => false),
  );

type PeopleView = Pick<AccessPeopleView, 'assignments' | 'at' | 'memberships' | 'roles' | 'scopes' | 'tenantScopeId'>;

const isLiveMember = (view: Pick<PeopleView, 'at' | 'memberships'>, principalId: string, scopeId: AccessScopeId) =>
  view.memberships.some(
    (membership) =>
      membership.scopeId === scopeId &&
      membership.kind === 'member' &&
      holdsPrincipal(membership.holder, principalId) &&
      membershipIsLive(membership, view.at),
  );

/**
 * One live assignment of the role to the operator in one scope (the tenant context, or the company the role belongs
 * to); an assignment already live is left as it is. `admitted` says this run admitted the operator to the scope, which
 * with --dry-run is not in the people view yet.
 */
const assignOperator = Effect.fn('ErpEditorGrants.assignOperator')(function* assignOperator(
  scope: Scope,
  roleId: RoleId,
  operator: Operator,
  scopeId: AccessScopeId | undefined,
  admitted: boolean,
) {
  const commands = yield* AccessPeopleCommands;
  const dryRun = yield* Effect.service(ErpEditorGrantsDryRun);
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
  if (!isLiveMember(view, operator.principalId, target) && !(dryRun && admitted)) {
    return yield* failure(
      `${label} is no live member of this scope; its account setup admits it, this step admits only ERP_EDITOR_ADMISSIONS`,
    );
  }
  const head = view.roles.find(({ role }) => role.id === roleId);
  if (head === undefined && dryRun) {
    return yield* Console.log(`${LOG} would assign ${label} the role ${roleId} this run would create`);
  }
  if (head === undefined) {
    return yield* failure(`${label}: role ${roleId} is not in the people view`);
  }
  // Ended assignments keep their incarnation for good, so each new one is numbered after them; a retry repeats it.
  const incarnationId = AssignmentIncarnationIdSchema.make(
    stableUuid(`ontos.erp-editor-grants.assignment:${roleId}:${operator.principalId}:${String(held.length)}`),
  );
  const assigned = yield* write(
    `assign ${label} role ${roleId} (${incarnationId})`,
    commands
      .assignRole(scope, {
        holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(operator.principalId) },
        incarnationId,
        roleId,
        roleRevisionId: head.revision.id,
        scopeId: target,
      })
      .pipe(Effect.mapError(({ code, reason }) => failure(`${label}: assignment refused (${code}): ${reason}`))),
  );
  return yield* Option.isSome(assigned) ? Console.log(`${LOG} ${label} assigned (${incarnationId})`) : Effect.void;
});

export interface DirectoryEntry {
  readonly affiliation: CompanyAffiliation | null;
  readonly revision: number;
  readonly status: string;
}

export interface AdmissionPlan {
  /** False when the operator already is a live member of the tenant and the company. */
  readonly admit: boolean;
  readonly companyScopeId: AccessScopeId;
  /** The company directory row to make active before admit-member, which requires it; none when it already is. */
  readonly directory: Option.Option<{ readonly affiliation: CompanyAffiliation; readonly expectedRevision: number }>;
}

/**
 * What admits the operator to its company: nothing when it is a live member of the tenant and the company already;
 * otherwise its company directory row made active (created, or moved on from an invitation) and then admit-member.
 * An ended directory row, or a company member row without the tenant's, is refused: neither is revived here.
 */
export const planAdmission = (
  view: Pick<PeopleView, 'at' | 'memberships' | 'scopes' | 'tenantScopeId'>,
  principalId: string,
  legalEntityId: string,
  directory: DirectoryEntry | undefined,
  label: string,
): Effect.Effect<AdmissionPlan, ErpEditorGrantsFailure> => {
  const company = view.scopes.find(
    (candidate) => candidate.legalEntityId === legalEntityId && candidate.scopeId !== view.tenantScopeId,
  );
  if (company === undefined) {
    return Effect.fail(failure(`${label}: company ${legalEntityId} has no access scope in this tenant`));
  }
  const inCompany = isLiveMember(view, principalId, company.scopeId);
  const inTenant = isLiveMember(view, principalId, view.tenantScopeId);
  if (inCompany && inTenant) {
    return Effect.succeed({ admit: false, companyScopeId: company.scopeId, directory: Option.none() });
  }
  if (inCompany) {
    return Effect.fail(
      failure(`${label} is a member of the company but not of the tenant; admit-member cannot repair that`),
    );
  }
  if (directory === undefined) {
    return Effect.succeed({
      admit: true,
      companyScopeId: company.scopeId,
      directory: Option.some({ affiliation: 'employee', expectedRevision: 0 }),
    });
  }
  if (directory.status === 'active') {
    return Effect.succeed({ admit: true, companyScopeId: company.scopeId, directory: Option.none() });
  }
  if (directory.status === 'invited') {
    return Effect.succeed({
      admit: true,
      companyScopeId: company.scopeId,
      directory: Option.some({
        affiliation: directory.affiliation ?? 'employee',
        expectedRevision: directory.revision,
      }),
    });
  }
  return Effect.fail(
    failure(
      `${label}: its company directory membership is ${directory.status}; an ended membership is not revived here`,
    ),
  );
};

/** The operator's company directory row, read in that company's scope as row security requires. */
const readDirectory = Effect.fn('ErpEditorGrants.readDirectory')(function* readDirectory(
  companyScope: Scope,
  legalEntityId: LegalEntityId,
  principalId: string,
  label: string,
) {
  const { executor } = yield* CoreDatabase;
  const enrollment = yield* DatabaseIdentityEnrollmentContext;
  const rows = yield* executor
    .transaction((transaction) =>
      installOperationalScope(transaction, companyScope, enrollment).pipe(
        Effect.flatMap((scoped) =>
          scoped
            .select({
              affiliation: principalCompanyMemberships.affiliation,
              revision: principalCompanyMemberships.revision,
              status: principalCompanyMemberships.status,
            })
            .from(principalCompanyMemberships)
            .where(
              and(
                eq(principalCompanyMemberships.tenantId, companyScope.tenantId),
                eq(principalCompanyMemberships.legalEntityId, legalEntityId),
                eq(principalCompanyMemberships.principalId, principalId),
              ),
            ),
        ),
      ),
    )
    .pipe(Effect.mapError((error) => failure(`${label}: the company directory could not be read (${error._tag})`)));
  const [row] = rows;
  return row;
});

/** The operator's company directory row made active through Core's company membership writer, in the company's scope. */
const setDirectory = Effect.fn('ErpEditorGrants.setDirectory')(function* setDirectory(
  companyScope: Scope,
  principalId: string,
  entry: { readonly affiliation: CompanyAffiliation; readonly expectedRevision: number },
  label: string,
) {
  const { executor } = yield* CoreDatabase;
  const enrollment = yield* DatabaseIdentityEnrollmentContext;
  return yield* executor
    .transaction((transaction) =>
      installOperationalScope(transaction, companyScope, enrollment).pipe(
        Effect.flatMap((scoped) =>
          companyMembershipManagementFromTransaction(scoped).set({
            affiliation: Option.some(entry.affiliation),
            expectedRevision: entry.expectedRevision,
            principalRef: { principalId, tenantId: companyScope.tenantId },
            status: 'active',
          }),
        ),
      ),
    )
    .pipe(
      Effect.mapError((error) => failure(`${label}: the company directory membership was refused (${error._tag})`)),
    );
});

/**
 * Makes an operator `ERP_EDITOR_ADMISSIONS` names a member of its company, the way an administrator does it in
 * People: its company directory membership first, then Core's admit-member, which writes the tenant and company member
 * rows (Core admits nobody who already holds an assignment those rows would reach, so this comes before any). Answers
 * the company scope this run admitted the operator to; none when no admission names it or it already is a member.
 */
const admitOperator = Effect.fn('ErpEditorGrants.admitOperator')(function* admitOperator(
  scope: Scope,
  operator: Operator,
) {
  const admission = ERP_EDITOR_ADMISSIONS.find(
    ({ email, tenantId }) => email === operator.email && tenantId === operator.tenantId,
  );
  if (admission === undefined) {
    return Option.none<AccessScopeId>();
  }
  const commands = yield* AccessPeopleCommands;
  const legalEntityId = LegalEntityIdSchema.make(admission.legalEntityId);
  const label = `tenant ${scope.tenantId} company ${legalEntityId}: ${operator.email} (${operator.principalId})`;
  const view = yield* commands
    .read(scope)
    .pipe(Effect.mapError(({ reason }) => failure(`${label}: people could not be read: ${reason}`)));
  const companyScope = yield* scopeOf(scope.tenantId, scope.principalId, legalEntityId);
  const directory = yield* readDirectory(companyScope, legalEntityId, operator.principalId, label);
  const plan = yield* planAdmission(view, operator.principalId, legalEntityId, directory, label);
  if (!plan.admit) {
    yield* Console.log(`${LOG} ${label} already a member of the tenant and the company`);
    return Option.none<AccessScopeId>();
  }
  if (Option.isSome(plan.directory)) {
    const entry = plan.directory.value;
    yield* write(
      `make ${label} an active ${entry.affiliation} in the company directory (revision ${String(entry.expectedRevision)})`,
      setDirectory(companyScope, operator.principalId, entry, label),
    );
  }
  // Ended member rows keep their ids for good, so each new one is numbered after them; a retry repeats it.
  const rowsIn = (scopeId: AccessScopeId) =>
    String(
      view.memberships.filter(
        (membership) =>
          membership.scopeId === scopeId &&
          membership.kind === 'member' &&
          holdsPrincipal(membership.holder, operator.principalId),
      ).length,
    );
  const admitted = yield* write(
    `admit ${label} to the tenant and the company`,
    commands
      .admitMember(scope, {
        companyMembershipId: AccessMembershipIdSchema.make(
          stableUuid(
            `ontos.erp-editor-grants.company-member:${legalEntityId}:${operator.principalId}:${rowsIn(plan.companyScopeId)}`,
          ),
        ),
        holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(operator.principalId) },
        legalEntityId,
        tenantMembershipId: AccessMembershipIdSchema.make(
          stableUuid(
            `ontos.erp-editor-grants.tenant-member:${scope.tenantId}:${operator.principalId}:${rowsIn(view.tenantScopeId)}`,
          ),
        ),
      })
      .pipe(Effect.mapError(({ code, reason }) => failure(`${label}: admission refused (${code}): ${reason}`))),
  );
  if (Option.isSome(admitted)) {
    yield* Console.log(`${LOG} ${label} admitted to the tenant and the company`);
  }
  return Option.some(plan.companyScopeId);
});

export interface RetirementPlan {
  readonly revisions: readonly { readonly cells: readonly Cell[]; readonly role: RoleHead }[];
  readonly unassignments: readonly {
    readonly assignment: Assignment;
    readonly email: string;
    readonly roleName: string;
  }[];
}

/**
 * What of `retired` is left in the tenant: the operators' live assignments of the retired tenant roles, and each
 * retired company role whose cells of the retired modules are still there, with the cells it keeps. A company holding
 * two roles of one retired name is refused rather than guessed at. Nothing left plans nothing.
 */
export const planRetirement = (
  view: Pick<PeopleView, 'assignments' | 'at' | 'roles'>,
  retired: RetiredErpAuthority,
  operators: readonly { readonly email: string; readonly principalId: string }[],
): Effect.Effect<RetirementPlan, ErpEditorGrantsFailure> => {
  const retiredRoles = new Map(
    view.roles
      .filter(({ role }) => role.legalEntityId === undefined && retired.tenantRoleNames.includes(role.name))
      .map(({ role }) => [role.id, role.name]),
  );
  const unassignments = view.assignments.flatMap((assignment) => {
    const roleName = retiredRoles.get(assignment.roleId);
    const operator = operators.find(({ principalId }) => holdsPrincipal(assignment.holder, principalId));
    return roleName !== undefined && operator !== undefined && isActiveAssignment(assignment, view.at)
      ? [{ assignment, email: operator.email, roleName }]
      : [];
  });
  const named = retired.companyRoles.map(({ legalEntityId, name }) => ({
    legalEntityId,
    name,
    roles: view.roles.filter(({ role }) => role.name === name && role.legalEntityId === legalEntityId),
  }));
  const ambiguous = named.find(({ roles }) => roles.length > 1);
  if (ambiguous !== undefined) {
    return Effect.fail(
      failure(
        `tenant ${retired.tenantId} company ${ambiguous.legalEntityId} has more than one role "${ambiguous.name}"`,
      ),
    );
  }
  const keeps = (cell: Cell) => !retired.modules.some((moduleKey) => cell.capabilityKey.startsWith(`${moduleKey}.`));
  const revisions = named.flatMap(({ roles }) =>
    roles.flatMap((role) => {
      const cells = role.revision.cells.filter(keeps);
      return cells.length === role.revision.cells.length ? [] : [{ cells, role }];
    }),
  );
  return Effect.succeed({ revisions, unassignments });
};

/**
 * Ends what `RETIRED_ERP_AUTHORITY` names for this tenant through Core's own commands, once the editor roles are
 * held: each live assignment of a retired tenant role to an operator (`unassignRole`), and the retired modules' cells
 * of each retired company role (`writeRoleRevision`, authored by the tenant owner).
 */
const retireAuthority = Effect.fn('ErpEditorGrants.retireAuthority')(function* retireAuthority(
  scope: Scope,
  catalog: CatalogSnapshot,
  editors: readonly Operator[],
) {
  const retired = RETIRED_ERP_AUTHORITY.find(({ tenantId }) => tenantId === scope.tenantId);
  if (retired === undefined) {
    return yield* Effect.void;
  }
  const commands = yield* AccessPeopleCommands;
  const view = yield* commands
    .read(scope)
    .pipe(Effect.mapError(({ reason }) => failure(`tenant ${scope.tenantId}: people could not be read: ${reason}`)));
  const plan = yield* planRetirement(view, retired, editors);
  if (plan.unassignments.length === 0 && plan.revisions.length === 0) {
    return yield* Console.log(`${LOG} tenant ${scope.tenantId}: no retired ERP authority is left`);
  }
  yield* Effect.forEach(
    plan.unassignments,
    ({ assignment, email, roleName }) =>
      Effect.gen(function* unassignRetired() {
        const label = `tenant ${scope.tenantId}: ${email} role "${roleName}" (${assignment.roleId}) assignment ${assignment.incarnationId}`;
        const ended = yield* write(
          `unassign ${label}`,
          commands
            .unassignRole(scope, { incarnationId: assignment.incarnationId })
            .pipe(
              Effect.mapError(({ code, reason }) => failure(`${label}: unassignment refused (${code}): ${reason}`)),
            ),
        );
        if (Option.isSome(ended)) {
          yield* Console.log(`${LOG} ${label} unassigned`);
        }
      }),
    { discard: true },
  );
  return yield* Effect.forEach(
    plan.revisions,
    ({ cells, role }) =>
      reviseRole(
        scope,
        catalog,
        role,
        cells,
        `tenant ${scope.tenantId} company ${String(role.role.legalEntityId)}: role "${role.role.name}" (${role.role.id})`,
        'ontos.erp-editor-grants.retired-cells',
      ),
    { discard: true },
  );
});

/**
 * The tenant owner's scope, which authors this step's roles, and the operators who are not owners: an owner already
 * holds everything, so it gets nothing. None when no operator is left.
 */
const ownerAuthoring = Effect.fn('ErpEditorGrants.ownerAuthoring')(function* ownerAuthoring(
  tenantId: string,
  operators: readonly Operator[],
) {
  const loader = yield* TenantIntentLoader;
  const [first] = operators;
  if (first === undefined) {
    return Option.none<{ readonly members: readonly Operator[]; readonly scope: Scope }>();
  }
  const intent = yield* loader
    .loadProjection(yield* scopeOf(tenantId, first.principalId))
    .pipe(Effect.mapError(() => failure(`tenant ${tenantId}: the access intent could not be read`)));
  const owners = new Set(intent.owners.map(String));
  const [owner] = intent.owners;
  if (owner === undefined) {
    return yield* failure(`tenant ${tenantId} has no owner to author the roles of this step`);
  }
  yield* Effect.forEach(
    operators.filter(({ principalId }) => owners.has(principalId)),
    ({ email }) => Console.log(`${LOG} tenant ${tenantId}: ${email} is an owner; nothing to grant`),
    { discard: true },
  );
  const members = operators.filter(({ principalId }) => !owners.has(principalId));
  if (members.length === 0) {
    return Option.none<{ readonly members: readonly Operator[]; readonly scope: Scope }>();
  }
  return Option.some({ members, scope: yield* scopeOf(tenantId, String(owner)) });
});

/** One tenant with ERP products: its owner authors the role, and every operator who is not an owner is assigned it. */
const grantTenant = Effect.fn('ErpEditorGrants.grantTenant')(function* grantTenant(
  tenantId: string,
  operators: readonly Operator[],
  catalog: CatalogSnapshot,
  wanted: { readonly company: readonly Cell[]; readonly tenant: readonly Cell[] },
) {
  const authoring = yield* ownerAuthoring(tenantId, operators);
  if (Option.isNone(authoring)) {
    return yield* Effect.void;
  }
  const { members: editors, scope } = authoring.value;
  const admissions = yield* Effect.forEach(
    editors,
    (operator) =>
      admitOperator(scope, operator).pipe(
        Effect.map(Option.map((scopeId) => [operator.principalId, scopeId] as const)),
      ),
    { concurrency: 1 },
  );
  const admittedTo = new Map(admissions.flatMap(Option.toArray));
  const roleId = yield* reconcileRole(scope, catalog, wanted.tenant, undefined, {
    idSeed: `ontos.erp-editor-grants.role:${tenantId}`,
    name: ERP_EDITOR_ROLE_NAME,
  });
  yield* Effect.forEach(
    editors,
    (operator) => assignOperator(scope, roleId, operator, undefined, admittedTo.has(operator.principalId)),
    { discard: true },
  );
  // The calls decided in a company need a role of that company, in every company the operator is a live member of.
  const commands = yield* AccessPeopleCommands;
  const view = yield* commands
    .read(scope)
    .pipe(Effect.mapError(({ reason }) => failure(`tenant ${tenantId}: people could not be read: ${reason}`)));
  const companies = view.scopes.flatMap(({ legalEntityId, scopeId }) =>
    legalEntityId === undefined || scopeId === view.tenantScopeId ? [] : [{ legalEntityId, scopeId }],
  );
  const companiesOf = (operator: Operator) =>
    companies.filter(
      ({ scopeId }) =>
        isLiveMember(view, operator.principalId, scopeId) || admittedTo.get(operator.principalId) === scopeId,
    );
  const unplaced = editors.filter((operator) => companiesOf(operator).length === 0);
  if (unplaced.length > 0) {
    return yield* failure(
      `tenant ${tenantId}: ${unplaced.map(({ email }) => email).join(', ')} is no live member of any company, so prices, stock and images stay refused; its account setup admits it, this step admits only ERP_EDITOR_ADMISSIONS`,
    );
  }
  const reached = companies.filter(({ scopeId }) =>
    editors.some((operator) => companiesOf(operator).some((company) => company.scopeId === scopeId)),
  );
  yield* Effect.forEach(
    reached,
    ({ legalEntityId, scopeId }) =>
      Effect.gen(function* grantCompany() {
        const companyRoleId = yield* reconcileRole(scope, catalog, wanted.company, legalEntityId, {
          idSeed: `ontos.erp-editor-grants.company-role:${tenantId}:${legalEntityId}`,
          name: ERP_EDITOR_ROLE_NAME,
        });
        yield* Effect.forEach(
          editors.filter((operator) => companiesOf(operator).some((company) => company.scopeId === scopeId)),
          (operator) =>
            assignOperator(scope, companyRoleId, operator, scopeId, admittedTo.get(operator.principalId) === scopeId),
          { discard: true },
        );
      }),
    { discard: true },
  );
  // The editor roles are held now, so the authority they replace can end.
  return yield* retireAuthority(scope, catalog, editors);
});

/**
 * One tenant's shop operators keep its customers: its owner authors "Zákazníci e-shopu", and every operator who is not
 * an owner holds it in the tenant context. It runs after the ERP editors, whose step admits the operators it names.
 */
const grantCustomerRegister = Effect.fn('ErpEditorGrants.grantCustomerRegister')(function* grantCustomerRegister(
  tenantId: string,
  operators: readonly Operator[],
  catalog: CatalogSnapshot,
  wanted: readonly Cell[],
) {
  const authoring = yield* ownerAuthoring(tenantId, operators);
  if (Option.isNone(authoring)) {
    return yield* Effect.void;
  }
  const { members, scope } = authoring.value;
  const roleId = yield* reconcileRole(scope, catalog, wanted, undefined, {
    idSeed: `ontos.customer-register-grants.role:${tenantId}`,
    name: CUSTOMER_REGISTER_ROLE_NAME,
  });
  return yield* Effect.forEach(members, (operator) => assignOperator(scope, roleId, operator, undefined, false), {
    discard: true,
  });
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
  if (yield* Effect.service(ErpEditorGrantsDryRun)) {
    yield* Console.log(`${LOG} dry run: nothing is written`);
  }
  const wanted = {
    company: yield* erpEditorCells(catalog, ERP_EDITOR_COMPANY_CAPABILITIES),
    tenant: yield* erpEditorCells(catalog, ERP_EDITOR_TENANT_CAPABILITIES),
  };
  const customerRegister = yield* erpEditorCells(catalog, CUSTOMER_REGISTER_TENANT_CAPABILITIES);
  yield* Console.log(
    `${LOG} catalog ${catalog.id}: ${String(wanted.tenant.length)} tenant and ${String(wanted.company.length)} company ERP editor cells, ${String(customerRegister.length)} customer register cells`,
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
  // Every shop operator keeps its company's customers, whether or not its tenant has ERP products.
  const registerOutcomes = yield* Effect.forEach(
    [...Map.groupBy(operators, ({ tenantId }) => tenantId)],
    ([tenantId, members]) =>
      grantCustomerRegister(tenantId, members, catalog, customerRegister).pipe(
        Effect.tapError(({ message }) => Console.error(`${LOG} FAILED ${message}`)),
        Effect.exit,
      ),
  );
  const failed = outcomes.filter(Exit.isFailure).length;
  const failedRegisters = registerOutcomes.filter(Exit.isFailure).length;
  if (failed > 0 || failedRegisters > 0) {
    return yield* failure(
      `${String(failed)} of ${String(outcomes.length)} tenants with ERP products and ${String(failedRegisters)} of ${String(registerOutcomes.length)} tenants with shop operators were not granted`,
    );
  }
  return yield* Console.log(`${LOG} done`);
});

/** The boot runs it without arguments; with --dry-run it only reads and prints the writes it would make. */
export const erpEditorGrantsCommand = Command.make(
  'erp-editor-grants',
  { dryRun: Flag.Boolean('dry-run').pipe(Flag.withDefault(false)) },
  ({ dryRun }) => grantErpEditors.pipe(Effect.provideService(ErpEditorGrantsDryRun, dryRun)),
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Command.run(erpEditorGrantsCommand, { version: '1.0.0' }).pipe(
      Effect.provide(RuntimeLive),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Console.error(`${LOG} FAILED: ${Cause.pretty(exit.cause)}`) : Effect.void,
      ),
    ),
  );
}

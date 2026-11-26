#!/usr/bin/env node
/**
 * Stage boot step: the AKROS e-shop operator (eshop@akros.demo) edits ERP products in OntOS (/cs/katalog/produkty:
 * rename, category, price and stock, main image). Its two AKROS roles hold every non-admin run cell of the three
 * modules that editor drives, read from the published catalog of this release, so a capability a module adds later
 * (for example the image preview read `commerce.catalog.api-catalog-media-content.read`) reaches the operator at
 * the next deploy:
 *
 * - "Správce e-shopu" (company AKROS c0c78a3e…): the company-scoped entrypoints;
 * - "AKROS ERP katalog, ceny a sklad" (tenant role): the tenant-scoped entrypoints of the same modules.
 *
 * Additive only: a cell a role holds is never removed. The write is Core's own role revision
 * (`writeRoleRevision`), authored by the AKROS tenant owner read from live intent, and projected into SpiceDB by
 * the same call. The app host runs it on every stage boot with the demo fixtures (`bootstrapStageAkrosErpGrants`);
 * outside `stage` it does nothing. A role that does not exist is reported and skipped.
 *
 *   node scripts/demo/akros-erp-staff-grants.mts
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Cause, Config, Console, DateTime, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';

import { APP_DATABASE_IDENTITY_ENROLLMENT } from '../../database/identity-enrollment.ts';
import { stableUuid } from '../../packages/core-runtime/src/access/catalog/stable-id.ts';
import { AccessChangesStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import {
  AccessChangesStore,
  CatalogSnapshotIdSchema,
  CellSchema,
  RoleRevisionIdSchema,
  planRoleRevision,
  planRoleRevisionPreview,
  writeRoleRevision,
} from '../../packages/core-runtime/src/access/changes/role-revision.ts';
import type { CatalogSnapshot, Cell } from '../../packages/core-runtime/src/access/changes/role-revision.ts';
import { CoreAuthorizationProjectionCompilerLive } from '../../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import { AccessProjectionWriterLive } from '../../packages/core-runtime/src/access/intent/projection-writer.ts';
import {
  TenantIntentLoader,
  TenantIntentLoaderLive,
} from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import { TrustedPrincipalContextSchema } from '../../packages/core-runtime/src/actions/principal-context.ts';
import { CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import { loadSpiceDbConfig, SpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';

const LOG = '[akros-erp-grants]';

export const AKROS_ERP = {
  legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
  tenantId: 'bceaa540-13eb-5508-9ac0-9ed7e40a2ee9',
} as const;

/** The modules the ERP product editor drives: Catalog (product, category, media), Pricing and Inventory. */
export const ERP_EDITOR_MODULES: readonly string[] = ['commerce.catalog', 'commerce.pricing', 'commerce.inventory'];
/** The two reviewed AKROS roles of the e-shop operator, by name; company role first. */
export const ERP_ROLES = [
  { legalEntityId: AKROS_ERP.legalEntityId, name: 'Správce e-shopu' },
  { legalEntityId: null, name: 'AKROS ERP katalog, ceny a sklad' },
] as const;

export class AkrosErpGrantsFailure extends Schema.TaggedError<AkrosErpGrantsFailure>()('AkrosErpGrantsFailure', {
  message: Schema.String,
}) {}
const failure = (message: string) => new AkrosErpGrantsFailure({ message });

/** Every non-admin run cell of the editor's modules in this release, selecting all records. */
export const erpEditorCells = (catalog: CatalogSnapshot) =>
  Effect.forEach(
    catalog.entries.filter(
      (entry) =>
        ERP_EDITOR_MODULES.includes(String(entry.moduleKey)) &&
        entry.modes.includes('run') &&
        entry.kind !== 'admin' &&
        entry.baseline === undefined &&
        entry.ephemeral === undefined,
    ),
    (entry) =>
      Schema.decodeUnknownEffect(CellSchema)({ capabilityKey: entry.key, mode: 'run', selector: { _tag: 'all' } }).pipe(
        Effect.mapError(() => failure(`catalog entry ${entry.key} is not a role cell`)),
      ),
  );

const slotOf = (cell: Cell) => `${cell.capabilityKey} ${cell.mode} ${cell.selector._tag}`;

const scopeOf = (principalId: string) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId: stableUuid('ontos.akros-erp-staff-grants.auth-binding'),
    authContextRef: 'system:akros-erp-staff-grants',
    authMethod: 'session',
    principalId,
    tenantId: AKROS_ERP.tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'akros-erp-staff-grants' })),
    Effect.mapError(() => failure('the AKROS owner scope is not a trusted principal context')),
  );

const RuntimeLive = Layer.unwrap(
  Effect.gen(function* akrosErpGrantsRuntime() {
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
    const stores = Layer.mergeAll(TenantIntentLoaderLive, AccessWriteJournalStoreLive, AccessChangesStoreLive).pipe(
      Layer.provideMerge(Layer.merge(database, engine)),
    );
    return Layer.mergeAll(stores, AccessProjectionWriterLive.pipe(Layer.provide(stores)));
  }),
);

type Scope = Effect.Success<ReturnType<typeof scopeOf>>;

/** One role: every wanted cell it lacks, added in one Core role revision; nothing is removed. */
const grantRole = Effect.fn('AkrosErpGrants.grantRole')(function* grantRole(
  scope: Scope,
  catalog: CatalogSnapshot,
  wanted: readonly Cell[],
  target: (typeof ERP_ROLES)[number],
) {
  const store = yield* AccessChangesStore;
  const changes = yield* store
    .loadTenantChanges(scope)
    .pipe(Effect.mapError(() => failure('the AKROS roles could not be read')));
  const role = changes.roles.find(
    (candidate) =>
      candidate.role.name === target.name && (candidate.role.legalEntityId ?? null) === target.legalEntityId,
  );
  if (role === undefined) {
    return yield* Console.error(`${LOG} role "${target.name}" does not exist in AKROS; skipped`);
  }
  const held = new Set(role.revision.cells.map(slotOf));
  const added = wanted.filter((cell) => !held.has(slotOf(cell)));
  if (added.length === 0) {
    return yield* Console.log(`${LOG} role "${target.name}" (${role.role.id}) already holds every ERP editor cell`);
  }
  const planned = {
    catalog,
    cells: [...role.revision.cells, ...added],
    expectedRoleRevisionId: role.revision.id,
    role,
    targetRevisionId: RoleRevisionIdSchema.make(
      stableUuid(['ontos.akros-erp-staff-grants.revision', role.role.id, role.revision.id, catalog.id].join(':')),
    ),
  };
  const preview = yield* planRoleRevisionPreview({ ...planned, confirmedEffects: [] }).pipe(
    Effect.mapError(({ reason }) => failure(`role ${role.role.id} preview refused: ${reason}`)),
  );
  const plan = yield* planRoleRevision({
    ...planned,
    confirmedEffects: preview.dangerous.map(({ effect, slot }) => ({ effect, slot })),
  }).pipe(Effect.mapError(({ reason }) => failure(`role ${role.role.id} plan refused: ${reason}`)));
  if (Option.isNone(plan.edit)) {
    return yield* Console.log(`${LOG} role "${target.name}" unchanged`);
  }
  const written = yield* writeRoleRevision({
    catalogSnapshotId: CatalogSnapshotIdSchema.make(catalog.id),
    decidedAt: yield* DateTime.nowAsDate,
    edit: plan.edit.value,
    scope,
  }).pipe(Effect.mapError((error) => failure(`role ${role.role.id} write refused: ${error._tag}`)));
  return yield* Console.log(
    `${LOG} role "${target.name}" (${role.role.id}): +${String(plan.addedCells.length)} cells, revision ${written.roleRevisionId}`,
  );
});

export const grantAkrosErpEditor = Effect.gen(function* grantAkrosErpEditor() {
  const store = yield* AccessChangesStore;
  const loader = yield* TenantIntentLoader;
  const probe = yield* scopeOf('90620f06-db0a-41ae-be48-4866258f6ea0');
  const intent = yield* loader
    .loadProjection(probe)
    .pipe(Effect.mapError(() => failure('the AKROS access intent could not be read')));
  const [owner] = intent.owners;
  if (owner === undefined) {
    return yield* failure('the AKROS tenant has no owner to author the role revision');
  }
  const scope = yield* scopeOf(String(owner));
  const published = yield* store
    .loadPublishedCatalog()
    .pipe(Effect.mapError(() => failure('the published access catalog could not be read')));
  if (Option.isNone(published)) {
    return yield* failure('no access catalog is published');
  }
  const catalog = published.value;
  const wanted = yield* erpEditorCells(catalog);
  yield* Console.log(`${LOG} catalog ${catalog.id}: ${String(wanted.length)} ERP editor cells`);
  yield* Effect.forEach(ERP_ROLES, (target) => grantRole(scope, catalog, wanted, target), { discard: true });
  return yield* Console.log(`${LOG} done`);
});

if (import.meta.main) {
  const program = Effect.gen(function* main() {
    const environment = yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT').pipe(
      Config.withDefault(''),
      Effect.orElseSucceed(() => ''),
    );
    if (environment !== 'stage') {
      return yield* Console.log(`${LOG} not stage; nothing to do`);
    }
    return yield* grantAkrosErpEditor;
  }).pipe(
    Effect.provide(RuntimeLive),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? Console.error(`${LOG} FAILED: ${Cause.pretty(exit.cause)}`) : Effect.void,
    ),
  );
  NodeRuntime.runMain(program);
}

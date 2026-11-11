import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { AccessEnforcementPortsLive } from '../../src/actions/runtime-wiring.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import {
  bootstrapScopesOf,
  tenantContextScopeId,
  writeOwnerAssignments,
} from '../../src/access/bootstrap/persistence.ts';
import { AccessChangesStoreLive, AccessReleaseStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessReleaseStore } from '../../src/access/changes/persistence/release-store.ts';
import { findRole, planRoleCellEdit } from '../../src/access/changes/role-edits.ts';
import { AccessChangesStore } from '../../src/access/changes/persistence/store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import {
  CapabilityKeySchema,
  CatalogSnapshotIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { LegalEntityId, PrincipalId, TenantId } from '../../src/access/ids.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { CellSchema } from '../../src/access/model.ts';
import type { Cell } from '../../src/access/model.ts';
import { activateCatalogRelease, releaseActorId } from '../../src/access/release/activation.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import {
  createTemplateDatabase,
  insertTenantStatement,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * Release activation end to end (ADR-0030, Novinky): a tenant bootstrapped on an older release, a deployment
 * that declares a new Action, and the real engine and gate. "Plný přístup" follows the new release in every
 * company where it is held and its holder is ALLOWED the new Action; a custom role's holder is not, and sees a
 * Novinky item instead. A repeated activation writes nothing, and an older deployment changes nothing.
 */
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const MODULE = 'billing.invoices';
const READ = 'billing.invoices.invoice.read';
const APPROVE = 'billing.invoices.invoice.approve';
const AUTHORIZE = 'billing.invoices.invoice.authorize';
const SUMMARY = 'billing.invoices.summary.read';

const readEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'billing.invoices.api.list',
  moduleKey: MODULE,
  role: 'api',
});
const summaryEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'billing.invoices.api.summary',
  moduleKey: MODULE,
  role: 'api',
});
const approveEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'billing.invoices.action.approve',
  moduleKey: MODULE,
  role: 'action',
});
const read: AccessDeclarationInput = {
  key: READ,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'invoices', level: 'basic' },
  risk: 'routine',
  selectors: [],
};
const approve: AccessDeclarationInput = {
  key: APPROVE,
  kind: 'action',
  modes: ['run', 'propose'],
  placement: { group: 'invoices', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
};

/** The deployment the tenant was bootstrapped on, and the one that adds the approval Action. */
const olderDeployment: readonly AccessCatalogModule[] = [
  { descriptors: [{ accessDeclaration: read, entrypoint: readEntrypoint }], moduleId: MODULE },
];
const newerDeployment: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      { accessDeclaration: read, entrypoint: readEntrypoint },
      { accessDeclaration: approve, entrypoint: approveEntrypoint },
    ],
    moduleId: MODULE,
  },
];

/** The guard tests' deployment: it adds a record-scoped read that declares no `all`. */
const scopedSummary: AccessDeclarationInput = { ...read, key: SUMMARY, selectors: ['assigned', 'team'] };
const guardDeployment: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      { accessDeclaration: read, entrypoint: readEntrypoint },
      { accessDeclaration: approve, entrypoint: approveEntrypoint },
      { accessDeclaration: scopedSummary, entrypoint: summaryEntrypoint },
    ],
    moduleId: MODULE,
  },
];

const readCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(read, readEntrypoint) };
const approveCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(approve, approveEntrypoint) };

const owner = PrincipalIdSchema.make(uid(2));
const clerk = PrincipalIdSchema.make(uid(3));
const companyA = LegalEntityIdSchema.make(uid(4));
const companyB = LegalEntityIdSchema.make(uid(5));
const customRole = RoleIdSchema.make(uid(40));
const customRevision = RoleRevisionIdSchema.make(uid(41));

const seedTenant = (admin: PgClient.PgClient, tenantId: TenantId) =>
  Effect.forEach(
    [
      insertTenantStatement(tenantId),
      `insert into core.legal_entities
         (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values
         ('${companyA}', '${tenantId}', 'Firma A s.r.o.', 'CZ', '11111111', 'active'),
         ('${companyB}', '${tenantId}', 'Firma B s.r.o.', 'CZ', '22222222', 'active')`,
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${tenantId}', '${owner}', 'human', 'Vlastník', 'active'),
         ('${tenantId}', '${clerk}', 'human', 'Fakturantka', 'active')`,
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
         ('${uid(6)}', '${tenantId}', '${MODULE}', 'active')`,
    ],
    (statement) => admin.unsafe(statement).pipe(Effect.orDie),
    { discard: true },
  );

const scopeFor = (tenantId: TenantId, principalId: PrincipalId, legalEntityId?: LegalEntityId) => {
  const session = {
    authBindingId: uid(300),
    authContextRef: 'session:access-release-activation:1',
    authMethod: 'session' as const,
    principalId,
    tenantId,
  };
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-release-activation' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

const decisionAt = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));

/** One tenant on its own database and a SpiceDB with the v2 schema; the composition a migrator would build. */
const withTenant = <Value, Failure, Requirements>(
  run: (tenantId: TenantId, admin: PgClient.PgClient) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* tenantScenario() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `access_release_activation_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 2,
    });
    yield* createTemplateDatabase(admin);
    const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
    yield* seedTenant(admin, tenantId);
    const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
      maxConnections: 2,
    });
    const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    yield* Effect.acquireUseRelease(
      Effect.sync(() => newSpiceDbGrpcClient(configuration)),
      (client) =>
        Effect.tryPromise(() =>
          client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
        ).pipe(Effect.orDie),
      (client) => Effect.sync(() => client.close()),
    );
    const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
    const platforms = Layer.mergeAll(
      Layer.succeed(CoreDatabase, { executor }),
      Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
      Layer.succeed(AccessProjectionCompiler, compiler),
      NodeServices.layer,
    );
    const stores = Layer.mergeAll(
      platforms,
      TenantIntentLoaderLive.pipe(Layer.provide(platforms)),
      AccessWriteJournalStoreLive.pipe(Layer.provide(platforms)),
      AccessChangesStoreLive.pipe(Layer.provide(platforms)),
      AccessReleaseStoreLive.pipe(Layer.provide(platforms)),
    );
    const base = Layer.mergeAll(
      stores,
      AccessMembershipStoreLive.pipe(Layer.provide(platforms)),
      AccessCatalogSnapshotWriterLive.pipe(Layer.provide(stores)),
      AccessProjectionWriterLive.pipe(Layer.provide(stores)),
    );
    const context = yield* Layer.build(
      Layer.mergeAll(
        base,
        TenantAccessBootstrapLive.pipe(Layer.provide(base)),
        AccessDecisionLive.pipe(Layer.provide(AccessEnforcementPortsLive), Layer.provide(base)),
      ),
    );
    return yield* run(tenantId, admin).pipe(Effect.provideContext(context));
  }).pipe(Effect.scoped);

/** The gate's answer for one person in one company, asked the way an entrypoint asks it. */
const decision = Effect.fn('test.decision')(function* decisionEffect(
  carrier: typeof readCarrier,
  scope: OperationalScope,
) {
  const gate = yield* AccessDecisionGate;
  return yield* gate.decide({
    carrier,
    legalEntityScope: scope.legalEntityId === undefined ? 'forbidden' : 'required',
    now: decisionAt,
    scope,
  });
});
const decide = (carrier: typeof readCarrier, scope: OperationalScope) =>
  Effect.map(decision(carrier, scope), ({ outcome }) => outcome);

/** A tenant bootstrapped on the older deployment, with a tenant-wide custom role held by the clerk. */
const tenantOnOlderRelease = (tenantId: TenantId, admin: PgClient.PgClient) =>
  Effect.gen(function* olderRelease() {
    const ownerScope = yield* scopeFor(tenantId, owner);
    const bootstrap = yield* TenantAccessBootstrap;
    const bootstrapped = yield* bootstrap
      .bootstrapTenantAccess({ legalEntityIds: [companyA, companyB], modules: olderDeployment, scope: ownerScope })
      .pipe(Effect.orDie);
    const cells: readonly Cell[] = [
      { capabilityKey: CapabilityKeySchema.make(READ), mode: 'run', selector: { _tag: 'all' } },
    ];
    const changes = yield* AccessChangesStore;
    yield* changes
      .recordRole({
        revision: {
          catalogSnapshotId: CatalogSnapshotIdSchema.make(bootstrapped.catalogSnapshotId),
          cells: [...cells],
          createdAt: decisionAt,
          createdBy: owner,
          id: customRevision,
          provenance: 'manual',
          revision: 1,
          roleId: customRole,
          tenantId,
        },
        role: {
          createdAt: decisionAt,
          createdBy: owner,
          id: customRole,
          name: 'Fakturace',
          tenantId,
        },
        scope: ownerScope,
      })
      .pipe(Effect.orDie);
    // The clerk belongs to the tenant, where the custom role is assigned (fixture row). The suite runs on the test
    // clock, which starts at the epoch, so every validity starts there too.
    const tenantScope = tenantContextScopeId(tenantId);
    yield* admin
      .unsafe(`insert into core.access_memberships
        (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by) values
        ('${uid(50)}', '${tenantId}', '${tenantScope}', '${clerk}', 'member', 'active', '1970-01-01T00:00:00Z'::timestamptz, '${owner}')`)
      .pipe(Effect.orDie);
    const { executor } = yield* CoreDatabase;
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    yield* writeOwnerAssignments({ enrollment, executor }, ownerScope, {
      cells,
      principalId: clerk,
      roleId: customRole,
      roleRevisionId: customRevision,
      scopes: bootstrapScopesOf(tenantId, []),
      tenantId,
      validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('1970-01-01T00:00:00Z')),
    }).pipe(Effect.orDie);
    const writer = yield* AccessProjectionWriter;
    yield* writer.reconcileTenant({ scope: ownerScope }).pipe(Effect.orDie);
    return bootstrapped;
  });

/** Whether the database refuses one statement. */
const refusedBy = (admin: PgClient.PgClient, statement: string) =>
  Effect.map(Effect.exit(admin.unsafe(statement)), Exit.isFailure);

const templateValue = (template: string | null | undefined): string => {
  if (template === undefined) {
    return `'full_access'`;
  }
  return template === null ? 'null' : `'${template}'`;
};

const decodeHeldCells = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.Struct({ cells: Schema.fromJsonString(Schema.Array(CellSchema)) })]),
);

const activate = (modules: readonly AccessCatalogModule[], tenantId: TenantId) =>
  activateCatalogRelease({ modules }).pipe(
    Effect.orDie,
    Effect.map((report) => ({
      report,
      tenant: report.tenants.find((entry) => entry.tenantId === tenantId),
    })),
  );

it.layer(NodeServices.layer)('access catalog release activation', (suite) => {
  suite.effect('lets "Plný přístup" follow a new release in every company, and gives other roles Novinky', () =>
    withTenant((tenantId, admin) =>
      Effect.gen(function* followsRelease() {
        const bootstrapped = yield* tenantOnOlderRelease(tenantId, admin);
        const ownerIn = (company: LegalEntityId) => scopeFor(tenantId, owner, company);
        const clerkInTenant = yield* scopeFor(tenantId, clerk);
        // The older release declares no approval: nobody may approve, and the clerk may read.
        expect(yield* decide(approveCarrier, yield* ownerIn(companyA))).toBe('DENIED');
        expect(yield* decide(readCarrier, clerkInTenant)).toBe('ALLOWED');

        const { report, tenant } = yield* activate(newerDeployment, tenantId);
        expect(report.ordering).toEqual({ _tag: 'Publish' });
        expect(report.entries).toBe(2);
        expect(report.previousEntries).toBe(1);
        // The approval Action declares run and propose: two new cells, in one successor of the preset.
        expect(tenant).toMatchObject({ items: 1, outcome: 'followed', presetCellsAdded: 2, presetFound: true });

        // Every holder of the preset, in the tenant and in every company where the role is held, may now approve.
        expect(yield* decide(approveCarrier, yield* scopeFor(tenantId, owner))).toBe('ALLOWED');
        expect(yield* decide(approveCarrier, yield* ownerIn(companyA))).toBe('ALLOWED');
        expect(yield* decide(approveCarrier, yield* ownerIn(companyB))).toBe('ALLOWED');
        // The custom role adopts nothing by itself: its holder is denied and reads exactly as before.
        const clerkApproval = yield* decision(approveCarrier, clerkInTenant);
        expect(clerkApproval.outcome).toBe('DENIED');
        expect(clerkApproval.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');
        expect(yield* decide(readCarrier, clerkInTenant)).toBe('ALLOWED');

        // The administrator sees the new Action as a pending Novinky item instead.
        const changes = yield* AccessChangesStore;
        const state = yield* changes.loadTenantChanges(yield* scopeFor(tenantId, owner)).pipe(Effect.orDie);
        expect(state.items.map(({ capabilityKey, kind, status }) => [capabilityKey, kind, status])).toEqual([
          [APPROVE, 'new', 'pending'],
        ]);
        // The preset stays an untouched template, its successor authored by the tenant's release actor.
        const preset = state.roles.find(({ role }) => role.id === bootstrapped.roleId);
        expect(preset?.revision).toMatchObject({
          catalogSnapshotId: report.releaseId,
          createdBy: releaseActorId(tenantId),
          provenance: 'template',
          revision: 2,
          templateKey: 'full_access',
        });
        expect(state.roles.find(({ role }) => role.id === customRole)?.revision.revision).toBe(1);
        const actor = yield* admin
          .unsafe(`select kind, status from core.principals where principal_id = '${releaseActorId(tenantId)}'`)
          .pipe(Effect.orDie);
        expect(actor).toEqual([{ kind: 'system', status: 'active' }]);
        // The release actor is never a subject of the engine: no assignment and no membership names it.
        const actorHoldings = yield* admin
          .unsafe(
            `select (select count(*) from core.access_assignments where principal_id = '${releaseActorId(tenantId)}')::int as assignments,
                    (select count(*) from core.access_memberships where principal_id = '${releaseActorId(tenantId)}')::int as memberships`,
          )
          .pipe(Effect.orDie);
        expect(actorHoldings).toEqual([{ assignments: 0, memberships: 0 }]);
      }),
    ),
  );

  suite.effect('writes nothing on a repeated activation, and an older deployment changes nothing', () =>
    withTenant((tenantId, admin) =>
      Effect.gen(function* repeatsAndOverlaps() {
        const bootstrapped = yield* tenantOnOlderRelease(tenantId, admin);
        const first = yield* activate(newerDeployment, tenantId);
        const repeated = yield* activate(newerDeployment, tenantId);
        expect(repeated.report.ordering).toEqual({ _tag: 'Current' });
        expect(repeated.report.releaseId).toBe(first.report.releaseId);
        expect(repeated.tenant).toMatchObject({ items: 0, outcome: 'unchanged', presetCellsAdded: 0 });

        // An older deployment starting again while the newer one serves: published before, superseded.
        const older = yield* activate(olderDeployment, tenantId);
        expect(older.report.ordering).toEqual({ _tag: 'PublishedBefore' });
        expect(older.report.releaseId).toBe(first.report.releaseId);
        expect(older.report.tenants).toEqual([]);

        const changes = yield* AccessChangesStore;
        const state = yield* changes.loadTenantChanges(yield* scopeFor(tenantId, owner)).pipe(Effect.orDie);
        const preset = state.roles.find(({ role }) => role.id === bootstrapped.roleId);
        expect(preset?.revision.revision).toBe(2);
        expect(preset?.revision.catalogSnapshotId).toBe(first.report.releaseId);
        expect(state.items).toHaveLength(1);
        const ownerInB = yield* scopeFor(tenantId, owner, companyB);
        expect(yield* decide(approveCarrier, ownerInB)).toBe('ALLOWED');
        expect(Option.isSome(Option.fromUndefinedOr(preset))).toBe(true);
      }),
    ),
  );

  suite.effect('leaves a preset a person changed to Novinky, and never lets a stale run cell skip an approval', () =>
    withTenant((tenantId, admin) =>
      Effect.gen(function* editedPreset() {
        const bootstrapped = yield* tenantOnOlderRelease(tenantId, admin);
        const ownerScope = yield* scopeFor(tenantId, owner);
        // The owner narrows "Plný přístup" in the role editor: the preset becomes customer-changed.
        const changes = yield* AccessChangesStore;
        const before = yield* changes.loadTenantChanges(ownerScope).pipe(Effect.orDie);
        const preset = findRole(before.roles, bootstrapped.roleId);
        if (preset === undefined) {
          return yield* Effect.die('the preset is missing');
        }
        const edit = planRoleCellEdit(preset, [], [...preset.revision.cells], uid(70));
        if (edit === undefined) {
          return yield* Effect.die('the edit changes nothing');
        }
        yield* changes
          .recordRoleRevision({
            catalogSnapshotId: CatalogSnapshotIdSchema.make(bootstrapped.catalogSnapshotId),
            decidedAt: decisionAt,
            edit: { ...edit, targetRevisionId: RoleRevisionIdSchema.make(edit.targetRevisionId) },
            scope: ownerScope,
          })
          .pipe(Effect.orDie);

        const { tenant } = yield* activate(newerDeployment, tenantId);
        expect(tenant).toMatchObject({ outcome: 'followed', presetCellsAdded: 0, presetFound: false });
        expect((tenant?.items ?? 0) > 0).toBe(true);
        const after = yield* changes.loadTenantChanges(ownerScope).pipe(Effect.orDie);
        expect(findRole(after.roles, bootstrapped.roleId)?.revision).toMatchObject({
          provenance: 'customer_changed',
          revision: 2,
        });
        expect(after.items.map(({ capabilityKey }) => capabilityKey)).toContain(APPROVE);
        expect(yield* decide(approveCarrier, yield* scopeFor(tenantId, owner, companyA))).toBe('DENIED');
        return yield* Effect.void;
      }),
    ),
  );

  suite.effect('decides the running declaration, so a mode a deployment dropped is refused whatever cells say', () =>
    withTenant((tenantId, admin) =>
      Effect.gen(function* droppedMode() {
        yield* tenantOnOlderRelease(tenantId, admin);
        yield* activate(newerDeployment, tenantId);
        const ownerInA = yield* scopeFor(tenantId, owner, companyA);
        expect(yield* decide(approveCarrier, ownerInA)).toBe('ALLOWED');
        // The same Action, now approval-only: the preset still holds its old `run` cell, and run is refused.
        const approvalOnly = {
          accessDeclaration: decodeAccessDeclarationOrThrow(
            { ...approve, modes: ['propose', 'approve'] },
            approveEntrypoint,
          ),
        };
        const refused = yield* decision(approvalOnly, ownerInA);
        expect(refused.outcome).toBe('DENIED');
        expect(refused.reasons.map(({ code }) => code)).toContain('deny.mode_unsupported');
      }),
    ),
  );

  suite.effect('never publishes an older catalog that is not a successor, and refuses a stale follow', () =>
    withTenant((tenantId, admin) =>
      Effect.gen(function* overlapping() {
        yield* tenantOnOlderRelease(tenantId, admin);
        const second = yield* activate(newerDeployment, tenantId);
        // The newest deployment renames the approval Action along declared lineage.
        const renamedDeployment: readonly AccessCatalogModule[] = [
          {
            descriptors: [
              { accessDeclaration: read, entrypoint: readEntrypoint },
              {
                accessDeclaration: { ...approve, key: AUTHORIZE, lineage: { renamedFrom: [APPROVE] } },
                entrypoint: approveEntrypoint,
              },
            ],
            moduleId: MODULE,
          },
        ];
        const renamed = yield* activate(renamedDeployment, tenantId);
        expect(renamed.report.ordering).toEqual({ _tag: 'Publish' });
        // An older deployment that never published still declares the old key and lacks the new one.
        const olderNeverPublished: readonly AccessCatalogModule[] = [
          {
            descriptors: [
              { accessDeclaration: read, entrypoint: readEntrypoint },
              { accessDeclaration: approve, entrypoint: approveEntrypoint },
              { accessDeclaration: { ...read, key: SUMMARY }, entrypoint: summaryEntrypoint },
            ],
            moduleId: MODULE,
          },
        ];
        const older = yield* activate(olderNeverPublished, tenantId);
        expect(older.report.ordering).toEqual({ _tag: 'NotASuccessor', uncoveredKeys: [AUTHORIZE] });
        expect(older.report.releaseId).toBe(renamed.report.releaseId);
        expect(older.report.tenants).toEqual([]);
        // The newer deployment restarting finds its own release current.
        const restarted = yield* activate(renamedDeployment, tenantId);
        expect(restarted.report.ordering).toEqual({ _tag: 'Current' });
        // A follow planned against a release that is no longer the newest writes nothing.
        const releases = yield* AccessReleaseStore;
        const stale = yield* Effect.flip(
          releases.recordReleaseFollow({
            catalogSnapshotId: CatalogSnapshotIdSchema.make(second.report.releaseId),
            decidedAt: decisionAt,
            items: [],
            scope: yield* scopeFor(tenantId, owner),
          }),
        );
        expect(stale.code).toBe('access_changes_catalog_conflict');
      }),
    ),
  );

  suite.effect('the database accepts a system author only for the release actor extending the untouched preset', () =>
    withTenant((tenantId, admin) =>
      Effect.gen(function* databaseGuard() {
        const bootstrapped = yield* tenantOnOlderRelease(tenantId, admin);
        const { report } = yield* activate(guardDeployment, tenantId);
        const actor = releaseActorId(tenantId);
        const rows = (sql: string) => admin.unsafe(sql).pipe(Effect.orDie);
        const refused = (statement: string) => refusedBy(admin, statement);
        const [{ cells: held }] = decodeHeldCells(
          yield* rows(
            `select cells_json::text as cells from core.access_role_revisions
               where role_id = '${bootstrapped.roleId}' and revision = 2`,
          ),
        );
        const revision = (input: {
          readonly author: string;
          readonly cells: readonly unknown[];
          readonly id: number;
          readonly number: number;
          readonly provenance?: string;
          readonly release?: string;
          readonly role?: string;
          readonly template?: string | null;
        }) => {
          const template = templateValue(input.template);
          return `insert into core.access_role_revisions
            (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance, template_key)
            values ('${uid(input.id)}', '${tenantId}', '${input.role ?? bootstrapped.roleId}', ${String(input.number)},
                    '${input.release ?? report.releaseId}', '${JSON.stringify(input.cells)}'::jsonb, '${input.author}',
                    '${input.provenance ?? 'template'}', ${template})`;
        };
        // Other principals the tests try as authors.
        yield* rows(`insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
          ('${tenantId}', '${uid(80)}', 'system', 'Jiný systém', 'active'),
          ('${tenantId}', '${uid(81)}', 'service', 'Služba', 'active')`);
        const otherTenant = TenantIdSchema.make(uid(90));
        yield* rows(insertTenantStatement(otherTenant));
        yield* rows(`insert into core.principals (tenant_id, principal_id, kind, display_name, status, platform_role) values
          ('${otherTenant}', '${uid(91)}', 'system', 'Cizí aktér', 'active', 'access_release_actor')`);
        const extra = { capabilityKey: READ, mode: 'run', selector: { _tag: 'assigned' } };
        // A role a person created, a portal role and editor-created roles, each with a first human revision.
        const roles: readonly (readonly [number, string, string | null])[] = [
          [60, 'manual', null],
          [61, 'template', 'commerce.portal'],
          [62, 'template', 'blank'],
          [63, 'template', 'catalog-full-access'],
          [64, 'template', `copy:${bootstrapped.roleId}`],
        ];
        for (const [id, provenance, template] of roles) {
          yield* rows(`insert into core.access_roles (role_id, tenant_id, name, created_by) values
            ('${uid(id)}', '${tenantId}', 'Role ${String(id)}', '${owner}')`);
          yield* rows(
            revision({ author: owner, cells: held, id: id + 100, number: 1, provenance, role: uid(id), template }),
          );
          expect(yield* refused(revision({ author: actor, cells: held, id: id + 200, number: 2, role: uid(id) }))).toBe(
            true,
          );
          expect(
            yield* refused(
              revision({ author: actor, cells: held, id: id + 300, number: 2, provenance, role: uid(id), template }),
            ),
          ).toBe(true);
        }
        // A preset a person changed stops qualifying for good.
        yield* rows(`insert into core.access_roles (role_id, tenant_id, name, created_by) values
          ('${uid(65)}', '${tenantId}', 'Upravený', '${owner}')`);
        yield* rows(revision({ author: owner, cells: held, id: 165, number: 1, role: uid(65) }));
        yield* rows(
          revision({ author: owner, cells: held, id: 265, number: 2, provenance: 'customer_changed', role: uid(65) }),
        );
        expect(yield* refused(revision({ author: actor, cells: held, id: 365, number: 3, role: uid(65) }))).toBe(true);
        // On the preset itself: narrowing, a capability the release does not declare, an older release.
        expect(yield* refused(revision({ author: actor, cells: held.slice(1), id: 400, number: 3 }))).toBe(true);
        const ghost = { capabilityKey: 'billing.invoices.invoice.ghost', mode: 'run', selector: { _tag: 'all' } };
        expect(yield* refused(revision({ author: actor, cells: [...held, ghost], id: 401, number: 3 }))).toBe(true);
        expect(yield* refused(revision({ author: actor, cells: [...held, extra], id: 402, number: 3 }))).toBe(true);
        expect(
          yield* refused(
            revision({ author: actor, cells: held, id: 403, number: 3, release: bootstrapped.catalogSnapshotId }),
          ),
        ).toBe(true);
        // Authors that are not this tenant's release actor.
        for (const [author, id] of [
          [uid(80), 404],
          [uid(81), 405],
          [uid(91), 406],
        ] as const) {
          expect(yield* refused(revision({ author, cells: held, id, number: 3 }))).toBe(true);
        }
        // Added cells: exactly {capabilityKey, mode, selector: {_tag}}, a declared selector (`all` only where the
        // capability declares it or no selector at all), and every slot once.
        // The preset already holds the widest declared selector (`team`); `assigned` is a declared slot it lacks.
        const team = { capabilityKey: SUMMARY, mode: 'run', selector: { _tag: 'assigned' } };
        const addedCells: readonly (readonly [number, readonly unknown[]])[] = [
          [410, [...held, { capabilityKey: SUMMARY, mode: 'run', selector: { _tag: 'all' } }]],
          [411, [...held, { ...team, note: 'extra' }]],
          [412, [...held, { ...team, selector: { _tag: 'assigned', recordKeys: ['a'] } }]],
          [413, [...held, { ...team, selector: { _tag: 'targets', recordKeys: ['a'] } }]],
          [414, [...held, team, team]],
          [415, [...held, { ...team, amountCeiling: { currency: 'CZK', limitMinor: 1 } }]],
        ];
        for (const [id, cells] of addedCells) {
          expect(yield* refused(revision({ author: actor, cells, id, number: 3 }))).toBe(true);
        }
        // The one write it accepts: the untouched preset kept field for field, gaining a declared slot.
        expect(yield* refused(revision({ author: actor, cells: [...held, team], id: 416, number: 3 }))).toBe(false);
        // A person's later revision ends "untouched" whatever provenance it claims: no follow on top of it.
        const changed = held.filter((cell) => cell.capabilityKey !== APPROVE);
        yield* rows(revision({ author: owner, cells: changed, id: 417, number: 4 }));
        expect(yield* refused(revision({ author: actor, cells: changed, id: 418, number: 5 }))).toBe(true);
        expect(yield* refused(revision({ author: actor, cells: [...changed, team], id: 419, number: 5 }))).toBe(true);

        // An amount ceiling a preset held from its first revision may never be narrowed.
        const capped = {
          amountCeiling: { currency: 'CZK', limitMinor: 100_000 },
          capabilityKey: APPROVE,
          mode: 'run',
          selector: { _tag: 'all' },
        };
        const withCeiling = [
          ...held.filter((cell) => !(cell.capabilityKey === APPROVE && cell.mode === 'run')),
          capped,
        ];
        yield* rows(`insert into core.access_roles (role_id, tenant_id, name, created_by) values
          ('${uid(66)}', '${tenantId}', 'Se stropem', '${owner}')`);
        yield* rows(revision({ author: owner, cells: withCeiling, id: 166, number: 1, role: uid(66) }));
        const narrowed = withCeiling.map((cell) =>
          cell === capped ? { ...capped, amountCeiling: { currency: 'CZK', limitMinor: 1 } } : cell,
        );
        expect(yield* refused(revision({ author: actor, cells: narrowed, id: 266, number: 2, role: uid(66) }))).toBe(
          true,
        );
        expect(yield* refused(revision({ author: actor, cells: withCeiling, id: 366, number: 2, role: uid(66) }))).toBe(
          false,
        );

        // The release actor's own row: no status change while the tenant is active or suspended, no other status
        // than archived, no kind, tenant or disabled-time change, no role change, no delete.
        const actorUpdate = (set: string) => `update core.principals set ${set} where principal_id = '${actor}'`;
        expect(yield* refused(actorUpdate(`status = 'disabled'`))).toBe(true);
        expect(yield* refused(actorUpdate(`status = 'archived'`))).toBe(true);
        expect(yield* refused(actorUpdate('platform_role = null'))).toBe(true);
        expect(yield* refused(actorUpdate(`kind = 'service', platform_role = null`))).toBe(true);
        expect(yield* refused(actorUpdate('disabled_at = now()'))).toBe(true);
        expect(yield* refused(actorUpdate(`tenant_id = '${otherTenant}'`))).toBe(true);
        expect(
          yield* refused(
            `update core.principals set platform_role = 'access_release_actor' where principal_id = '${owner}'`,
          ),
        ).toBe(true);
        // Once it authored a revision, the revision keeps it: it cannot be deleted either.
        expect(yield* refused(`delete from core.principals where principal_id = '${actor}'`)).toBe(true);
        // Other system principals are kept the same way.
        expect(yield* refused(`update core.principals set status = 'disabled' where principal_id = '${uid(80)}'`)).toBe(
          true,
        );
        // A suspended tenant has not ended.
        yield* rows(`update core.tenants set status = 'suspended' where tenant_id = '${tenantId}'`);
        expect(yield* refused(actorUpdate(`status = 'archived'`))).toBe(true);
        // A tenant that has ended may archive it, and only archive it.
        yield* rows(`update core.tenants set status = 'archived' where tenant_id = '${tenantId}'`);
        expect(yield* refused(actorUpdate(`status = 'disabled'`))).toBe(true);
        expect(yield* refused(actorUpdate('disabled_at = now()'))).toBe(true);
        expect(yield* refused(actorUpdate(`status = 'archived'`))).toBe(false);
      }),
    ),
  );
});

import { sql } from 'drizzle-orm';
import { Context, Crypto, DateTime, Effect, FileSystem, Layer, Match, Path, Redacted, Schema } from 'effect';

import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../access/bootstrap/bootstrap-tenant-access.ts';
import { compileFullAccessRole } from '../access/bootstrap/full-access-role.ts';
import { bootstrapScopesOf, writeBootstrapScopes } from '../access/bootstrap/persistence.ts';
import type { BootstrapScope } from '../access/bootstrap/persistence.ts';
import { AccessCatalogModulesSchema } from '../access/catalog/module-schema.ts';
import { AccessChangesStoreLive } from '../access/changes/persistence/drizzle-store.ts';
import { AccessChangesStore } from '../access/changes/persistence/store.ts';
import { makeAccessProjectionCompiler, makeAccessProjectionTransport } from '../access/compiler/spice-db-compiler.ts';
import {
  AssignmentIncarnationIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../access/ids.ts';
import type { AccessScopeId, PrincipalId, RoleId, RoleRevisionId, TenantId } from '../access/ids.ts';
import {
  AccessCatalogSnapshotWriter,
  AccessCatalogSnapshotWriterLive,
} from '../access/intent/catalog-snapshot-writer.ts';
import {
  AccessMembershipIdSchema,
  AccessMembershipStore,
  AccessMembershipStoreLive,
} from '../access/intent/memberships.ts';
import { AccessPeopleStore, AccessPeopleStoreLive } from '../access/intent/people-store.ts';
import { AccessProjectionCompiler } from '../access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../access/intent/projection-writer.ts';
import type { AccessIntentDatabase } from '../access/intent/persistence.ts';
import { TenantIntentLoaderLive } from '../access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../access/lifecycle/persistence/journal-store.ts';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import { CoreDatabase, makeCoreDatabase } from '../db/client.ts';
import {
  DatabaseIdentityEnrollmentContext,
  defineDatabaseIdentityEnrollment,
  SHARED_RUNTIME_IDENTITY,
} from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identities.ts';
import { loadDatabaseConfig, parseDatabaseConfig } from '../db/config.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import { stageScopeOf } from '../install/stage-context-bootstrap.ts';
import type { OperationalScope } from '../operations/context.ts';
import { loadSpiceDbConfig, parseSpiceDbConfig } from '../permissions/config.ts';
import type { SpiceDbConfigValue } from '../permissions/config.ts';

const catalogUrl = new URL('../../../../topology/authorization-catalog.json', import.meta.url);

/** The database a Tenant's access intent is written in (an isolated clone or the shared one) and its SpiceDB. */
export interface TestTenantAccessTarget {
  readonly spiceDb: SpiceDbConfigValue;
  /** The shared runtime login Core writes the Tenant's access intent through, never an administrative one. */
  readonly writerConnectionString: Redacted.Redacted;
}

/** The persisted identity of a human Core already knows, as a live operation fixture carries it. */
export interface TestTenantAccessHuman {
  readonly authBindingId: string;
  readonly authContextRef: string;
  readonly authenticationNamespaceId: string;
  readonly authMethod: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** One principal of the Tenant and the capabilities its role holds, in every mode and the widest selector. */
export interface TestTenantAccessHolder {
  readonly capabilityKeys: readonly string[];
  readonly principalId: string;
}

export interface TestTenantOwnerAccessInput extends TestTenantAccessTarget {
  /** The companies of the Tenant; each gets its own scope, as production bootstrap gives it. */
  readonly legalEntityIds: readonly [string, ...string[]];
  /** Principals who join every scope and hold the owner's role in every company. */
  readonly memberPrincipalIds?: readonly string[];
  readonly owner: TestTenantAccessHuman;
}

export interface TestTenantRoleAccessInput extends TestTenantAccessTarget {
  /** Assign roles in every scope by default, or only in the companies while retaining every membership. */
  readonly assignmentScope?: 'all' | 'companies';
  readonly holders: readonly [TestTenantAccessHolder, ...TestTenantAccessHolder[]];
  /** The companies of the Tenant; each gets its own scope, as production bootstrap gives it. */
  readonly legalEntityIds: readonly [string, ...string[]];
  readonly tenantId: string;
}

/** The shared database and SpiceDB of the test environment, for a suite that runs against those. */
export const environmentTestAccessTarget = Effect.gen(function* environmentTestAccessTarget() {
  const [writer, spiceDb] = yield* Effect.all(
    [loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY }), loadSpiceDbConfig()],
    { concurrency: 2 },
  );
  return {
    spiceDb,
    writerConnectionString: Redacted.make(writer.connectionString),
  } satisfies TestTenantAccessTarget;
}).pipe(Effect.orDie);

/** The SpiceDB of a live operation fixture, from the environment it hands its children. */
export const liveFixtureSpiceDb = (environment: {
  readonly SPICEDB_CA_CERT?: string;
  readonly SPICEDB_ENDPOINT: string;
  readonly SPICEDB_PRESHARED_KEY: Redacted.Redacted;
  readonly ULTRAMODERN_DEPLOYMENT_ENVIRONMENT?: string;
}) =>
  parseSpiceDbConfig({ ...environment, SPICEDB_PRESHARED_KEY: Redacted.value(environment.SPICEDB_PRESHARED_KEY) }).pipe(
    Effect.orDie,
  );

/**
 * The scopes and Ready fences production bootstrap writes for a Tenant, and nothing else: what a suite with a
 * scripted gate needs to run a governed Action under the real access fence. Core retains them (D27), so the
 * Tenant stays too.
 */
export const writeTestTenantScopes = Effect.fn('TestTenantAccess.scopes')(function* writeTestTenantScopes(
  executor: CoreDatabaseExecutor,
  input: {
    readonly databaseIdentities?: DatabaseIdentityEnrollment;
    readonly legalEntityIds?: readonly string[];
    readonly principalId: string;
    readonly tenantId: string;
  },
) {
  const tenantId = TenantIdSchema.make(input.tenantId);
  const scope = yield* stageScopeOf({ principalId: input.principalId, tenantId });
  const legalEntityIds = (input.legalEntityIds ?? []).map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId));
  const enrollment = input.databaseIdentities ?? defineDatabaseIdentityEnrollment([]);
  yield* writeBootstrapScopes({ enrollment, executor }, scope, {
    scopes: bootstrapScopesOf(tenantId, legalEntityIds),
    tenantId,
  });
}, Effect.orDie);

/**
 * A module's deployment credential must be a service principal: the Shell admits a module-to-module call only
 * from one. A fixture binds the key through the self-bind Action, which admits only a human, so run this as the
 * admin role right after that bind.
 */
export const markServicePrincipal = (principal: { readonly principalId: string; readonly tenantId: string }) =>
  sql`update core.principals set kind = 'service'
    where tenant_id = ${principal.tenantId} and principal_id = ${principal.principalId} and kind = 'human'`;

const readCatalogModules = Effect.fn('TestTenantAccess.catalogModules')(function* readCatalogModules() {
  const [filesystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  const { modules } = yield* path.fromFileUrl(catalogUrl).pipe(
    Effect.flatMap((catalogPath) => filesystem.readFileString(catalogPath)),
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema }))),
    ),
  );
  return modules;
});

/**
 * The Core writers a Tenant's access intent is written through, over one database and SpiceDB: the bootstrap,
 * the release writer, the role and people stores, and the single projection writer that reconciles the result.
 * Built step by step into the caller's scope, each writer over exactly the services it declares.
 */
const accessInstallation = Effect.fn('TestTenantAccess.installation')(function* accessInstallation(
  target: TestTenantAccessTarget,
) {
  const databaseConfiguration = yield* parseDatabaseConfig({
    DATABASE_URL: Redacted.value(target.writerConnectionString),
  });
  const database = Context.make(CoreDatabase, yield* makeCoreDatabase(databaseConfiguration));
  const transport = yield* Effect.acquireRelease(
    Effect.sync(() => makeAccessProjectionTransport(target.spiceDb)),
    (opened) => Effect.sync(() => opened.close()),
  );
  const platform = Context.add(
    Context.add(database, AccessProjectionCompiler, makeAccessProjectionCompiler(transport)),
    DatabaseIdentityEnrollmentContext,
    defineDatabaseIdentityEnrollment([]),
  );
  const stores = Context.merge(
    platform,
    yield* Layer.build(
      Layer.mergeAll(
        TenantIntentLoaderLive,
        AccessWriteJournalStoreLive,
        AccessChangesStoreLive,
        AccessMembershipStoreLive,
        AccessPeopleStoreLive,
      ),
    ).pipe(Effect.provideContext(platform)),
  );
  const writers = Context.merge(
    stores,
    yield* Layer.build(Layer.mergeAll(AccessCatalogSnapshotWriterLive, AccessProjectionWriterLive)).pipe(
      Effect.provideContext(stores),
    ),
  );
  const bootstrap = yield* Layer.build(TenantAccessBootstrapLive).pipe(Effect.provideContext(writers));
  return {
    bootstrap: Context.get(bootstrap, TenantAccessBootstrap),
    catalog: Context.get(writers, AccessCatalogSnapshotWriter),
    changes: Context.get(writers, AccessChangesStore),
    database: {
      enrollment: Context.get(writers, DatabaseIdentityEnrollmentContext),
      executor: Context.get(writers, CoreDatabase).executor,
    } satisfies AccessIntentDatabase,
    memberships: Context.get(writers, AccessMembershipStore),
    people: Context.get(writers, AccessPeopleStore),
    writer: Context.get(writers, AccessProjectionWriter),
  };
});

/** The trusted request scope of a human: the identity Core already persisted for it. */
const humanScope = (human: TestTenantAccessHuman) =>
  Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId: human.authBindingId,
    authContextRef: human.authContextRef,
    authenticationNamespaceId: human.authenticationNamespaceId,
    authMethod: human.authMethod,
    principalId: human.principalId,
    tenantId: human.tenantId,
  }).pipe(Effect.map((context) => ({ ...context, correlationId: 'test-tenant-access' }) satisfies OperationalScope));

/** One membership of a holder in each scope, and an assignment of the role in each of the assigned scopes. */
const holderWrites = Effect.fn('TestTenantAccess.holderWrites')(function* holderWrites(input: {
  readonly assignedScopeIds: readonly AccessScopeId[];
  readonly at: Date;
  readonly principalId: PrincipalId;
  readonly recordedBy: PrincipalId;
  readonly roleId: RoleId;
  readonly roleRevisionId: RoleRevisionId;
  readonly scopeIds: readonly AccessScopeId[];
  readonly tenantId: TenantId;
}) {
  const crypto = yield* Crypto.Crypto;
  const holder = { _tag: 'Principal' as const, principalId: input.principalId };
  const membershipWrite = (scopeId: AccessScopeId) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((id) => ({
        _tag: 'RecordMembership' as const,
        membership: {
          createdAt: input.at,
          holder,
          id: AccessMembershipIdSchema.make(id),
          kind: 'member' as const,
          recordedBy: input.recordedBy,
          scopeId,
          status: 'active' as const,
          tenantId: input.tenantId,
          validFrom: input.at,
        },
      })),
    );
  const assignmentWrite = (scopeId: AccessScopeId) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((incarnationId) => ({
        _tag: 'RecordAssignment' as const,
        assignment: {
          assignedAt: input.at,
          assignedBy: input.recordedBy,
          holder,
          incarnationId: AssignmentIncarnationIdSchema.make(incarnationId),
          roleId: input.roleId,
          roleRevisionId: input.roleRevisionId,
          scopeId,
          status: 'active' as const,
          tenantId: input.tenantId,
          validFrom: input.at,
        },
      })),
    );
  const [memberships, assignments] = yield* Effect.all(
    [
      Effect.forEach(input.scopeIds, membershipWrite, { concurrency: 4 }),
      Effect.forEach(input.assignedScopeIds, assignmentWrite, { concurrency: 4 }),
    ],
    { concurrency: 2 },
  );
  return [...memberships, ...assignments];
});

const companyScopeIdsOf = (scopes: readonly BootstrapScope[]) =>
  scopes.flatMap((scope) =>
    Match.value(scope).pipe(
      Match.tag('LegalEntity', ({ scopeId }) => [scopeId]),
      Match.tag('TenantContext', () => []),
      Match.exhaustive,
    ),
  );

/**
 * The v2 access a production gate decides with, written by the real `bootstrapTenantAccess`: the owner holds
 * "Plný přístup" in the tenant context and every company. Each member then joins every scope and holds that same
 * role in every company, in one people change, followed by one reconcile through the single projection writer.
 *
 * Core retains access intent (D27), so the Tenant, its companies and these principals stay with it: a fixture
 * using this must not delete those rows on close.
 */
export const grantTestTenantOwnerAccess = Effect.fn('TestTenantAccess.owner')(
  function* grantTestTenantOwnerAccess(input: TestTenantOwnerAccessInput) {
    const [modules, installation, ownerScope] = yield* Effect.all(
      [readCatalogModules(), accessInstallation(input), humanScope(input.owner)],
      { concurrency: 3 },
    );
    const bootstrapped = yield* installation.bootstrap.bootstrapTenantAccess({
      legalEntityIds: input.legalEntityIds.map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId)),
      modules,
      scope: ownerScope,
    });
    const members = input.memberPrincipalIds ?? [];
    if (members.length === 0) {
      return bootstrapped.projection;
    }
    const at = DateTime.toDateUtc(yield* DateTime.now);
    const assignedScopeIds = companyScopeIdsOf(bootstrapped.scopes);
    const scopeIds = bootstrapped.scopes.map(({ scopeId }) => scopeId);
    const writes = yield* Effect.forEach(
      members,
      (principalId) =>
        holderWrites({
          assignedScopeIds,
          at,
          principalId: PrincipalIdSchema.make(principalId),
          recordedBy: bootstrapped.ownerPrincipalId,
          roleId: bootstrapped.roleId,
          roleRevisionId: bootstrapped.roleRevisionId,
          scopeIds,
          tenantId: bootstrapped.tenantId,
        }),
      { concurrency: 4 },
    );
    yield* installation.people.applyPeopleChange(ownerScope, { writes: writes.flat() });
    return yield* installation.writer.reconcileTenant({ scope: ownerScope });
  },
  Effect.scoped,
  Effect.orDie,
);

/**
 * The v2 access a production gate decides with, narrowed to named capabilities: each holder joins the tenant
 * context and every company, and holds a role of exactly its capabilities in all scopes by default, or only in
 * company scopes when requested, then one reconcile through the single Core writer. The scopes and fences are
 * written the way production bootstrap writes them. The release names every module of the checked-in catalog,
 * so whichever suite of a shared database
 * publishes it first, every Tenant pins the same complete release.
 *
 * Core retains access intent (D27), so the Tenant, its companies and these principals stay with it: a fixture
 * using this must not delete those rows on close.
 */
export const grantTestTenantRoleAccess = Effect.fn('TestTenantAccess.roles')(
  function* grantTestTenantRoleAccess(input: TestTenantRoleAccessInput) {
    const tenantId = TenantIdSchema.make(input.tenantId);
    const [first] = input.holders;
    const [modules, installation, firstScope] = yield* Effect.all(
      [readCatalogModules(), accessInstallation(input), stageScopeOf({ principalId: first.principalId, tenantId })],
      { concurrency: 3 },
    );
    const release = yield* installation.catalog.ensureInitialRelease({
      installedModuleKeys: modules.map(({ moduleId }) => moduleId),
      modules,
    });
    const { cells: releaseCells } = yield* Effect.fromResult(compileFullAccessRole(release));
    const scopes = bootstrapScopesOf(
      tenantId,
      input.legalEntityIds.map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId)),
    );
    const scopeIds = scopes.map(({ scopeId }) => scopeId);
    const assignedScopeIds = input.assignmentScope === 'companies' ? companyScopeIdsOf(scopes) : scopeIds;
    const at = DateTime.toDateUtc(yield* DateTime.now);
    const crypto = yield* Crypto.Crypto;
    yield* writeBootstrapScopes(installation.database, firstScope, { scopes, tenantId });
    // Each holder authors its own role and rows, so every row is attributed to the scope that wrote it.
    const grantHolder = Effect.fn('TestTenantAccess.holder')(function* grantHolder(holder: TestTenantAccessHolder) {
      const principalId = PrincipalIdSchema.make(holder.principalId);
      const [scope, roleUuid, roleRevisionUuid] = yield* Effect.all(
        [stageScopeOf({ principalId: holder.principalId, tenantId }), crypto.randomUUIDv4(), crypto.randomUUIDv4()],
        { concurrency: 3 },
      );
      const roleId = RoleIdSchema.make(roleUuid);
      const roleRevisionId = RoleRevisionIdSchema.make(roleRevisionUuid);
      const memberships = yield* installation.memberships.loadTenantMemberships(scope);
      // Adding a role preserves existing membership facts, including suspension or revocation.
      const existingMembershipScopes = new Set(
        memberships
          .filter(
            (membership) =>
              membership.kind === 'member' &&
              Match.value(membership.holder).pipe(
                Match.tag('Principal', (member) => member.principalId === principalId),
                Match.tag('Agent', () => false),
                Match.exhaustive,
              ),
          )
          .map(({ scopeId }) => scopeId),
      );
      const cells = releaseCells.filter((cell) => holder.capabilityKeys.includes(cell.capabilityKey));
      yield* installation.changes.recordRole({
        revision: {
          catalogSnapshotId: release.id,
          cells,
          createdAt: at,
          createdBy: principalId,
          id: roleRevisionId,
          provenance: 'manual',
          revision: 1,
          roleId,
          tenantId,
        },
        role: { createdAt: at, createdBy: principalId, id: roleId, name: `Test role ${roleId}`, tenantId },
        scope,
      });
      const writes = yield* holderWrites({
        assignedScopeIds,
        at,
        principalId,
        recordedBy: principalId,
        roleId,
        roleRevisionId,
        scopeIds: scopeIds.filter((scopeId) => !existingMembershipScopes.has(scopeId)),
        tenantId,
      });
      yield* installation.people.applyPeopleChange(scope, { writes });
    });
    yield* Effect.forEach(input.holders, grantHolder, { concurrency: 1, discard: true });
    return yield* installation.writer.reconcileTenant({ scope: firstScope });
  },
  Effect.scoped,
  Effect.orDie,
);

import { fileURLToPath } from 'node:url';

import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Console, Crypto, DateTime, Duration, Effect, Stream, FileSystem, Layer, Path, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { compileFullAccessRole } from '../../src/access/bootstrap/full-access-role.ts';
import { AccessCatalogModulesSchema } from '../../src/access/catalog/module-schema.ts';
import { buildDeploymentCatalogRelease } from '../../src/access/catalog/release.ts';
import { AccessChangesStoreLive, AccessReleaseStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessChangesStore } from '../../src/access/changes/persistence/store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import {
  CatalogSnapshotIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { PrincipalId, TenantId } from '../../src/access/ids.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import type { CatalogSnapshot } from '../../src/access/model.ts';
import { activateCatalogRelease } from '../../src/access/release/activation.ts';
import type { AccessCatalogModule } from '../../src/authorization/access-declaration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { coreRelations } from '../../src/db/schema.ts';
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
 * Release activation at stage scale (ADR-0030, Novinky): the deployed catalog of this repository, five tenants
 * bootstrapped on a 487-capability release (the size stage serves), one of them with five more roles, and the
 * real activation of the whole catalog with the real SpiceDB reconcile per tenant. It proves the plan numbers and
 * that the projection equals intent afterwards, and it bounds the wall time far inside the migrator's budget.
 */
const STAGE_INITIAL_CAPABILITIES = 487;
/** Far inside the migrator's five-minute activation budget (`scripts/run-zerops-migrator.mjs`). */
const WALL_TIME_CEILING_MILLIS = 60_000;
/** The companies each tenant starts with: stage has one tenant in six scopes, one in two and three in one. */
const COMPANIES_PER_TENANT = [5, 1, 0, 0, 0] as const;
const EXTRA_ROLES = 5;
/** Bootstrapping five tenants on a 487-capability release takes most of the scenario; the activation is bounded above. */
const SCENARIO_TIMEOUT_MILLIS = 300_000;

const EPOCH = DateTime.toDateUtc(DateTime.makeUnsafe('1970-01-01T00:00:00Z'));

/** The application directory and the activation script, as `run-zerops-migrator.mjs` starts it. */
const appDirectory = fileURLToPath(new URL('../../../../', import.meta.url));
const activationScript = fileURLToPath(
  new URL('../../../../scripts/activate-access-catalog-release.mts', import.meta.url),
);

const catalogUrl = new URL('../../../../topology/authorization-catalog.json', import.meta.url);

const deployedModules = Effect.gen(function* readDeployedCatalog() {
  const [filesystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  const { modules } = yield* path.fromFileUrl(catalogUrl).pipe(
    Effect.flatMap((catalogPath) => filesystem.readFileString(catalogPath)),
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema }))),
    ),
    Effect.orDie,
  );
  return modules;
});

const releaseOf = (modules: readonly AccessCatalogModule[]): CatalogSnapshot =>
  Result.getOrThrow(buildDeploymentCatalogRelease({ modules, publishedAt: EPOCH }));

/**
 * The older deployment, deterministically: whole descriptors leave the catalog from the last key backwards, each
 * only when it still fits, until exactly the stage's initial size is left. A descriptor leaves with its field
 * groups, so the older catalog stays closed.
 */
const olderDeploymentOf = (modules: readonly AccessCatalogModule[], keep: number): readonly AccessCatalogModule[] => {
  const descriptors = modules.flatMap((module) =>
    module.descriptors.map((descriptor, index) => {
      const keys = releaseOf([{ ...module, descriptors: [descriptor] }]).entries.map(({ key }) => key);
      return { id: `${module.moduleId}#${String(index)}`, key: keys.toSorted().at(-1) ?? '', size: keys.length };
    }),
  );
  let surplus = releaseOf(modules).entries.length - keep;
  const dropped = new Set<string>();
  for (const descriptor of descriptors.toSorted((left, right) => right.key.localeCompare(left.key))) {
    if (surplus > 0 && descriptor.size <= surplus) {
      dropped.add(descriptor.id);
      surplus -= descriptor.size;
    }
  }
  expect(surplus).toBe(0);
  return modules
    .map((module) => ({
      ...module,
      descriptors: module.descriptors.filter((_, index) => !dropped.has(`${module.moduleId}#${String(index)}`)),
    }))
    .filter(({ descriptors: kept }) => kept.length > 0);
};

const scopeFor = (tenantId: TenantId, principalId: PrincipalId) =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-000000000300',
    authContextRef: 'session:access-release-activation-scale:1',
    authMethod: 'session',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-release-scale' }) satisfies OperationalScope),
    Effect.orDie,
  );

interface StageTenant {
  readonly owner: PrincipalId;
  readonly scopes: number;
  readonly tenantId: TenantId;
}

/** One database and SpiceDB with the v2 schema: the composition the migrator's activation builds. */
const withDatabase = <Value, Failure, Requirements>(
  run: (admin: PgClient.PgClient, databaseUrl: string) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* scaleScenario() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `access_release_scale_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 2,
    });
    yield* createTemplateDatabase(admin);
    const databaseUrl = replacedDatabase(connections.runtime.connectionString, database);
    const runtime = yield* makeTestPgClient(databaseUrl, {
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
    const context = yield* Layer.build(Layer.mergeAll(base, TenantAccessBootstrapLive.pipe(Layer.provide(base))));
    return yield* run(admin, databaseUrl).pipe(Effect.provideContext(context));
  }).pipe(Effect.scoped);

/** One stage-shaped tenant on the older deployment: its companies, its installed modules and its bootstrap. */
const bootstrapStageTenant = Effect.fn('test.bootstrapStageTenant')(function* bootstrapStageTenantEffect(
  admin: PgClient.PgClient,
  older: readonly AccessCatalogModule[],
  companies: number,
) {
  const crypto = yield* Crypto.Crypto;
  const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
  const owner = PrincipalIdSchema.make(yield* crypto.randomUUIDv4());
  const legalEntityIds = yield* Effect.all(
    Array.from({ length: companies }, () => Effect.map(crypto.randomUUIDv4(), (id) => LegalEntityIdSchema.make(id))),
  );
  const moduleStates = yield* Effect.all(
    older.map(({ moduleId }) =>
      Effect.map(crypto.randomUUIDv4(), (id) => `('${id}', '${tenantId}', '${moduleId}', 'active')`),
    ),
  );
  const statements = [
    insertTenantStatement(tenantId),
    `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
       ('${tenantId}', '${owner}', 'human', 'Vlastník', 'active')`,
    `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values ${moduleStates.join(', ')}`,
    ...legalEntityIds.map(
      (legalEntityId, index) => `insert into core.legal_entities
         (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values
         ('${legalEntityId}', '${tenantId}', 'Firma ${String(index)} s.r.o.', 'CZ', '${String(10_000_000 + index)}', 'active')`,
    ),
  ];
  yield* Effect.forEach(statements, (statement) => admin.unsafe(statement).pipe(Effect.orDie), { discard: true });
  const bootstrap = yield* TenantAccessBootstrap;
  const bootstrapped = yield* bootstrap
    .bootstrapTenantAccess({ legalEntityIds, modules: older, scope: yield* scopeFor(tenantId, owner) })
    .pipe(Effect.orDie);
  return { bootstrapped, tenant: { owner, scopes: companies + 1, tenantId } satisfies StageTenant };
});

it.layer(NodeServices.layer, { excludeTestServices: true })(
  'access catalog release activation at stage scale',
  (suite) => {
    suite.effect(
      'publishes the deployed catalog to five stage-shaped tenants well inside the activation budget',
      () =>
        withDatabase((admin) =>
          Effect.gen(function* stageScale() {
            const full = yield* deployedModules;
            const older = olderDeploymentOf(full, STAGE_INITIAL_CAPABILITIES);
            const fullRelease = releaseOf(full);
            const olderRelease = releaseOf(older);
            expect(olderRelease.entries).toHaveLength(STAGE_INITIAL_CAPABILITIES);
            const added = fullRelease.entries.length - STAGE_INITIAL_CAPABILITIES;
            const fullCells = Result.getOrThrow(compileFullAccessRole(fullRelease)).cells.length;
            const olderCells = Result.getOrThrow(compileFullAccessRole(olderRelease)).cells.length;

            const tenants: StageTenant[] = [];
            for (const companies of COMPANIES_PER_TENANT) {
              const { bootstrapped, tenant } = yield* bootstrapStageTenant(admin, older, companies);
              expect(bootstrapped.cells).toHaveLength(olderCells);
              tenants.push(tenant);
            }
            // The first tenant also has five roles of its own, pinned to the older release: they get Novinky.
            const [first] = tenants;
            if (first === undefined) {
              return yield* Effect.die('no tenant');
            }
            const crypto = yield* Crypto.Crypto;
            const changes = yield* AccessChangesStore;
            const firstScope = yield* scopeFor(first.tenantId, first.owner);
            const firstState = yield* changes.loadTenantChanges(firstScope).pipe(Effect.orDie);
            const [preset] = firstState.roles;
            if (preset === undefined) {
              return yield* Effect.die('no preset');
            }
            for (let index = 0; index < EXTRA_ROLES; index += 1) {
              const roleId = RoleIdSchema.make(yield* crypto.randomUUIDv4());
              const now = yield* DateTime.nowAsDate;
              yield* changes
                .recordRole({
                  revision: {
                    catalogSnapshotId: CatalogSnapshotIdSchema.make(preset.revision.catalogSnapshotId),
                    cells: preset.revision.cells.slice(0, 40 * (index + 1)),
                    createdAt: now,
                    createdBy: first.owner,
                    id: RoleRevisionIdSchema.make(yield* crypto.randomUUIDv4()),
                    provenance: 'manual',
                    revision: 1,
                    roleId,
                    tenantId: first.tenantId,
                  },
                  role: {
                    createdAt: now,
                    createdBy: first.owner,
                    id: roleId,
                    name: `Role ${String(index)}`,
                    tenantId: first.tenantId,
                  },
                  scope: firstScope,
                })
                .pipe(Effect.orDie);
            }

            // The real clock: this suite excludes the test services, so the wall time is the activation's own.
            const [elapsed, report] = yield* activateCatalogRelease({ modules: full }).pipe(Effect.orDie, Effect.timed);
            const elapsedMillis = Duration.toMillis(elapsed);

            expect(report.ordering).toEqual({ _tag: 'Publish' });
            expect(report.entries).toBe(fullRelease.entries.length);
            expect(report.previousEntries).toBe(STAGE_INITIAL_CAPABILITIES);
            const byTenant = new Map(report.tenants.map((entry) => [entry.tenantId, entry] as const));
            for (const tenant of tenants) {
              expect(byTenant.get(tenant.tenantId)).toMatchObject({
                items: tenant === first ? added : 0,
                outcome: 'followed',
                presetCellsAdded: fullCells - olderCells,
                presetFound: true,
              });
            }
            // The projection equals intent afterwards: a second reconcile of every tenant has nothing to write.
            const writer = yield* AccessProjectionWriter;
            for (const tenant of tenants) {
              const again = yield* writer
                .reconcileTenant({ scope: yield* scopeFor(tenant.tenantId, tenant.owner) })
                .pipe(Effect.orDie);
              expect([again.touches, again.deletions]).toEqual([0, 0]);
            }
            expect(elapsedMillis).toBeLessThan(WALL_TIME_CEILING_MILLIS);
            yield* Console.log('[access-release-scale]', {
              addedCapabilities: added,
              addedCellsPerPreset: fullCells - olderCells,
              capabilities: fullRelease.entries.length,
              elapsedMillis,
              tenants: tenants.map((tenant) => {
                const entry = byTenant.get(tenant.tenantId);
                return {
                  deletions: entry?.relationshipDeletions,
                  elapsedMillis: entry?.elapsedMillis,
                  items: entry?.items,
                  scopes: tenant.scopes,
                  touches: entry?.relationshipTouches,
                };
              }),
            });
            return yield* Effect.void;
          }),
        ),
      SCENARIO_TIMEOUT_MILLIS,
    );

    suite.effect(
      'activates through the real script exactly as the migrator starts it: no argument, its environment',
      () =>
        withDatabase((admin, databaseUrl) =>
          Effect.gen(function* migratorPath() {
            const full = yield* deployedModules;
            const older = olderDeploymentOf(full, STAGE_INITIAL_CAPABILITIES);
            const fullRelease = releaseOf(full);
            const addedCells =
              Result.getOrThrow(compileFullAccessRole(fullRelease)).cells.length -
              Result.getOrThrow(compileFullAccessRole(releaseOf(older))).cells.length;
            const { tenant } = yield* bootstrapStageTenant(admin, older, 1);
            // `run-zerops-migrator.mjs`: this Node, the script, no argument, the application directory, and the
            // migrator's environment with this suite's private database as the runtime identity's address.
            const start = Effect.scoped(
              Effect.gen(function* startActivation() {
                const child = yield* ChildProcess.make(process.execPath, [activationScript], {
                  cwd: appDirectory,
                  env: { DATABASE_URL: databaseUrl },
                  extendEnv: true,
                  forceKillAfter: '1 second',
                  stderr: 'pipe',
                  stdin: 'ignore',
                  stdout: 'pipe',
                });
                const [code, stdout, stderr] = yield* Effect.all(
                  [
                    child.exitCode,
                    child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                    child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                  ],
                  { concurrency: 'unbounded' },
                );
                return { code: Number(code), output: `${stdout}${stderr}` };
              }),
            );
            const first = yield* start;
            expect(first.output).not.toContain('ACCESS CATALOG RELEASE ACTIVATION FAILED');
            expect(first.code).toBe(0);
            expect(first.output).toMatch(
              new RegExp(
                `deployed catalog [0-9a-f-]+: published; newest release [0-9a-f-]+: ${String(fullRelease.entries.length)} capabilities \\(previous release ${String(STAGE_INITIAL_CAPABILITIES)}\\)`,
                'u',
              ),
            );
            expect(first.output).toContain(
              `tenant ${tenant.tenantId}: followed; "Plný přístup" found, +${String(addedCells)} cells; Novinky 0;`,
            );
            // The next deployment of the same catalog, or a restart: current, and the tenant has nothing to take.
            const again = yield* start;
            expect(again.code).toBe(0);
            expect(again.output).toContain(': Current; newest release');
            expect(again.output).toContain(
              `tenant ${tenant.tenantId}: unchanged; "Plný přístup" found, +0 cells; Novinky 0;`,
            );
            return yield* Effect.void;
          }),
        ),
      SCENARIO_TIMEOUT_MILLIS,
    );
  },
);

import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Crypto, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { AccessEnforcementPortsLive } from '../../src/actions/runtime-wiring.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { AccessChangesStoreLive, AccessReleaseStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import type { LegalEntityId, TenantId } from '../../src/access/ids.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import { activateCatalogRelease, releaseActorId } from '../../src/access/release/activation.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { coreRelations } from '../../src/db/schema.ts';
import { installReleaseTenantModules } from '../../src/install/release-tenant-modules.ts';
import type { ReleaseTenantModule } from '../../src/install/release-tenant-modules.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import {
  createTemplateDatabase,
  insertTenantStatement,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { makeInstalledCatalogFixture } from '../support/installed-catalog.ts';

/*
 * Release-time module installation end to end: a selling Tenant bootstrapped with "Plný přístup" on a deployment that
 * declares a tax module it has not installed. The release step installs it as the platform (state and history as
 * `system`), projects the Tenant through the one Core writer, and the owner's rights in the module are effective as
 * soon as the step returns. A second release changes nothing; a state a person set is never touched.
 */
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const SELLING = 'billing.invoices';
const TAX = 'tax.rates';
const OTHER = 'crm.notes';
const TAX_READ = 'tax.rates.rule-set.read';

const entrypoint = (moduleKey: string, key: string) =>
  defineTenantModuleEntrypoint({
    access: 'read',
    authorization: { kind: 'protected' },
    entrypointKey: `${moduleKey}.api.${key}`,
    moduleKey,
    role: 'api',
  });
const readOf = (key: string): AccessDeclarationInput => ({
  key,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'records', level: 'basic' },
  risk: 'routine',
  selectors: [],
});
const moduleOf = (moduleKey: string, key: string): AccessCatalogModule => ({
  descriptors: [{ accessDeclaration: readOf(key), entrypoint: entrypoint(moduleKey, 'read') }],
  moduleId: moduleKey,
});
/** The deployment: the selling module, the tax module, and one module the composition does not publish below. */
const deployment: readonly AccessCatalogModule[] = [
  moduleOf(SELLING, `${SELLING}.invoice.read`),
  moduleOf(TAX, TAX_READ),
  moduleOf(OTHER, `${OTHER}.note.read`),
];
const taxCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(readOf(TAX_READ), entrypoint(TAX, 'read')) };
/** The active composition publishes the selling and the tax module, not `crm.notes`. */
const catalog = makeInstalledCatalogFixture(
  makeModuleContractFixture({ appId: 'billing', moduleId: SELLING }),
  makeModuleContractFixture({ appId: 'tax', moduleId: TAX }),
);

const owner = PrincipalIdSchema.make(uid(2));
const company = LegalEntityIdSchema.make(uid(4));

const seedTenant = (admin: PgClient.PgClient, tenantId: TenantId, sells: boolean) =>
  Effect.forEach(
    [
      insertTenantStatement(tenantId),
      `insert into core.legal_entities
         (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values
         ('${company}', '${tenantId}', 'Firma A s.r.o.', 'CZ', '11111111', 'active')`,
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${tenantId}', '${owner}', 'human', 'Vlastník', 'active')`,
      ...(sells
        ? [
            `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
               ('${uid(6)}', '${tenantId}', '${SELLING}', 'active')`,
          ]
        : []),
    ],
    (statement) => admin.unsafe(statement).pipe(Effect.orDie),
    { discard: true },
  );

const scopeFor = (tenantId: TenantId, legalEntityId?: LegalEntityId) => {
  const session = {
    authBindingId: uid(300),
    authContextRef: 'session:release-tenant-modules:1',
    authMethod: 'session' as const,
    principalId: owner,
    tenantId,
  };
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'release-tenant-modules' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

/** One Tenant on its own database and a SpiceDB with the v2 schema, bootstrapped by its owner. */
const withTenant = <Value, Failure, Requirements>(
  sells: boolean,
  run: (tenantId: TenantId, admin: PgClient.PgClient) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* tenantScenario() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `release_tenant_modules_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 2,
    });
    yield* createTemplateDatabase(admin);
    const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
    yield* seedTenant(admin, tenantId, sells);
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

/** The Tenant's owner bootstrapped with "Plný přístup" over the whole deployment, and projected. */
const bootstrapOwner = (tenantId: TenantId) =>
  Effect.gen(function* bootstrapTenantOwner() {
    const ownerScope = yield* scopeFor(tenantId);
    const bootstrap = yield* TenantAccessBootstrap;
    yield* bootstrap
      .bootstrapTenantAccess({ legalEntityIds: [company], modules: deployment, scope: ownerScope })
      .pipe(Effect.orDie);
    const writer = yield* AccessProjectionWriter;
    yield* writer.reconcileTenant({ scope: ownerScope }).pipe(Effect.orDie);
  });

const decide = (tenantId: TenantId) =>
  Effect.gen(function* decideTaxRead() {
    const gate = yield* AccessDecisionGate;
    const decision = yield* gate.decide({
      carrier: taxCarrier,
      legalEntityScope: 'required',
      now: DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z')),
      scope: yield* scopeFor(tenantId, company),
    });
    return `${decision.outcome} ${decision.reasons.map(({ code }) => code).join(',')}`;
  });

const declared = (tenantId: TenantId): readonly ReleaseTenantModule[] => [
  { moduleKey: TAX, sellingModuleKeys: [SELLING], tenantId },
  { moduleKey: OTHER, sellingModuleKeys: [], tenantId },
  { moduleKey: TAX, sellingModuleKeys: [], tenantId: uid(99) },
];

const install = (modules: readonly ReleaseTenantModule[]) =>
  installReleaseTenantModules({ catalog, modules, runReference: 'a'.repeat(64) });

const HistoryRowSchema = Schema.Struct({
  action_invocation_id: Schema.Null,
  change_source: Schema.String,
  changed_by_principal_id: Schema.Null,
  module_key: Schema.String,
  new_state: Schema.String,
  previous_state: Schema.Null,
});
const historyOf = (admin: PgClient.PgClient, tenantId: TenantId) =>
  admin
    .unsafe(
      `select module_key, previous_state, new_state, change_source, changed_by_principal_id, action_invocation_id
         from core.tenant_module_state_changes where tenant_id = '${tenantId}' order by occurred_at`,
    )
    .pipe(Effect.orDie, Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(HistoryRowSchema))), Effect.orDie);

it.layer(NodeServices.layer)('release-time Tenant module installation', (suite) => {
  suite.effect('installs a missing module as the platform, makes it effective at once, and repeats nothing', () =>
    withTenant(true, (tenantId, admin) =>
      Effect.gen(function* installsOnce() {
        yield* bootstrapOwner(tenantId);
        // Every deploy's migrator first activates the deployed catalog: "Plný přístup" follows it, tax rights included.
        const activation = yield* activateCatalogRelease({ modules: deployment }).pipe(Effect.orDie);
        expect(activation.tenants.find((entry) => entry.tenantId === tenantId)?.outcome).not.toBe('failed');
        const before = yield* decide(tenantId);

        const first = yield* install(declared(tenantId));
        expect(first.modules.map(({ moduleKey, outcome, tenantId: id }) => [id, moduleKey, outcome])).toEqual([
          [tenantId, TAX, 'installed'],
          [tenantId, OTHER, 'not_published'],
          [uid(99), TAX, 'tenant_absent'],
        ]);
        expect(first.reconciles).toHaveLength(1);
        expect(first.reconciles[0]).toMatchObject({ tenantId });
        expect(first.reconciles[0]).not.toHaveProperty('failure');
        // Recorded exactly as a module-state change, but by the platform: no person, no Action invocation.
        expect(yield* historyOf(admin, tenantId)).toEqual([
          {
            action_invocation_id: null,
            change_source: 'system',
            changed_by_principal_id: null,
            module_key: TAX,
            new_state: 'active',
            previous_state: null,
          },
        ]);
        const state = yield* admin
          .unsafe(
            `select s.state, (s.last_change_id = c.module_state_change_id) as linked
               from core.tenant_module_states s join core.tenant_module_state_changes c on c.tenant_id = s.tenant_id
              where s.tenant_id = '${tenantId}' and s.module_key = '${TAX}'`,
          )
          .pipe(Effect.orDie);
        expect(state).toEqual([{ linked: true, state: 'active' }]);
        // The preset already holds the tax cells, but they reach the engine only for an installed module: the owner's
        // right becomes effective the moment the step returns, with no Outbox worker in between.
        expect({ after: yield* decide(tenantId), before }).toEqual({
          after: 'ALLOWED allow.granted',
          before: 'DENIED deny.insufficient_grant',
        });
        // The release actor acted; it is still never an engine subject.
        const actor = yield* admin
          .unsafe(`select kind, status from core.principals where principal_id = '${releaseActorId(tenantId)}'`)
          .pipe(Effect.orDie);
        expect(actor).toEqual([{ kind: 'system', status: 'active' }]);

        // The next release finds it active: nothing installed, nothing reconciled, no new history.
        const second = yield* install(declared(tenantId));
        expect(second.modules[0]).toMatchObject({ moduleKey: TAX, outcome: 'already_active' });
        expect(second.reconciles).toEqual([]);
        expect(yield* historyOf(admin, tenantId)).toHaveLength(1);
      }),
    ),
  );

  suite.effect('never changes a state a person set, and installs nothing where the Tenant does not sell', () =>
    withTenant(false, (tenantId, admin) =>
      Effect.gen(function* additiveOnly() {
        yield* bootstrapOwner(tenantId);
        const notSelling = yield* install([{ moduleKey: TAX, sellingModuleKeys: [SELLING], tenantId }]);
        expect(notSelling.modules[0]).toMatchObject({ outcome: 'selling_module_missing' });
        expect(yield* historyOf(admin, tenantId)).toEqual([]);

        yield* admin
          .unsafe(
            `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
               ('${uid(7)}', '${tenantId}', '${TAX}', 'inactive')`,
          )
          .pipe(Effect.orDie);
        const left = yield* install([{ moduleKey: TAX, sellingModuleKeys: [], tenantId }]);
        expect(left.modules[0]).toMatchObject({ detail: expect.stringContaining('inactive'), outcome: 'left_as_set' });
        expect(left.reconciles).toEqual([]);
        const state = yield* admin
          .unsafe(
            `select state from core.tenant_module_states where tenant_id = '${tenantId}' and module_key = '${TAX}'`,
          )
          .pipe(Effect.orDie);
        expect(state).toEqual([{ state: 'inactive' }]);
        expect(yield* decide(tenantId)).toBe('DENIED deny.insufficient_grant');
      }),
    ),
  );
});

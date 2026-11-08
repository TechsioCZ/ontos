import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Context, Crypto, DateTime, Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { AccessEnforcementPortsLive } from '../../src/actions/runtime-wiring.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { legalEntityScopeId, tenantContextScopeId } from '../../src/access/bootstrap/persistence.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { TenantIntentLoader, TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import {
  AccessOperationIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { LegalEntityId, PrincipalId, TenantId } from '../../src/access/ids.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessCatalogModule, AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import type { AccessDecision } from '../../src/access/decision/contract.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  createTemplateDatabase,
  insertTenantStatement,
  replacedDatabase,
} from '../support/access-scenarios/database.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * The one Core writer, end to end (CUTOVER-PLAN §3.4-3.5, O67-Q6/Q7). A tenant is created from nothing but
 * its identity rows: this lane's bootstrap gives it scopes, memberships, the release catalog and the role
 * "Plný přístup", the single writer projects that intent into a real SpiceDB, and the real gate answers.
 * Every claim carries its negative control: a colleague without an assignment is denied, an uninstalled
 * module stops deciding, a narrowed role stops deciding where it used to, and a second reconcile writes
 * nothing.
 */
const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const MODULE = 'billing.invoices';
const ROUTINE = 'billing.invoices.invoice.read';
const CRITICAL = 'billing.invoices.invoice.void';
const SENSITIVE = 'billing.invoices.invoice.approve';

const routineEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: 'billing.invoices.api.list',
  moduleKey: MODULE,
  role: 'api',
});
const criticalEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'billing.invoices.action.void',
  moduleKey: MODULE,
  role: 'action',
});
const sensitiveEntrypoint = defineTenantModuleEntrypoint({
  access: 'write',
  authorization: { kind: 'protected' },
  entrypointKey: 'billing.invoices.action.approve',
  moduleKey: MODULE,
  role: 'action',
});

const routine: AccessDeclarationInput = {
  key: ROUTINE,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'invoices', level: 'basic' },
  risk: 'routine',
  selectors: [],
};
const critical: AccessDeclarationInput = {
  key: CRITICAL,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'invoices', level: 'manage' },
  risk: 'critical',
  selectors: [],
};
const sensitive: AccessDeclarationInput = {
  key: SENSITIVE,
  kind: 'action',
  modes: ['run', 'propose'],
  placement: { group: 'invoices', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
};

/** The composition a composition root hands to the bootstrap: its modules and their declarations. */
const modules: readonly AccessCatalogModule[] = [
  {
    descriptors: [
      { accessDeclaration: routine, entrypoint: routineEntrypoint },
      { accessDeclaration: critical, entrypoint: criticalEntrypoint },
      { accessDeclaration: sensitive, entrypoint: sensitiveEntrypoint },
    ],
    moduleId: MODULE,
  },
];

const routineCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(routine, routineEntrypoint) };
const criticalCarrier = { accessDeclaration: decodeAccessDeclarationOrThrow(critical, criticalEntrypoint) };

/** One cell per capability and declared mode, which is what "Plný přístup" grants over this release. */
const expectedCells = [ROUTINE, CRITICAL, CRITICAL, CRITICAL, SENSITIVE, SENSITIVE].toSorted();

const owner = PrincipalIdSchema.make(uid(2));
const colleague = PrincipalIdSchema.make(uid(3));
const company = LegalEntityIdSchema.make(uid(4));

/** The tenant as the product creates it: identity rows and one installed module, never any access. */
const seedTenant = (admin: PgClient.PgClient, tenantId: TenantId) =>
  Effect.gen(function* seedTenantEffect() {
    for (const statement of [
      insertTenantStatement(tenantId),
      `insert into core.legal_entities
         (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status)
         values ('${company}', '${tenantId}', 'Bootstrap s.r.o.', 'CZ', '12345678', 'active')`,
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values
         ('${tenantId}', '${owner}', 'human', 'Vlastník', 'active'),
         ('${tenantId}', '${colleague}', 'human', 'Kolega', 'active')`,
      `insert into core.tenant_module_states (tenant_module_state_id, tenant_id, module_key, state) values
         ('${uid(5)}', '${tenantId}', '${MODULE}', 'active')`,
    ]) {
      yield* admin.unsafe(statement).pipe(Effect.orDie);
    }
  });

/** One trusted request scope: the acting person, the tenant and, when given, the selected company (O66). */
const scopeFor = (tenantId: TenantId, principalId: PrincipalId, legalEntityId?: LegalEntityId) => {
  // A session names the binding it came from; a system context may not name a company at all.
  const session = {
    authBindingId: uid(300),
    authContextRef: 'session:access-bootstrap-projection:1',
    authMethod: 'session' as const,
    principalId,
    tenantId,
  };
  return Schema.decodeEffect(TrustedPrincipalContextSchema)(
    legalEntityId === undefined ? session : { ...session, legalEntityId },
  ).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-bootstrap-projection' }) satisfies OperationalScope),
    Effect.orDie,
  );
};

/** Everything one suite case reads and writes, over a database and an engine of its own. */
interface Tenant {
  readonly admin: PgClient.PgClient;
  readonly bootstrap: (typeof TenantAccessBootstrap)['Service'];
  readonly compiler: ReturnType<typeof makeAccessProjectionCompiler>;
  readonly executor: CoreDatabaseExecutor;
  readonly gate: (typeof AccessDecisionGate)['Service'];
  readonly loader: (typeof TenantIntentLoader)['Service'];
  readonly tenantId: TenantId;
  readonly writer: (typeof AccessProjectionWriter)['Service'];
}

/**
 * One tenant of this suite's own: a database with the whole committed schema applied, the identity rows of a
 * real tenant, and a SpiceDB carrying the v2 schema. The layers are built here and their services resolved,
 * so a case reads as the calls a composition root would make.
 */
const withTenant = <Value, Failure>(run: (tenant: Tenant) => Effect.Effect<Value, Failure>) =>
  Effect.gen(function* tenantScenario() {
    const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
    const crypto = yield* Crypto.Crypto;
    const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
    const bootstrapConnection = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
    const database = `access_bootstrap_projection_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
    yield* bootstrapConnection.unsafe(`create database "${database}"`).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() =>
      bootstrapConnection.unsafe(`drop database if exists "${database}" with (force)`).pipe(Effect.orDie),
    );
    const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, database), {
      maxConnections: 2,
    });
    yield* createTemplateDatabase(admin);
    // Every case gets a tenant of its own, so its projected objects are its own in the shared engine.
    const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
    yield* seedTenant(admin, tenantId);
    const runtime = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, database), {
      maxConnections: 2,
    });
    const executor = yield* makeTestDatabaseFromClient(runtime, coreRelations);
    // The suite owns the engine's schema, so it starts from exactly the v2 definitions Core serves.
    yield* Effect.acquireUseRelease(
      Effect.sync(() => newSpiceDbGrpcClient(configuration)),
      (client) =>
        Effect.tryPromise(() =>
          client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
        ).pipe(Effect.orDie),
      (client) => Effect.sync(() => client.close()),
    );
    const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
    const core = Layer.mergeAll(
      Layer.succeed(CoreDatabase, { executor }),
      Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
    );
    const engine = Layer.succeed(AccessProjectionCompiler, compiler);
    const platforms = Layer.mergeAll(core, engine, NodeServices.layer);
    const intent = TenantIntentLoaderLive.pipe(Layer.provide(platforms));
    const journal = AccessWriteJournalStoreLive.pipe(Layer.provide(platforms));
    const changes = AccessChangesStoreLive.pipe(Layer.provide(platforms));
    const stores = Layer.mergeAll(platforms, intent, journal, changes);
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
    return yield* run({
      admin,
      bootstrap: Context.get(context, TenantAccessBootstrap),
      compiler,
      executor,
      gate: Context.get(context, AccessDecisionGate),
      loader: Context.get(context, TenantIntentLoader),
      tenantId,
      writer: Context.get(context, AccessProjectionWriter),
    });
  }).pipe(Effect.scoped);

/** The instant the gate decides at: after every row the live write path records, so no test reads a clock. */
const decisionAt = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));

/** The gate's answer to one protected capability, asked the way an entrypoint asks it. */
const decide = (
  tenant: Tenant,
  input: {
    readonly carrier: typeof routineCarrier;
    readonly legalEntityScope: 'forbidden' | 'required';
    readonly scope: OperationalScope;
  },
): Effect.Effect<AccessDecision> =>
  Effect.map(
    tenant.gate.decide({
      carrier: input.carrier,
      legalEntityScope: input.legalEntityScope,
      now: decisionAt,
      scope: input.scope,
    }),
    (decision) => decision,
  );

/** The capabilities the release of this module declares, as a bootstrap result names them. */
const bootstrapped = (tenant: Tenant) =>
  Effect.flatMap(scopeFor(tenant.tenantId, owner), (scope) =>
    tenant.bootstrap.bootstrapTenantAccess({ legalEntityIds: [company], modules, scope }),
  ).pipe(
    // The refusal travels as text: a bootstrap failure is a phase plus the reason it recorded.
    Effect.mapError((cause) => new Error(`${cause.code}: ${cause.reason}`)),
    Effect.orDie,
  );

it.layer(NodeServices.layer)('access bootstrap and projection writer', (suite) => {
  suite.effect('gives a new tenant its owner, its release and its whole catalog, and the gate allows it', () =>
    withTenant((tenant) =>
      Effect.gen(function* bootstrapsTenant() {
        const result = yield* bootstrapped(tenant);
        // One cell per capability and declared mode: "Plný přístup" is the release, not a template subset.
        expect(result.cells.map((cell) => cell.capabilityKey).toSorted()).toEqual(expectedCells);
        expect(result.projection.touches).toBeGreaterThan(0);
        expect(result.projection.verified).toBe(true);
        expect(result.scopes.map(({ scopeId }) => scopeId)).toEqual([
          tenantContextScopeId(tenant.tenantId),
          legalEntityScopeId(tenant.tenantId, company),
        ]);

        const scope = yield* scopeFor(tenant.tenantId, owner);
        expect((yield* decide(tenant, { carrier: routineCarrier, legalEntityScope: 'forbidden', scope })).outcome).toBe(
          'ALLOWED',
        );
        // The same owner in the company he is a member of: a company-scoped capability decides there.
        const companyRequest = yield* scopeFor(tenant.tenantId, owner, company);
        expect(
          (yield* decide(tenant, {
            carrier: criticalCarrier,
            legalEntityScope: 'required',
            scope: companyRequest,
          })).outcome,
        ).toBe('ALLOWED');

        // A critical capability the owner holds through the same role, at `run`.
        expect(
          (yield* decide(tenant, { carrier: criticalCarrier, legalEntityScope: 'forbidden', scope })).outcome,
        ).toBe('ALLOWED');

        // A colleague of the same tenant, with membership and no assignment, holds nothing (guarantee 2).
        yield* tenant.admin
          .unsafe(`insert into core.access_memberships
            (membership_id, tenant_id, scope_id, principal_id, kind, status, valid_from, recorded_by)
            values ('${uid(20)}', '${tenant.tenantId}', '${tenantContextScopeId(tenant.tenantId)}', '${colleague}', 'member',
                    'active', '1970-01-01T00:00:00Z'::timestamptz, '${owner}')`)
          .pipe(Effect.orDie);
        const colleagueRequest = yield* scopeFor(tenant.tenantId, colleague);
        const denied = yield* decide(tenant, {
          carrier: routineCarrier,
          legalEntityScope: 'forbidden',
          scope: colleagueRequest,
        });
        expect(denied.outcome).toBe('DENIED');
        expect(denied.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');
      }),
    ),
  );
  suite.effect('stops deciding an uninstalled module and decides it again once it is reinstalled', () =>
    withTenant((tenant) =>
      Effect.gen(function* uninstallsModule() {
        yield* bootstrapped(tenant);
        const scope = yield* scopeFor(tenant.tenantId, owner);
        const ask = () => decide(tenant, { carrier: routineCarrier, legalEntityScope: 'forbidden', scope });
        expect((yield* ask()).outcome).toBe('ALLOWED');

        // A tenant that stops offering a module loses its capability in every scope (guarantee 8).
        yield* tenant.admin
          .unsafe(
            `update core.tenant_module_states set state = 'suspended', updated_at = now() where tenant_id = '${tenant.tenantId}'`,
          )
          .pipe(Effect.orDie);
        const removed = yield* tenant.writer.reconcileTenant({ scope });
        // Uninstalling removes relationships; it creates none.
        expect(removed.deletions).toBeGreaterThan(0);
        expect(removed.touches).toBe(0);
        expect(removed.verified).toBe(true);
        expect((yield* ask()).outcome).toBe('DENIED');

        // Reinstalling the module restores the capabilities the role still declares, and nothing revoked.
        yield* tenant.admin
          .unsafe(
            `update core.tenant_module_states set state = 'active', updated_at = now() where tenant_id = '${tenant.tenantId}'`,
          )
          .pipe(Effect.orDie);
        yield* tenant.writer.reconcileTenant({ scope });
        expect((yield* ask()).outcome).toBe('ALLOWED');
      }),
    ),
  );

  suite.effect('reconciles an unchanged tenant to nothing, and resumes a journal it already committed', () =>
    withTenant((tenant) =>
      Effect.gen(function* reconcilesIdempotently() {
        const first = yield* bootstrapped(tenant);
        expect(first.projection.resumed).toBe(false);
        expect(first.projection.touches).toBeGreaterThan(0);
        const scope = yield* scopeFor(tenant.tenantId, owner);
        const before = yield* tenant.compiler.readProjection([tenant.tenantId]);

        // The same intent plans the same graph, so the second reconcile writes nothing at all: no touch,
        // no deletion, and the journal records the intent it verified instead of an engine write.
        const repeated = yield* bootstrapped(tenant);
        expect(repeated.projection.touches).toBe(0);
        expect(repeated.projection.deletions).toBe(0);
        expect(repeated.projection.verified).toBe(true);
        expect(repeated.projection.projectionToken).toBe(`intent:${repeated.projection.digest}`);

        // A caller that names one operation twice continues its own journal instead of projecting again.
        const operationId = AccessOperationIdSchema.make(uid(90));
        const once = yield* tenant.writer.reconcileTenant({ operationId, scope });
        expect(once.resumed).toBe(false);
        expect(once.touches).toBe(0);
        const resumed = yield* tenant.writer.reconcileTenant({ operationId, scope });
        expect(resumed.resumed).toBe(true);
        expect(resumed.projectionToken).toBe(once.projectionToken);

        const after = yield* tenant.compiler.readProjection([tenant.tenantId]);
        expect(after.length).toBe(before.length);
      }),
    ),
  );

  suite.effect('stops deciding where a narrowed role no longer grants', () =>
    withTenant((tenant) =>
      Effect.gen(function* narrowsRole() {
        const bootstrappedTenant = yield* bootstrapped(tenant);
        const scope = yield* scopeFor(tenant.tenantId, owner);
        const askCritical = () => decide(tenant, { carrier: criticalCarrier, legalEntityScope: 'forbidden', scope });
        const askRoutine = () => decide(tenant, { carrier: routineCarrier, legalEntityScope: 'forbidden', scope });
        expect((yield* askCritical()).outcome).toBe('ALLOWED');

        // The role editor removes the critical capability: a new immutable revision, the live assignments
        // follow it, and the grant incarnations of the dropped cell retire (O51(1), O52).
        const narrowed = RoleRevisionIdSchema.make(uid(91));
        yield* tenant.admin
          .unsafe(`insert into core.access_role_revisions
              (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by,
               provenance, template_key)
              values ('${narrowed}', '${tenant.tenantId}', '${bootstrappedTenant.roleId}', 2, '${bootstrappedTenant.catalogSnapshotId}',
                      '[{"capabilityKey": "${ROUTINE}", "mode": "run", "selector": {"_tag": "all"}}]'::jsonb,
                      '${owner}', 'customer_changed', 'full_access')`)
          .pipe(Effect.orDie);
        yield* tenant.admin
          .unsafe(`update core.access_assignments set role_revision_id = '${narrowed}'
                   where tenant_id = '${tenant.tenantId}' and role_id = '${bootstrappedTenant.roleId}'`)
          .pipe(Effect.orDie);
        yield* tenant.admin
          .unsafe(`update core.access_grant_incarnations set status = 'retired'
                   where tenant_id = '${tenant.tenantId}' and capability_key = '${CRITICAL}'`)
          .pipe(Effect.orDie);

        yield* tenant.writer.reconcileTenant({ scope });
        expect((yield* askCritical()).outcome).toBe('DENIED');
        // The capability the role still declares is untouched: narrowing one cell narrows only that cell.
        expect((yield* askRoutine()).outcome).toBe('ALLOWED');
      }),
    ),
  );
});
